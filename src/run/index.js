/**
 * @file Pure state machine (IMPL §6): `start` and `run`. `run(state) → state` is
 * `(State) → State`, synchronous and without I/O. v1 uses strategy 1 (full
 * re-evaluation). v1 placeholder.
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
 * Serializable public state (SPEC §2.4 / IMPL §6.1). The only form to persist.
 * @typedef {Object} PublicState
 * @property {number} stateVersion
 * @property {string} template  The template SOURCE (canonical, portable form).
 * @property {Record<string, import('../runtime/index.js').Value>} resolved
 * @property {import('../eval/index.js').RequirementDescriptor[]} pending
 * @property {number} phase
 * @property {'running'|'waiting'|'completed'|'failed'} status
 * @property {string} [output]
 * @property {import('../util/errors.js').Diagnostic[]} [diagnostics]
 */

/**
 * Creates the initial state from the template (and any already-known values).
 * `status: 'running'` (SPEC §2.4). v1 placeholder.
 *
 * @param {string} _template
 * @param {Record<string, unknown>} [_initialValues]
 * @param {import('../index.js').EngineConfig} [_config]
 * @returns {PublicState}
 */
export function start(_template, _initialValues, _config) {
  throw new NotImplementedError('run.start');
}

/**
 * Runs one step of the state machine: evaluates as much as possible and collects the
 * `Need`s. Pure and synchronous (IMPL §6.2). v1 placeholder.
 *
 * @param {PublicState} _state
 * @param {import('../index.js').EngineConfig} [_config]
 * @returns {PublicState}
 */
export function run(_state, _config) {
  throw new NotImplementedError('run.run');
}
