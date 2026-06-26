/**
 * @file Public contract for the EXPAND pre-pass (SPEC §1.8, IMPL §10.1): aggregator
 * macros (`ABSORB`, `MERGE`) expanded BEFORE formula resolution, pulling from the
 * provided template set. Recursive but bounded (anti-cycle + `limits.maxDepth`).
 *
 * `expand` is declared async to allow asynchronous template sources; with all templates
 * provided in memory it behaves synchronously (SPEC §2.5).
 */

import { NotImplementedError } from '../util/errors.js';

/**
 * Arguments for {@link expand}.
 * @typedef {Object} ExpandArgs
 * @property {string} template Root template source.
 * @property {Record<string, string>} [templates] Named templates available to ABSORB/MERGE.
 */

/**
 * Pre-pass: expands aggregators into a flat document on which execution then runs.
 * Imported requirements flow naturally into the symbol table (IMPL §8). v1 placeholder.
 *
 * @param {ExpandArgs} _args
 * @param {import('../index.js').EngineConfig} [_config]
 * @returns {Promise<string>} The composed (flattened) template source.
 */
export async function expand(_args, _config) {
  throw new NotImplementedError('macros.expand');
}
