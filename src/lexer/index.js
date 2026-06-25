/**
 * @file Lexer: single pass, O(n), skippable atomic blocks (IMPL §2).
 * Dual mode: error-tolerant (`tokenize`) vs error-with-position (for `parse`).
 * v1 placeholder.
 */

import { NotImplementedError } from '../util/errors.js';

/**
 * Token kinds (IMPL §2). `kind` is for editor/highlighting.
 * @type {Readonly<Record<string, string>>}
 */
export const TokenKind = Object.freeze({
  TEXT: 'text',
  SLOT_OPEN: 'slot-open',
  SLOT_CLOSE: 'slot-close',
  SIGIL: 'sigil',
  NAME: 'name',
  METHOD: 'method',
  NUMBER: 'number',
  STRING: 'string',
  BOOL: 'bool',
  OPERATOR: 'operator',
  DOT: 'dot',
  COMMA: 'comma',
  PAREN: 'paren',
  BRACKET: 'bracket',
  BRACE: 'brace',
  ARROW: 'arrow',
  STAR: 'star',
  COMMENT_BODY: 'comment-body',
  MACRO_NAME: 'macro-name',
});

/**
 * Flat token with position (IMPL §2).
 * @typedef {Object} Token
 * @property {string} kind  One of {@link TokenKind}.
 * @property {number} start Start offset (inclusive).
 * @property {number} end   End offset (exclusive).
 */

/**
 * Tokenizes a template in **error-tolerant** mode (SPEC §2.3): never throws, used for
 * syntax highlighting even on incomplete input.
 *
 * @param {string} _template
 * @param {import('../index.js').EngineConfig} [_config]
 * @returns {Token[]}
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
 * @returns {Token[]}
 */
export function lex(_template, _config) {
  throw new NotImplementedError('lexer.lex');
}
