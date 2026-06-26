/**
 * @file Public contract for the async driver (IMPL §7) — the ONLY async component.
 * It satisfies the `Need`s emitted by `run` by querying the registered capabilities,
 * then re-runs the pure state machine. Source of truth for the provider outcomes and the
 * `drive`/`stebo` signatures.
 *
 * The core (`run`) never does I/O; the driver isolates all latency/non-determinism
 * (IMPL §1). Scheduling: the driver may batch capability lookups in a single pass
 * (resolution bundle, IMPL §7.2), since `analyze` knows statically which capabilities are
 * needed. Within one conversation each requirement id is resolved once and reused.
 */

import { NotImplementedError } from '../util/errors.js';

/**
 * Normative outcomes of resolving a Need through a capability provider (IMPL §7.1):
 *  - `Resolved`     — provider returned a valid, non-undefined value → enters `resolved`.
 *  - `Unresolved`   — provider returned `undefined` → Need stays in `pending` (e.g. `user`).
 *  - `ProviderError`— provider threw / rejected / timed out → per policy (fail in v1).
 *  - `InvalidValue` — returned value violates the requirement type/constraints.
 * @type {Readonly<Record<string, string>>}
 */
export const ProviderOutcome = Object.freeze({
  RESOLVED: 'Resolved',
  UNRESOLVED: 'Unresolved',
  PROVIDER_ERROR: 'ProviderError',
  INVALID_VALUE: 'InvalidValue',
});

/**
 * A capability provider: given a requirement descriptor, returns its value (sync or via
 * Promise), or `undefined` to mean "not me" (SPEC §2.2, IMPL §7.1).
 * @typedef {(req: import('../eval/evaluator.js').RequirementDescriptor) => unknown | Promise<unknown>} CapabilityProvider
 */

/**
 * Options for {@link drive}.
 * @typedef {Object} DriveOptions
 * @property {string[]} [stopOn] Capability names whose Needs are returned to the caller
 *   instead of being auto-resolved (e.g. `['user']`), IMPL §7.3.
 */

/**
 * Arguments for {@link stebo}.
 * @typedef {Object} SteboArgs
 * @property {string} template
 * @property {Record<string, string>} [templates] Templates for the EXPAND pre-pass.
 * @property {Record<string, unknown>} [values] Initial values pre-populating `resolved` (clarifications §10).
 * @property {string[]} [stopOn] Forwarded to {@link drive}.
 */

/**
 * Closes the run/driver loop by satisfying Needs via capabilities, stopping on the Needs
 * of the capabilities listed in `stopOn` and returning them to the caller (IMPL §7.3).
 * Async. v1 placeholder.
 *
 * @param {import('../run/run.js').PublicState | string} _stateOrTemplate
 * @param {DriveOptions} [_opts]
 * @param {import('../index.js').EngineConfig} [_config]
 * @returns {Promise<import('../run/run.js').PublicState>}
 */
export async function drive(_stateOrTemplate, _opts, _config) {
  throw new NotImplementedError('driver.drive');
}

/**
 * Convenience orchestrator: `expand` → `drive` → `finalize`, managing the conversation
 * (SPEC §2.5). `values` pre-populate `resolved` so already-provided `user` Needs do not
 * reappear (clarifications §10). Async. v1 placeholder.
 *
 * @param {SteboArgs} _args
 * @param {import('../index.js').EngineConfig} [_config]
 * @returns {Promise<import('../run/run.js').PublicState>}
 */
export async function stebo(_args, _config) {
  throw new NotImplementedError('driver.stebo');
}
