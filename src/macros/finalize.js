/**
 * @file FINALIZE post-pass (SPEC §1.8, IMPL §10.2): layout/removal macros
 * (`REMOVE_LINE`, `COLLAPSE`, `REMOVE_LEFT`, `REMOVE_RIGHT`).
 *
 * v1 SLICE: layout macros are not implemented yet. `finalize` is a faithful pass-through —
 * it returns the resolved text unchanged. Synchronous and pure (IMPL §10.2).
 */

/**
 * @param {string} resolvedText
 * @param {import('../index.js').EngineConfig} [_config]
 * @returns {string}
 */
export function finalize(resolvedText, _config) {
  return resolvedText;
}
