/**
 * @file Public contract for the lexer's token model (IMPL §2).
 * Source of truth for `Token`, `TokenType` and source positions. No logic here.
 */

/**
 * Token kinds emitted by the lexer (IMPL §2). Stable string values usable by editors
 * for syntax highlighting.
 * @type {Readonly<Record<string, string>>}
 */
export const TokenType = Object.freeze({
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
 * One of the {@link TokenType} values.
 * @typedef {string} TokenKind
 */

/**
 * Options accepted by `tokenize` (IMPL §2).
 * @typedef {Object} TokenizeOptions
 * @property {Record<string, string>} [delimiters]  Override default slot delimiters.
 * @property {boolean} [locations]  When `true`, attach non-normative `line`/`column` to each token's `position`.
 * @property {(diagnostic: import('../util/errors.js').Diagnostic) => void} [onError]
 *   Sink for recoverable lexical diagnostics. Called instead of throwing for recoverable errors.
 *   The lexer never throws for recoverable errors. Must not throw itself.
 */

/**
 * Source span.
 *
 * **Only `start`/`end` offsets are normative. `line`/`column` metadata is optional,
 * derived from offsets, and provided solely for diagnostics/editor convenience.**
 *
 * `start`/`end` are absolute offsets into the template source — the only fields required
 * by tokens, AST nodes, diagnostics, internal source maps and the conformance tests
 * (IMPL §2: tokens carry `{ kind, start, end }`; Appendix A: `position?: { start, end }`).
 *
 * `line`/`column` (v1 decision):
 *  - MUST always be derivable from `start`/`end`;
 *  - MUST NOT be required by normative tests;
 *  - MUST NOT be used for semantic logic, parsing, validation or AST comparison;
 *  - are NOT a stable compatibility surface and may be absent.
 * A future editor-friendly mode could add a separate utility
 * (e.g. `enrichPositionsWithLineColumn(source, astOrTokens)`) instead of relying on them.
 *
 * @typedef {Object} Position
 * @property {number} start Inclusive start offset into the template string (normative).
 * @property {number} end   Exclusive end offset into the template string (normative).
 * @property {number} [line]   1-based line, optional & non-normative (editor/diagnostics only).
 * @property {number} [column] 1-based column, optional & non-normative (editor/diagnostics only).
 */

/**
 * A flat token with its kind and source span (IMPL §2). The lexer produces a flat list
 * of these; the parser consumes them.
 *
 * @typedef {Object} Token
 * @property {TokenKind} kind  One of {@link TokenType}.
 * @property {number}    start Inclusive start offset (kept flat for cheap access).
 * @property {number}    end   Exclusive end offset.
 * @property {Position}  [position] Optional richer span (offsets + non-normative line/column).
 */
