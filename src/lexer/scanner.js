/**
 * @file Single-pass, O(n) scanner (IMPL §2). Produces a flat list of {@link
 * import('./tokens.js').Token}. Error-tolerant: never throws (the parser turns malformed
 * structure into diagnostics). It recognizes the FULL token vocabulary for editor use,
 * even though the v1 parser only consumes a subset.
 *
 * Two contexts: outside slots (verbatim text, with `\` escaping of sigils) and inside
 * slots (expression/macro tokens, with skippable whitespace and brace-depth tracking).
 * Comment slots `#{ ... }` capture a single `comment-body` token.
 */

import { TokenType } from './tokens.js';

const DEFAULTS = { formula: '$', comment: '#', macro: '@', open: '{', close: '}' };

const isDigit = (c) => c >= '0' && c <= '9';
const isIdentStart = (c) => /[A-Za-z_]/.test(c);
const isIdentChar = (c) => /[A-Za-z0-9_]/.test(c);
const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';

/** Word operators that lex as `operator` rather than `name` (SPEC §1.4/§1.5). */
const WORD_OPERATORS = new Set(['and', 'or', 'not', 'in']);
/** Two-character operators (longest match first). */
const TWO_CHAR_OPS = new Set(['==', '!=', '<=', '>=', '??', '=>']);

/**
 * Scans a template into tokens (IMPL §2).
 * @param {string} template
 * @param {{ delimiters?: Record<string, string> }} [config]
 * @returns {import('./tokens.js').Token[]}
 */
export function scan(template, config) {
  const d = { ...DEFAULTS, ...(config?.delimiters ?? {}) };
  const sigils = new Set([d.formula, d.comment, d.macro]);
  const { open, close } = d;
  const n = template.length;

  /** @type {import('./tokens.js').Token[]} */
  const tokens = [];
  let i = 0;

  /** @param {string} kind @param {number} start @param {number} end */
  const push = (kind, start, end) => tokens.push({ kind, start, end });

  /** True if a slot opens at position `p` with a non-escaped sigil + open. */
  const slotOpensAt = (p) => sigils.has(template[p]) && template[p + 1] === open;

  while (i < n) {
    // --- text context ---
    const textStart = i;
    while (i < n) {
      // Escaped sigil: `\` + sigil + open → literal text, do not open a slot.
      if (template[i] === '\\' && sigils.has(template[i + 1]) && template[i + 2] === open) {
        i += 3;
        continue;
      }
      if (slotOpensAt(i)) break;
      i++;
    }
    if (i > textStart) push(TokenType.TEXT, textStart, i);
    if (i >= n) break;

    // --- slot opens ---
    const sigil = template[i];
    push(TokenType.SLOT_OPEN, i, i + 2);
    i += 2;
    if (sigil === d.comment) {
      i = scanCommentBody(template, i, open, close, push);
    } else {
      i = scanSlotInner(template, i, open, close, push);
    }
  }

  return tokens;
}

/**
 * Reads a comment body up to the matching top-level `close`, then the slot-close.
 * @returns {number} the new index.
 */
function scanCommentBody(template, start, open, close, push) {
  const n = template.length;
  let i = start;
  let depth = 0;
  while (i < n) {
    const c = template[i];
    if (c === open) {
      depth++;
      i++;
    } else if (c === close) {
      if (depth === 0) break;
      depth--;
      i++;
    } else {
      i++;
    }
  }
  if (i > start) push(TokenType.COMMENT_BODY, start, i);
  if (i < n && template[i] === close) {
    push(TokenType.SLOT_CLOSE, i, i + 1);
    i++;
  }
  return i;
}

/**
 * Tokenizes the inside of a formula/macro slot up to and including its top-level `close`.
 * @returns {number} the new index.
 */
function scanSlotInner(template, start, open, close, push) {
  const n = template.length;
  let i = start;
  let braceDepth = 0;
  /** @type {string|null} kind of the previous emitted token (for name vs method). */
  let prev = null;

  /** @param {string} kind @param {number} s @param {number} e */
  const emit = (kind, s, e) => {
    push(kind, s, e);
    prev = kind;
  };

  while (i < n) {
    const c = template[i];

    if (isSpace(c)) {
      i++;
      continue;
    }

    // Top-level close ends the slot.
    if (c === close && braceDepth === 0) {
      emit(TokenType.SLOT_CLOSE, i, i + 1);
      i++;
      return i;
    }

    // String literal '...'
    if (c === "'") {
      const s = i;
      i++;
      while (i < n && template[i] !== "'") i += template[i] === '\\' ? 2 : 1;
      if (i < n) i++; // consume closing quote
      emit(TokenType.STRING, s, i);
      continue;
    }

    // Number literal (int or float by decimal point)
    if (isDigit(c)) {
      const s = i;
      while (i < n && isDigit(template[i])) i++;
      if (template[i] === '.' && isDigit(template[i + 1])) {
        i++;
        while (i < n && isDigit(template[i])) i++;
      }
      emit(TokenType.NUMBER, s, i);
      continue;
    }

    // Identifier / keyword
    if (isIdentStart(c)) {
      const s = i;
      while (i < n && isIdentChar(template[i])) i++;
      const word = template.slice(s, i);
      let kind;
      if (prev === TokenType.DOT) kind = TokenType.METHOD;
      else if (word === 'true' || word === 'false') kind = TokenType.BOOL;
      else if (WORD_OPERATORS.has(word)) kind = TokenType.OPERATOR;
      else kind = TokenType.NAME;
      emit(kind, s, i);
      continue;
    }

    // Single-char structural tokens
    if (c === '.') {
      emit(TokenType.DOT, i, i + 1);
      i++;
      continue;
    }
    if (c === ',') {
      emit(TokenType.COMMA, i, i + 1);
      i++;
      continue;
    }
    if (c === '(' || c === ')') {
      emit(TokenType.PAREN, i, i + 1);
      i++;
      continue;
    }
    if (c === '[' || c === ']') {
      emit(TokenType.BRACKET, i, i + 1);
      i++;
      continue;
    }
    if (c === open) {
      braceDepth++;
      emit(TokenType.BRACE, i, i + 1);
      i++;
      continue;
    }
    if (c === close) {
      braceDepth--;
      emit(TokenType.BRACE, i, i + 1);
      i++;
      continue;
    }

    // Operators (two-char first)
    const two = template.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      emit(two === '=>' ? TokenType.ARROW : TokenType.OPERATOR, i, i + 2);
      i += 2;
      continue;
    }
    if ('+-*/<>?:'.includes(c)) {
      emit(TokenType.OPERATOR, i, i + 1);
      i++;
      continue;
    }

    // Unknown character: tolerant — emit as a single-char operator and advance.
    emit(TokenType.OPERATOR, i, i + 1);
    i++;
  }

  return i; // unterminated slot (tolerant); parser will report it
}
