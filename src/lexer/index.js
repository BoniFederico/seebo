/**
 * @file Lexer barrel: re-exports the token contract ({@link ./tokens.js}) and exposes the
 * lexer entry points backed by {@link ./scanner.js} (IMPL §2).
 * Dual mode: `tokenize` (error-tolerant, for editors) and `lex` (used by `parse`).
 * In v1 the scanner is shared and tolerant; the parser is responsible for turning
 * malformed structure into diagnostics.
 */

import { scan } from './scanner.js';

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
  return scan(template, config);
}

/**
 * Token stream used by `parse` (IMPL §2). Same scan in v1; the parser validates structure.
 *
 * @param {string} template
 * @param {import('../index.js').EngineConfig} [config]
 * @returns {import('./tokens.js').Token[]}
 */
export function lex(template, config) {
  return scan(template, config);
}
