/**
 * @file Complete lexer (IMPL §2). `tokenize(input, options?) → Token[]`.
 *
 * Design (IMPL §2):
 *  - Single linear pass, O(n). Outside slots the text is copied verbatim; only `$ # @`
 *    immediately followed by the open brace start a slot (respecting `\` escaping).
 *  - Inside a slot, strings `'…'` and the close brace are handled so a `}` that belongs to
 *    a string or a nested object literal is not mistaken for the slot close (brace-depth
 *    tracking). Whitespace inside slots produces no tokens.
 *  - Error-tolerant: it never throws. Recoverable lexical problems (unterminated string /
 *    slot / comment, unexpected character) are reported through `options.onError` with a
 *    position and a stable `code`, while scanning continues.
 *
 * Performance: scanning uses character-code comparisons (no per-character regex) and
 * pushes minimal `{ kind, start, end }` objects. Optional `line`/`column` are computed
 * only when `options.locations` is set, via a single precomputed line-index.
 *
 * The `Token` shape and `TokenType` values come from {@link ./tokens.js} (the contract).
 */

import { TokenType } from './tokens.js';
import { createDiagnostic, DiagnosticCode } from '../util/errors.js';

const DEFAULT_DELIMITERS = { formula: '$', comment: '#', macro: '@', open: '{', close: '}' };

/** Word-shaped operators/forms (SPEC §1.4/§1.5) lexed as `operator` rather than `name`. */
const WORD_OPERATORS = new Set(['and', 'or', 'not', 'in', 'match']);
/** Two-character operators (matched before single-character ones). */
const TWO_CHAR_OPS = new Set(['==', '!=', '<=', '>=', '??', '=>']);
/** Single-character operators. */
const SINGLE_CHAR_OPS = '+-*/<>?:';

// Character classification via code points (faster and allocation-free).
const CH_TAB = 9;
const CH_LF = 10;
const CH_CR = 13;
const CH_SPACE = 32;

/** @param {number} c */
const isDigit = (c) => c >= 48 && c <= 57;
/** @param {number} c */
const isIdentStart = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
/** @param {number} c */
const isIdentChar = (c) => isIdentStart(c) || isDigit(c);
/** @param {number} c */
const isSpace = (c) => c === CH_SPACE || c === CH_TAB || c === CH_LF || c === CH_CR;

/**
 * Options for {@link tokenize}.
 * @typedef {Object} TokenizeOptions
 * @property {Record<string, string>} [delimiters] Override sigils/braces (SPEC §1.2).
 * @property {boolean} [locations] If true, attach `position` with non-normative `line`/`column`.
 * @property {(diagnostic: import('../util/errors.js').Diagnostic) => void} [onError] Sink for
 *   recoverable lexical diagnostics (position + stable code). The lexer never throws.
 */

/**
 * Tokenizes a template into a flat list of tokens (IMPL §2). Error-tolerant.
 *
 * @param {string} input
 * @param {TokenizeOptions | import('../index.js').EngineConfig} [options]
 * @returns {import('./tokens.js').Token[]}
 */
