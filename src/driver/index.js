/**
 * @file Async driver (IMPL §7): the **only** async component. Satisfies the `Need`s by
 * querying the registered capabilities, with the 4 normative outcomes
 * (Resolved/Unresolved/ProviderError/InvalidValue). `stebo` is the orchestrator
 * expand → drive → finalize. v1 placeholder.
 */

import { NotImplementedError } from '../util/errors.js';

/**
 * Normative outcomes of resolving a Need through a provider (IMPL §7.1).
 * @type {Readonly<Record<string, string>>}
 */
export const ProviderOutcome = Object.freeze({
  RESOLVED: 'Resolved',
  UNRESOLVED: 'Unresolved',
  PROVIDER_ERROR: 'ProviderError',
  INVALID_VALUE: 'InvalidValue',
});

/**
 * Closes the run/driver loop by satisfying Needs via capabilities. Stops on the Needs of
 * the capabilities listed in `stopOn`, returning them to the caller (IMPL §7.3).
 *
 * @param {import('../run/index.js').PublicState | string} _stateOrTemplate
 * @param {{ stopOn?: string[] }} [_opts]
 * @param {import('../index.js').EngineConfig} [_config]
 * @returns {Promise<import('../run/index.js').PublicState>}
 */
export async function drive(_stateOrTemplate, _opts, _config) {
  throw new NotImplementedError('driver.drive');
}

/**
 * Convenience orchestrator: `expand` → `drive` → `finalize`, managing the conversation
 * (SPEC §2.5). `values` pre-populates `resolved` (clarifications §10).
 *
 * @param {{ template: string, templates?: Record<string, string>, values?: Record<string, unknown>, stopOn?: string[] }} _args
 * @param {import('../index.js').EngineConfig} [_config]
 * @returns {Promise<import('../run/index.js').PublicState>}
 */
export async function stebo(_args, _config) {
  throw new NotImplementedError('driver.stebo');
}
