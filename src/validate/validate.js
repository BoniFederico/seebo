/**
 * @file Public contract for `validate` (SPEC §2.3, IMPL §8). Static, pure, accumulating
 * (never throws): returns a list of diagnostics (empty = ok).
 *
 * Detects (SPEC §1.10): undeclared identifiers, unknown functions/methods, arity
 * mismatches, statically deducible type violations, non-exhaustive `match`, unregistered
 * capabilities, and types/functions/capabilities forbidden by policy.
 */

import { NotImplementedError } from '../util/errors.js';

/**
 * Runs the static validity analysis over a template. v1 placeholder.
 *
 * @param {string} _template
 * @param {import('../index.js').EngineConfig} [_config]
 * @returns {import('../util/errors.js').Diagnostic[]}
 */
export function validate(_template, _config) {
  throw new NotImplementedError('validate.validate');
}
