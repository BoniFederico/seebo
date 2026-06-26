/**
 * @file Public contract for the FINALIZE post-pass (SPEC §1.8, IMPL §10.2): layout/removal
 * macros (`REMOVE_LINE`, `COLLAPSE`, `REMOVE_LEFT`, `REMOVE_RIGHT`) applied AFTER
 * resolution, on the emitted text. Positional: each marker removes itself and its
 * indicated surroundings, in a single stable left→right pass recomputing offsets.
 *
 * Synchronous and pure (IMPL §10.2).
 */

import { NotImplementedError } from '../util/errors.js';

/**
 * Post-pass: applies the layout/removal macros on the already-resolved text. v1 placeholder.
 *
 * @param {string} _resolvedText
 * @param {import('../index.js').EngineConfig} [_config]
 * @returns {string} The finalized output text.
 */
export function finalize(_resolvedText, _config) {
  throw new NotImplementedError('macros.finalize');
}
