/**
 * @file EXPAND pre-pass (SPEC §1.8, IMPL §10.1): aggregator macros (`ABSORB`, `MERGE`).
 *
 * v1 SLICE: aggregators are not implemented yet. `expand` is a faithful pass-through —
 * it returns the template unchanged. (A template that actually contains `@{ABSORB/MERGE}`
 * is out of the slice and will be rejected later by the parser.) The async signature is
 * kept for forward compatibility with asynchronous template sources.
 */

/**
 * @typedef {Object} ExpandArgs
 * @property {string} template
 * @property {Record<string, string>} [templates]
 */

/**
 * @param {ExpandArgs} args
 * @param {import('../index.js').EngineConfig} [_config]
 * @returns {Promise<string>}
 */
export async function expand(args, _config) {
  return args.template;
}
