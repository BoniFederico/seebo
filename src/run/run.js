/**
 * @file Pure state machine (IMPL §6): `start` and `run`. `run(state) → state` is
 * `(State) → State`: synchronous, pure, NO I/O (IMPL §6.2). v1 uses strategy 1 — full
 * re-evaluation at every `run` (IMPL §6.4).
 *
 * v1 SLICE: `run` parses the template, walks the document nodes, evaluates each formula
 * with the slice evaluator and concatenates the emitted text. Comments are removed at
 * emission (SPEC §1.2). Parse errors and evaluation errors produce `status: 'failed'`
 * with diagnostics. Requirements/Needs are not part of the slice, so `waiting` does not
 * occur yet.
 */

import { STATE_VERSION } from '../util/versions.js';
import { SeeboError, DiagnosticCode, createDiagnostic } from '../util/errors.js';
import { parse } from '../parser/index.js';
import { evaluate, renderValue } from '../eval/evaluator.js';

export { STATE_VERSION };

/**
 * Conversation states (SPEC §1.9 / §2.4).
 * @type {Readonly<Record<string, StatusValue>>}
 */
export const Status = Object.freeze({
  RUNNING: 'running',
  WAITING: 'waiting',
  COMPLETED: 'completed',
  FAILED: 'failed',
});

/** @typedef {'running'|'waiting'|'completed'|'failed'} StatusValue */

/**
 * Serializable public state (SPEC §2.4 / IMPL §6.1). The ONLY form to persist.
 * @typedef {Object} PublicState
 * @property {number} stateVersion
 * @property {string} template
 * @property {Record<string, import('../runtime/values.js').Value>} resolved
 * @property {import('../eval/evaluator.js').RequirementDescriptor[]} pending
 * @property {number} phase
 * @property {StatusValue} status
 * @property {string} [output]
 * @property {import('../util/errors.js').Diagnostic[]} [diagnostics]
 */

/**
 * Internal, NON-serialized runtime state (IMPL §6.1). Not used by the slice's full
 * re-evaluation strategy beyond holding the freshly parsed AST.
 * @typedef {Object} RuntimeState
 * @property {PublicState} pub
 * @property {import('../ast/nodes.js').Document} ast
 */

/**
 * Creates the initial state (SPEC §2.4), `status: 'running'`.
 *
 * NOTE (slice): `initialValues` are kept verbatim under `resolved` for forward
 * compatibility, but the slice has no references/requirements that read them.
 *
 * @param {string} template
 * @param {Record<string, unknown>} [initialValues]
 * @param {import('../index.js').EngineConfig} [_config]
 * @returns {PublicState}
 */
export function start(template, initialValues, _config) {
  return {
    stateVersion: STATE_VERSION,
    template,
    resolved: /** @type {Record<string, any>} */ ({ ...(initialValues ?? {}) }),
    pending: [],
    phase: 0,
    status: Status.RUNNING,
  };
}

/**
 * Runs one step of the state machine (IMPL §6.2). Pure and synchronous.
 *
 * @param {PublicState} state
 * @param {import('../index.js').EngineConfig} [config]
 * @returns {PublicState}
 */
export function run(state, config) {
  const phase = state.phase + 1;

  let doc;
  try {
    doc = parse(state.template, config);
  } catch (e) {
    return fail(state, phase, toDiagnostic(e, 'parse'));
  }

  let output = '';
  /** @type {import('../eval/evaluator.js').RequirementDescriptor[]} */
  const pending = [];

  for (const node of doc.nodes) {
    if (node.kind === 'Text') {
      output += node.value;
    } else if (node.kind === 'Comment') {
      // removed at emission (SPEC §1.2)
    } else if (node.kind === 'Formula') {
      const res = evaluate(node.expr, { resolved: state.resolved }, config);
      if (res.kind === 'Ok') {
        output += renderValue(res.value, config?.locale);
      } else if (res.kind === 'Susp') {
        pending.push(res.need);
      } else {
        return fail(state, phase, res.diagnostic);
      }
    } else {
      // Macro nodes are rejected by the slice parser; guard defensively.
      return fail(
        state,
        phase,
        createDiagnostic(DiagnosticCode.SYNTAX_ERROR, {
          phase: 'run',
          recoverable: false,
          message: `unsupported node '${node.kind}' in v1 slice`,
          position: node.position,
        })
      );
    }
  }

  if (pending.length > 0) {
    return { ...state, phase, status: Status.WAITING, pending, output: undefined };
  }
  return { ...state, phase, status: Status.COMPLETED, pending: [], output };
}

/**
 * @param {PublicState} state
 * @param {number} phase
 * @param {import('../util/errors.js').Diagnostic} diagnostic
 * @returns {PublicState}
 */
function fail(state, phase, diagnostic) {
  return { ...state, phase, status: Status.FAILED, pending: [], diagnostics: [diagnostic] };
}

/**
 * Converts a thrown error into a diagnostic (IMPL Appendix A).
 * @param {unknown} e
 * @param {import('../util/errors.js').Phase} phase
 * @returns {import('../util/errors.js').Diagnostic}
 */
function toDiagnostic(e, phase) {
  if (e instanceof SeeboError) {
    return createDiagnostic(e.code ?? DiagnosticCode.SYNTAX_ERROR, {
      severity: 'error',
      phase,
      recoverable: false,
      message: e.message,
      position: e.position,
    });
  }
  return createDiagnostic(DiagnosticCode.SYNTAX_ERROR, {
    severity: 'error',
    phase,
    recoverable: false,
    message: e instanceof Error ? e.message : String(e),
  });
}
