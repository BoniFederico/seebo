/**
 * @file Public contract for the pure state machine (IMPL §6). Source of truth for the
 * conversation `Status`, the serializable `PublicState`, the internal `RuntimeState`,
 * and the `start`/`run` signatures.
 *
 * `run(state) → state` is `(State) → State`: synchronous, pure, NO I/O (IMPL §6.2).
 * v1 uses strategy 1 — full re-evaluation at every `run` (IMPL §6.4). The async loop that
 * satisfies Needs lives in the driver ({@link ../driver/async_driver.js}).
 */

import { STATE_VERSION } from '../util/versions.js';
import { NotImplementedError } from '../util/errors.js';

export { STATE_VERSION };

/**
 * Conversation states (SPEC §1.9 / §2.4).
 * @type {Readonly<Record<string, string>>}
 */
export const Status = Object.freeze({
  RUNNING: 'running',
  WAITING: 'waiting',
  COMPLETED: 'completed',
  FAILED: 'failed',
});

/**
 * One of the {@link Status} values.
 * @typedef {'running'|'waiting'|'completed'|'failed'} StatusValue
 */

/**
 * Serializable public state (SPEC §2.4 / IMPL §6.1). The ONLY form to persist; a POJO
 * (JSON/MessagePack) carrying the template SOURCE for portability.
 *
 * @typedef {Object} PublicState
 * @property {number} stateVersion
 * @property {string} template  Template source (canonical, portable form).
 * @property {Record<string, import('../runtime/values.js').Value>} resolved Satisfied requirements, by id.
 * @property {import('../eval/evaluator.js').RequirementDescriptor[]} pending Needs from the last pass.
 * @property {number} phase
 * @property {StatusValue} status
 * @property {string} [output]  Present when status === 'completed'.
 * @property {import('../util/errors.js').Diagnostic[]} [diagnostics]
 */

/**
 * Internal, NON-serialized runtime state (IMPL §6.1). Built from a `PublicState` for a
 * single `run` call and discarded afterwards. `astRef`/`ast` are pure cache, rebuildable
 * in O(parse) from `template`.
 *
 * @typedef {Object} RuntimeState
 * @property {PublicState} pub
 * @property {string} astRef  Cache key for the memoized AST (hash of `template`).
 * @property {import('../ast/nodes.js').Document} ast Resolved AST (from cache or re-parse).
 */

/**
 * Creates the initial state from the template (and any already-known values), with
 * `status: 'running'` (SPEC §2.4). v1 placeholder.
 *
 * @param {string} _template
 * @param {Record<string, unknown>} [_initialValues] Pre-populate `resolved` (clarifications §10).
 * @param {import('../index.js').EngineConfig} [_config]
 * @returns {PublicState}
 */
export function start(_template, _initialValues, _config) {
  throw new NotImplementedError('run.start');
}

/**
 * Runs one step of the state machine: hydrates a RuntimeState, evaluates the document as
 * far as possible, collects the active Needs, and returns the next PublicState. Pure and
 * synchronous (IMPL §6.2). v1 placeholder.
 *
 * @param {PublicState} _state
 * @param {import('../index.js').EngineConfig} [_config]
 * @returns {PublicState}
 */
export function run(_state, _config) {
  throw new NotImplementedError('run.run');
}