export function tokenize(input, options = {}) {
  const d = { ...DEFAULT_DELIMITERS, ...(options.delimiters ?? {}) };
  const onError = /** @type {TokenizeOptions} */ (options).onError;
  const sigilFormula = d.formula;
  const sigilComment = d.comment;
  const sigilMacro = d.macro;
  const open = d.open;
  const close = d.close;
  /** @param {string} ch */
  const isSigil = (ch) => ch === sigilFormula || ch === sigilComment || ch === sigilMacro;

  const n = input.length;
  /** @type {import('./tokens.js').Token[]} */
  const tokens = [];
  let i = 0;

  /** @param {string} kind @param {number} start @param {number} end */
  const push = (kind, start, end) => {
    tokens.push({ kind, start, end });
  };

  /** @param {string} message @param {number} start @param {number} end */
  const report = (message, start, end) => {
    if (onError) {
      onError(
        createDiagnostic(DiagnosticCode.SYNTAX_ERROR, {
          severity: 'error',
          phase: 'tokenize',
          recoverable: true,
          message,
          position: { start, end },
        })
      );
    }
  };

  while (i < n) {
    // ----- text context -----
    const textStart = i;
    while (i < n) {
      const c = input[i];
      // Escaped sigil: `\` + sigil + open → literal text (do not open a slot).
      if (c === '\\' && isSigil(input[i + 1]) && input[i + 2] === open) {
        i += 3;
        continue;
      }
      if (isSigil(c) && input[i + 1] === open) break;
      i++;
    }
    if (i > textStart) push(TokenType.TEXT, textStart, i);
    if (i >= n) break;

    // ----- slot opens -----
    const sigil = input[i];
    push(TokenType.SLOT_OPEN, i, i + 2); // slot-open encodes the sigil (input[start])
    const slotOpenAt = i;
    i += 2;

    if (sigil === sigilComment) {
      i = scanComment(slotOpenAt);
    } else {
      i = scanSlot(slotOpenAt, sigil === sigilMacro);
    }
  }

  if (/** @type {TokenizeOptions} */ (options).locations) attachLocations(input, tokens);
  return tokens;

  /* --------------------------------------------------------------------------------- *
   * Inner scanners (closures over input / push / report / delimiters)
   * --------------------------------------------------------------------------------- */

  /**
   * Reads a comment body up to the matching top-level close, then the slot-close.
   * @param {number} slotOpenStart
   * @returns {number} new index
   */
  function scanComment(slotOpenStart) {
    const bodyStart = i;
    let depth = 0;
    while (i < n) {
      const c = input[i];
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
    if (i > bodyStart) push(TokenType.COMMENT_BODY, bodyStart, i);
    if (i < n && input[i] === close) {
      push(TokenType.SLOT_CLOSE, i, i + 1);
      return i + 1;
    }
    report('unterminated comment slot', slotOpenStart, n);
    return i;
  }

  /**
   * Tokenizes a formula/macro slot up to and including its top-level close.
   * @param {number} slotOpenStart
   * @param {boolean} isMacro
   * @returns {number} new index
   */
  function scanSlot(slotOpenStart, isMacro) {
    let braceDepth = 0;
    /** @type {string|null} previous emitted kind (for name-vs-method by the dot). */
    let prev = null;
    /** macro slots tag their first identifier as `macro-name`. */
    let macroNamePending = isMacro;

    /** @param {string} kind @param {number} s @param {number} e */
    const emit = (kind, s, e) => {
      push(kind, s, e);
      prev = kind;
    };

    while (i < n) {
      const code = input.charCodeAt(i);

      if (isSpace(code)) {
        i++;
        continue;
      }

      const c = input[i];

      // Top-level close ends the slot.
      if (c === close && braceDepth === 0) {
        emit(TokenType.SLOT_CLOSE, i, i + 1);
        return i + 1;
      }

      // String literal '…'
      if (c === "'") {
        const s = i;
        i++;
        let terminated = false;
        while (i < n) {
          if (input[i] === '\\') {
            i += 2;
            continue;
          }
          if (input[i] === "'") {
            i++;
            terminated = true;
            break;
          }
          i++;
        }
        if (!terminated) report('unterminated string literal', s, n);
        emit(TokenType.STRING, s, i);
        continue;
      }

      // Number literal (int or float by decimal point)
      if (isDigit(code)) {
        const s = i;
        while (i < n && isDigit(input.charCodeAt(i))) i++;
        if (input[i] === '.' && isDigit(input.charCodeAt(i + 1))) {
          i++;
          while (i < n && isDigit(input.charCodeAt(i))) i++;
        }
        emit(TokenType.NUMBER, s, i);
        continue;
      }

      // Identifier / keyword
      if (isIdentStart(code)) {
        const s = i;
        i++;
        while (i < n && isIdentChar(input.charCodeAt(i))) i++;
        const word = input.slice(s, i);
        let kind;
        if (macroNamePending) {
          kind = TokenType.MACRO_NAME;
          macroNamePending = false;
        } else if (prev === TokenType.DOT) {
          kind = TokenType.METHOD;
        } else if (word === 'true' || word === 'false') {
          kind = TokenType.BOOL;
        } else if (WORD_OPERATORS.has(word)) {
          kind = TokenType.OPERATOR;
        } else {
          kind = TokenType.NAME;
        }
        emit(kind, s, i);
        continue;
      }

      // Single-character structural tokens
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

      // Operators: two-char first (arrow is its own kind).
      const two = input.slice(i, i + 2);
      if (TWO_CHAR_OPS.has(two)) {
        emit(two === '=>' ? TokenType.ARROW : TokenType.OPERATOR, i, i + 2);
        i += 2;
        continue;
      }
      // `*` is the match-default `star` when the next significant token is `=>`.
      if (c === '*') {
        emit(starOrOperator(i + 1), i, i + 1);
        i++;
        continue;
      }
      if (SINGLE_CHAR_OPS.includes(c)) {
        emit(TokenType.OPERATOR, i, i + 1);
        i++;
        continue;
      }

      // Unexpected character: report and skip (tolerant).
      report(`unexpected character '${c}'`, i, i + 1);
      i++;
    }

    report("unterminated slot: expected '}'", slotOpenStart, n);
    return i;
  }

  /**
   * Classifies `*` as `star` (match default) when the next non-space chars are `=>`,
   * otherwise as a multiplication `operator`.
   * @param {number} from index just after the `*`
   * @returns {string}
   */
  function starOrOperator(from) {
    let j = from;
    while (j < n && isSpace(input.charCodeAt(j))) j++;
    return input[j] === '=' && input[j + 1] === '>' ? TokenType.STAR : TokenType.OPERATOR;
  }
}

/* ----------------------------------------------------------------------------------- *
 * Optional line/column enrichment (non-normative, IMPL §2 / Positions note)
 * ----------------------------------------------------------------------------------- */

/**
 * Attaches a `position` with offsets + 1-based `line`/`column` to each token, derived from
 * a single precomputed line index. Newlines are `\n` (CRLF counts at the `\n`).
 * @param {string} input
 * @param {import('./tokens.js').Token[]} tokens
 */
function attachLocations(input, tokens) {
  /** @type {number[]} offsets at which each line begins */
  const lineStarts = [0];
  for (let i = 0; i < input.length; i++) {
    if (input.charCodeAt(i) === CH_LF) lineStarts.push(i + 1);
  }
  for (const t of tokens) {
    const { line, column } = lineColAt(lineStarts, t.start);
    t.position = { start: t.start, end: t.end, line, column };
  }
}

/**
 * Binary-searches the line index for the line/column of an offset.
 * @param {number[]} lineStarts
 * @param {number} offset
 * @returns {{ line: number, column: number }}
 */
function lineColAt(lineStarts, offset) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - lineStarts[lo] + 1 };
}
