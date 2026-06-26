/**
 * @file Lexer barrel: re-exports the token contract ({@link ./tokens.js}) and the lexer
 * function signatures. Single pass, O(n), skippable atomic blocks (IMPL §2).
 * Dual mode: error-tolerant (`tokenize`) vs error-with-position (`lex`, for `parse`).
 * v1 placeholders.
 */

import { NotImplementedError } from '../util/errors.js';

export { TokenType } from './tokens.js';

/**
 * Backwards-compatible alias for {@link TokenType}.
 * @type {Readonly<Record<string, string>>}
 */
export { TokenType as TokenKind } from './tokens.js';

/**
 * Tokenizes a template in **error-tolerant** mode (SPEC §2.3): never throws, used for
 * syntax highlighting even on incomplete input.
 *
 * @param {string} _template
 * @param {import('../index.js').EngineConfig} [_config]
 * @returns {import('./tokens.js').Token[]}
 */
export function tokenize(_template, _config) {
  throw new NotImplementedError('lexer.tokenize');
}

/**
 * Variant for `parse`: on malformed input it reports an error with position instead of
 * tolerating it (IMPL §2).
 *
 * @param {string} _template
 * @param {import('../index.js').EngineConfig} [_config]
 * @returns {import('./tokens.js').Token[]}
 */
export function lex(_template, _config) {
  throw new NotImplementedError('lexer.lex');
}
