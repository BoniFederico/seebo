/**
 * @file Test harness: utilities to build engines and run the Seebo pipeline.
 *
 * Two engines are offered:
 *  - {@link realEngine}: the actual `createEngine` from src. In v1 its methods are
 *    placeholders that throw `NotImplementedError`, so conformance cases that use it are
 *    marked `{ todo: true }` until the language is implemented.
 *  - {@link createFakeEngine}: a tiny DETERMINISTIC fake pipeline that returns known
 *    output. It is NOT the Seebo engine and does not implement Seebo semantics — it only
 *    powers the minimal end-to-end smoke so the harness is provably working.
 */

import { createEngine } from '../../src/index.js';
import { Status } from '../../src/run/run.js';
import { STATE_VERSION } from '../../src/util/versions.js';

/**
 * Builds the real engine with optional config overrides.
 * @param {import('../../src/index.js').EngineConfig} [overrides]
 * @returns {ReturnType<typeof createEngine>}
 */
export function realEngine(overrides = {}) {
  return createEngine(overrides);
}

/**
 * Matches a trivial `${ name }` slot whose body is a bare identifier. Intentionally far
 * simpler than the real lexer (no operators, methods, nesting): it exists only to give the
 * fake pipeline something deterministic to do.
 */
const FAKE_SLOT = /\$\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}/g;

/**
 * Collects the distinct identifiers referenced by `${ id }` slots in a template.
 * @param {string} template
 * @returns {string[]}
 */
function fakeSlotIds(template) {
  const ids = new Set();
  for (const m of template.matchAll(FAKE_SLOT)) ids.add(m[1]);
  return [...ids];
}

/**
 * Creates a FAKE deterministic engine implementing just enough of the `start`/`run`/
 * `stebo` shape (SPEC §2.4/§2.5) to exercise the conversation state machine end-to-end.
 *
 * Semantics (fake, not normative):
 *  - a `${ id }` slot is replaced by `String(resolved[id])`;
 *  - an unresolved `id` becomes a minimal pending requirement and the state is `waiting`;
 *  - with every `id` resolved, the state is `completed` and `output` is the substituted text.
 *
 * @returns {{
 *   start: (template: string, values?: Record<string, unknown>) => import('../../src/run/run.js').PublicState,
 *   run: (state: import('../../src/run/run.js').PublicState) => import('../../src/run/run.js').PublicState,
 *   stebo: (args: { template: string, values?: Record<string, unknown> }) => Promise<import('../../src/run/run.js').PublicState>,
 * }}
 */
export function createFakeEngine() {
  /**
   * @param {string} template
   * @param {Record<string, unknown>} [values]
   * @returns {import('../../src/run/run.js').PublicState}
   */
  function start(template, values = {}) {
    return {
      stateVersion: STATE_VERSION,
      template,
      resolved: { ...castValues(values) },
      pending: [],
      phase: 0,
      status: Status.RUNNING,
    };
  }

  /**
   * @param {import('../../src/run/run.js').PublicState} state
   * @returns {import('../../src/run/run.js').PublicState}
   */
  function run(state) {
    const missing = fakeSlotIds(state.template).filter((id) => !(id in state.resolved));
    const phase = state.phase + 1;
    if (missing.length > 0) {
      return {
        ...state,
        phase,
        status: Status.WAITING,
        pending: missing.map((id) => ({
          id,
          type: { type: 'string' },
          capability: 'user',
        })),
      };
    }
    const output = state.template.replace(FAKE_SLOT, (_all, id) =>
      String(/** @type {Record<string, { value: unknown }>} */ (state.resolved)[id].value)
    );
    return { ...state, phase, status: Status.COMPLETED, pending: [], output };
  }

  /**
   * @param {{ template: string, values?: Record<string, unknown> }} args
   * @returns {Promise<import('../../src/run/run.js').PublicState>}
   */
  async function stebo(args) {
    let state = start(args.template, args.values);
    state = run(state);
    return state;
  }

  return { start, run, stebo };
}

/**
 * Wraps plain JS values into the minimal `{ value }` shape the fake engine reads, so the
 * fake's `resolved` map mimics the real `Record<string, Value>` (IMPL §4) closely enough.
 * @param {Record<string, unknown>} values
 * @returns {Record<string, { value: unknown }>}
 */
function castValues(values) {
  /** @type {Record<string, { value: unknown }>} */
  const out = {};
  for (const [k, v] of Object.entries(values)) out[k] = { value: v };
  return out;
}
