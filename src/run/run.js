/**
 * @file Pure state machine (IMPL §6): `start` and `run`. `run(state) → state` is
 * `(State) → State`: synchronous, pure, NO I/O (IMPL §6.2). v1 uses strategy 1 — full
 * re-evaluation at every `run` (IMPL §6.4).
 *
 * `run` parses the template and evaluates the document with the suspendable evaluator
 * ({@link ../eval/evaluator.js}). Comments are removed at emission (SPEC §1.2). Unmet
 * requirements surface as `pending` Needs (`status: 'waiting'`); parse/eval errors produce
 * `status: 'failed'`; otherwise `status: 'completed'` with `output`.
 */

import { STATE_VERSION } from '../util/versions.js';
import { SeeboError, DiagnosticCode, createDiagnostic } from '../util/errors.js';
import { fromJs } from '../runtime/values.js';
import { parse } from '../parser/index.js';
import { evaluateDocument } from '../eval/evaluator.js';

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
 * Serializable public state (SPEC §2.4 / IMPL §6.1). The ONLY form the host should
 * persist or transmit between turns. Produced by {@link start}; transformed (never mutated)
 * by {@link run}.
 * @typedef {Object} PublicState
 * @property {number} stateVersion  Schema version; see {@link STATE_VERSION}.
 * @property {string} template  Original template source as passed to {@link start}.
 * @property {Record<string, import('../runtime/values.js').Value>} resolved  Values provided for pending requirements, keyed by requirement id.
 * @property {import('../eval/evaluator.js').RequirementDescriptor[]} pending  Requirements not yet satisfied in the current phase.
 * @property {number} phase  Monotonically increasing step counter; starts at `0`, incremented by each {@link run} call.
 * @property {StatusValue} status  Current execution status; see {@link Status}.
 * @property {string} [output]  Rendered text; present only when `status === 'completed'`.
 * @property {import('../util/errors.js').Diagnostic[]} [diagnostics]  Diagnostics collected during the last step; present only when `status === 'failed'`.
 */

/**
 * Internal runtime state (IMPL §6.1). NOT serialized; discarded after each {@link run} step.
 * Holds the freshly parsed AST so v1's full re-evaluation strategy avoids re-parsing inline.
 * @typedef {Object} RuntimeState
 * @property {PublicState} pub  The corresponding public state snapshot.
 * @property {import('../ast/nodes.js').Document} ast  Parsed AST for the current template.
 */

/**
 * Creates the initial state (SPEC §2.4), `status: 'running'`. Raw `initialValues` are
 * wrapped into typed values via {@link fromJs} (clarifications §7/§10) so they can be read
 * by references and requirements; values that are already typed are kept as-is.
 *
 * @param {string} template
 * @param {Record<string, unknown>} [initialValues]
 * @param {import('../index.js').EngineConfig} [_config]
 * @returns {PublicState}
 */
export function start(template, initialValues, _config) {
  /** @type {Record<string, import('../runtime/values.js').Value>} */
  const resolved = {};
  for (const [id, raw] of Object.entries(initialValues ?? {})) {
    if (raw === undefined) continue;
    resolved[id] = fromJs(raw);
  }
  return {
    stateVersion: STATE_VERSION,
    template,
    resolved,
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

  const r = evaluateDocument(doc, state.resolved, config);
  if (r.status === 'failed') {
    return { ...state, phase, status: Status.FAILED, pending: [], diagnostics: r.diagnostics };
  }
  if (r.status === 'waiting') {
    return { ...state, phase, status: Status.WAITING, pending: r.pending, output: undefined };
  }
  return { ...state, phase, status: Status.COMPLETED, pending: [], output: r.output };
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
