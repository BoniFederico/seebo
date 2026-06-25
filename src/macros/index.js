/**
 * @file Macros: aggregators (pre-pass `expand`) and layout (post-pass `finalize`),
 * SPEC §1.8 / IMPL §10. `finalize` is synchronous and pure; `expand` is declared async
 * to allow asynchronous template sources. v1 placeholder.
 */

import { NotImplementedError } from '../util/errors.js';

/**
 * Macro families (IMPL §3.1: `Macro.family`).
 * @type {Readonly<Record<string, string>>}
 */
export const MacroFamily = Object.freeze({
  AGGREGATOR: 'aggregator',
  LAYOUT: 'layout',
});

/**
 * Builtin macros (SPEC §1.5, reserved words).
 * @type {ReadonlyArray<string>}
 */
export const BUILTIN_MACROS = Object.freeze([
  'ABSORB',
  'MERGE',
  'COLLAPSE',
  'REMOVE_LINE',
  'REMOVE_LEFT',
  'REMOVE_RIGHT',
]);

/**
 * Pre-pass: expands the aggregators (`ABSORB`/`MERGE`) using the provided templates
 * (IMPL §10.1). Async for asynchronous template sources. v1 placeholder.
 *
 * @param {{ template: string, templates?: Record<string, string> }} _args
 * @param {import('../index.js').EngineConfig} [_config]
 * @returns {Promise<string>}
 */
export async function expand(_args, _config) {
  throw new NotImplementedError('macros.expand');
}

/**
 * Post-pass: applies the layout/removal macros on the already-resolved text (IMPL §10.2).
 * Synchronous and pure. v1 placeholder.
 *
 * @param {string} _resolvedText
 * @param {import('../index.js').EngineConfig} [_config]
 * @returns {string}
 */
export function finalize(_resolvedText, _config) {
  throw new NotImplementedError('macros.finalize');
}
