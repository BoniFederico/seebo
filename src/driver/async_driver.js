/**
 * @file Async driver (IMPL §7) — the only async component. It satisfies the `Need`s
 * emitted by `run` via capabilities, then re-runs the pure state machine. `stebo` is the
 * convenience orchestrator expand → drive → finalize (SPEC §2.5).
 *
 * v1 SLICE: the slice templates have no requirements, so no capability is queried; the
 * driver simply runs the pure machine to completion. The capability-resolution loop and
 * the four `ProviderOutcome`s land in a later milestone. `expand`/`finalize` are the
 * pass-through pre/post passes for now.
 */

import { start, run } from '../run/run.js';
import { expand } from '../macros/expand.js';
import { finalize } from '../macros/finalize.js';

/**
 * Normative provider outcomes (IMPL §7.1) — contract surface kept for forward use.
 * @type {Readonly<Record<string, string>>}
 */
export const ProviderOutcome = Object.freeze({
  RESOLVED: 'Resolved',
  UNRESOLVED: 'Unresolved',
  PROVIDER_ERROR: 'ProviderError',
  INVALID_VALUE: 'InvalidValue',
});

/**
 * @typedef {(req: import('../eval/evaluator.js').RequirementDescriptor) => unknown | Promise<unknown>} CapabilityProvider
 */
/**
 * @typedef {Object} DriveOptions
 * @property {string[]} [stopOn]
 */
/**
 * @typedef {Object} SteboArgs
 * @property {string} template
 * @property {Record<string, string>} [templates]
 * @property {Record<string, unknown>} [values]
 * @property {string[]} [stopOn]
 */

/**
 * Drives a state (or template) toward completion. In the slice, a single `run` suffices
 * because there are no Needs to satisfy. Async to preserve the contract (IMPL §7.3).
 *
 * @param {import('../run/run.js').PublicState | string} stateOrTemplate
 * @param {DriveOptions} [_opts]
 * @param {import('../index.js').EngineConfig} [config]
 * @returns {Promise<import('../run/run.js').PublicState>}
 */
export async function drive(stateOrTemplate, _opts, config) {
  const initial =
    typeof stateOrTemplate === 'string' ? start(stateOrTemplate, undefined, config) : stateOrTemplate;
  return run(initial, config);
}

/**
 * Convenience orchestrator: expand → drive → finalize (SPEC §2.5). `values` pre-populate
 * `resolved` (clarifications §10).
 *
 * @param {SteboArgs} args
 * @param {import('../index.js').EngineConfig} [config]
 * @returns {Promise<import('../run/run.js').PublicState>}
 */
export async function stebo(args, config) {
  const composed = await expand({ template: args.template, templates: args.templates }, config);
  let state = start(composed, args.values, config);
  state = run(state, config);
  if (state.status === 'completed' && typeof state.output === 'string') {
    state = { ...state, output: finalize(state.output, config) };
  }
  return state;
}
