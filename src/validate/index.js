/**
 * @file `validate` (SPEC §2.3, IMPL §8): static diagnostics, accumulated (never throws).
 * Undeclared identifiers, function/arity, statically deducible type violations,
 * unregistered capabilities, types not allowed by policy. v1 placeholder.
 */

import { NotImplementedError } from '../util/errors.js';

/**
 * Runs the static validity analysis. Returns a list (empty = ok). v1 placeholder.
 *
 * @param {string} _template
 * @param {import('../index.js').EngineConfig} [_config]
 * @returns {import('../util/errors.js').Diagnostic[]}
 */
export function validate(_template, _config) {
  throw new NotImplementedError('validate.validate');
}
