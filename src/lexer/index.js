/**
 * @file Lexer barrel: re-exports the token contract ({@link ./tokens.js}) and the lexer
 * entry points backed by {@link ./lexer.js} (IMPL §2).
 * Dual mode: `tokenize` (error-tolerant, for editors) and `lex` (used by `parse`). Both
 * share the same tolerant scan in v1; the parser turns malformed structure into a thrown
 * `SYNTAX_ERROR`.
 */

import { tokenize as tokenizeImpl } from './lexer.js';

export { TokenType } from './tokens.js';

/**
 * Backwards-compatible alias for {@link TokenType}.
 * @type {Readonly<Record<string, string>>}
 */
export { TokenType as TokenKind } from './tokens.js';

/**
 * Tokenizes a template in error-tolerant mode (SPEC §2.3): never throws.
 *
 * @param {string} template
 * @param {import('../index.js').EngineConfig} [config]
 * @returns {import('./tokens.js').Token[]}
 */
export function tokenize(template, config) {
  return tokenizeImpl(template, config ?? {});
}

/**
 * Token stream used by `parse` (IMPL §2). Same scan in v1; the parser validates structure.
 *
 * @param {string} template
 * @param {import('../index.js').EngineConfig} [config]
 * @returns {import('./tokens.js').Token[]}
 */
export function lex(template, config) {
  return tokenizeImpl(template, config ?? {});
}
