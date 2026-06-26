/**
 * @file Parser (IMPL §3): document recursive descent + Pratt/precedence-climbing for
 * infix operators. The `PRECEDENCE` table is the implementation authority (must match
 * SPEC §1.4).
 *
 * v1 SLICE: parses verbatim text (with `\` escaping), comment slots `#{ ... }` and
 * formula slots `${ ... }` whose expressions use **numeric/string literals, the
 * arithmetic operators `+ - * /`, unary `-`, and parentheses**. Constructs outside this
 * subset (identifiers/refs, producers/calls, methods, members, macros `@{}`) raise a
 * structured `SYNTAX_ERROR`. `parse` THROWS on malformed input (SPEC §2.3).
 */

import { tokenize as scan } from '../lexer/lexer.js';
import { TokenType } from '../lexer/tokens.js';
import { AST_VERSION } from '../util/versions.js';
import { SeeboError, DiagnosticCode } from '../util/errors.js';

/**
 * Infix operator precedence table (IMPL §3; must match SPEC §1.4).
 * @type {Readonly<Record<string, { level: number, assoc: 'left'|'right', binding: number }>>}
 */
export const PRECEDENCE = Object.freeze({
  '*': { level: 3, assoc: 'left', binding: 560 },
  '/': { level: 3, assoc: 'left', binding: 560 },
  '+': { level: 4, assoc: 'left', binding: 540 },
  '-': { level: 4, assoc: 'left', binding: 540 },
  '<': { level: 5, assoc: 'left', binding: 520 },
  '<=': { level: 5, assoc: 'left', binding: 520 },
  '>': { level: 5, assoc: 'left', binding: 520 },
  '>=': { level: 5, assoc: 'left', binding: 520 },
  '==': { level: 6, assoc: 'left', binding: 500 },
  '!=': { level: 6, assoc: 'left', binding: 500 },
  in: { level: 6, assoc: 'left', binding: 500 },
  and: { level: 7, assoc: 'left', binding: 480 },
  or: { level: 8, assoc: 'left', binding: 460 },
  '??': { level: 9, assoc: 'right', binding: 440 },
  '?:': { level: 10, assoc: 'right', binding: 420 },
});

/** Binding power of unary prefix operators (SPEC §1.4 level 2 — tighter than `*`). */
const UNARY_BINDING = 600;

/**
 * Builds the template AST (IMPL §3.1). Throws {@link SeeboError} with `SYNTAX_ERROR` and a
 * position on malformed/unsupported input.
 *
 * @param {string} template
 * @param {import('../index.js').EngineConfig} [config]
 * @returns {import('../ast/nodes.js').Document}
 */
export function parse(template, config) {
  const tokens = scan(template, config);
  const cur = makeCursor(template, tokens);
  /** @type {import('../ast/nodes.js').Node[]} */
  const nodes = [];

  while (!cur.atEnd()) {
    const tok = cur.peek();
    if (tok.kind === TokenType.TEXT) {
      cur.next();
      nodes.push({
        kind: 'Text',
        position: span(tok, tok),
        value: unescapeText(template.slice(tok.start, tok.end), config),
      });
    } else if (tok.kind === TokenType.SLOT_OPEN) {
      nodes.push(parseSlot(cur));
    } else {
      throw syntax(`unexpected token '${tok.kind}'`, tok);
    }
  }

  return { astVersion: AST_VERSION, nodes };
}

/* ----------------------------------------------------------------------------------- *
 * Slots
 * ----------------------------------------------------------------------------------- */

/** @param {Cursor} cur @returns {import('../ast/nodes.js').Node} */
function parseSlot(cur) {
  const openTok = cur.next(); // slot-open
  const sigil = cur.template[openTok.start];

  if (sigil === '#') {
    if (cur.peek()?.kind === TokenType.COMMENT_BODY) cur.next();
    const closeTok = expectSlotClose(cur, openTok);
    return { kind: 'Comment', position: span(openTok, closeTok) };
  }

  if (sigil === '@') {
    // Macros (@{ ... }) are valid SPEC (§1.8) but out of the v1 slice.
    throw syntax('macros (@{ ... }) are not supported in the v1 slice', openTok);
  }

  // Formula slot ${ ... }
  const expr = parseExpr(cur, 0);
  const closeTok = expectSlotClose(cur, openTok);
  return { kind: 'Formula', position: span(openTok, closeTok), expr };
}

/** @param {Cursor} cur @param {import('../lexer/tokens.js').Token} openTok */
function expectSlotClose(cur, openTok) {
  const tok = cur.peek();
  if (!tok) throw syntax("unterminated slot: expected '}'", openTok);
  if (tok.kind !== TokenType.SLOT_CLOSE) throw syntax(`expected '}' to close slot`, tok);
  return cur.next();
}

/* ----------------------------------------------------------------------------------- *
 * Expressions (Pratt / precedence climbing)
 * ----------------------------------------------------------------------------------- */

/**
 * @param {Cursor} cur
 * @param {number} minBinding
 * @returns {import('../ast/nodes.js').Expr}
 */
function parseExpr(cur, minBinding) {
  let left = parsePrefix(cur);
  for (;;) {
    const tok = cur.peek();
    if (!tok) break;
    const op = infixOp(cur, tok);
    if (op === null) break;
    const prec = PRECEDENCE[op];
    if (prec.binding < minBinding) break;
    cur.next(); // consume operator
    const nextMin = prec.assoc === 'left' ? prec.binding + 1 : prec.binding;
    const right = parseExpr(cur, nextMin);
    left = { kind: 'Binary', position: span(left, right), op, left, right };
  }
  return left;
}

/** @param {Cursor} cur @returns {import('../ast/nodes.js').Expr} */
function parsePrefix(cur) {
  const tok = cur.peek();
  if (!tok) throw syntax('unexpected end of expression', cur.lastToken());

  // Unary minus
  if (tok.kind === TokenType.OPERATOR && cur.text(tok) === '-') {
    cur.next();
    const arg = parseExpr(cur, UNARY_BINDING);
    return { kind: 'Unary', position: span(tok, arg), op: '-', arg };
  }

  if (tok.kind === TokenType.NUMBER) {
    cur.next();
    const raw = cur.text(tok);
    const isFloat = raw.includes('.');
    return {
      kind: 'Lit',
      position: span(tok, tok),
      type: isFloat ? 'float' : 'int',
      value: Number(raw),
    };
  }

  if (tok.kind === TokenType.STRING) {
    cur.next();
    return { kind: 'Lit', position: span(tok, tok), type: 'string', value: unquote(cur.text(tok)) };
  }

  if (tok.kind === TokenType.PAREN && cur.text(tok) === '(') {
    cur.next();
    const inner = parseExpr(cur, 0);
    const closing = cur.peek();
    if (!closing || closing.kind !== TokenType.PAREN || cur.text(closing) !== ')') {
      throw syntax("expected ')'", closing ?? cur.lastToken());
    }
    cur.next();
    return inner;
  }

  throw syntax(`unsupported expression token '${tok.kind}' in v1 slice`, tok);
}

/**
 * Returns the infix operator text if `tok` is a known infix operator, else null.
 * @param {Cursor} cur
 * @param {import('../lexer/tokens.js').Token} tok
 * @returns {string|null}
 */
function infixOp(cur, tok) {
  if (tok.kind !== TokenType.OPERATOR) return null;
  const text = cur.text(tok);
  return text in PRECEDENCE ? text : null;
}

/* ----------------------------------------------------------------------------------- *
 * Helpers
 * ----------------------------------------------------------------------------------- */

/**
 * @typedef {ReturnType<typeof makeCursor>} Cursor
 */

/**
 * @param {string} template
 * @param {import('../lexer/tokens.js').Token[]} tokens
 */
function makeCursor(template, tokens) {
  let pos = 0;
  return {
    template,
    atEnd: () => pos >= tokens.length,
    peek: () => tokens[pos],
    next: () => tokens[pos++],
    lastToken: () => tokens[tokens.length - 1],
    /** @param {import('../lexer/tokens.js').Token} t */
    text: (t) => template.slice(t.start, t.end),
  };
}

/**
 * Builds a Position spanning from `a.position.start` (or `a.start`) to `b.position.end`
 * (or `b.end`). Accepts tokens or AST nodes.
 * @param {{ start?: number, position?: { start: number } }} a
 * @param {{ end?: number, position?: { end: number } }} b
 * @returns {{ start: number, end: number }}
 */
function span(a, b) {
  const start = a.position ? a.position.start : /** @type {number} */ (a.start);
  const end = b.position ? b.position.end : /** @type {number} */ (b.end);
  return { start, end };
}

/**
 * Unescapes `\${`, `\#{`, `\@{` to their literal sigil+open (SPEC §1.2).
 * @param {string} raw
 * @param {import('../index.js').EngineConfig} [config]
 * @returns {string}
 */
function unescapeText(raw, config) {
  const d = config?.delimiters ?? {};
  const sigils = [d.formula ?? '$', d.comment ?? '#', d.macro ?? '@'];
  const open = d.open ?? '{';
  // Replace backslash + sigil + open with sigil + open.
  const cls = sigils.map((s) => escapeRegExp(s)).join('');
  const re = new RegExp(`\\\\([${cls}])${escapeRegExp(open)}`, 'g');
  return raw.replace(re, `$1${open}`);
}

/** @param {string} s */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Strips the surrounding single quotes and resolves `\'` / `\\` (SPEC §1.2). */
function unquote(raw) {
  return raw.slice(1, -1).replace(/\\(['\\])/g, '$1');
}

/**
 * @param {string} message
 * @param {import('../lexer/tokens.js').Token} [tok]
 * @returns {SeeboError}
 */
function syntax(message, tok) {
  return new SeeboError(message, {
    code: DiagnosticCode.SYNTAX_ERROR,
    position: tok ? { start: tok.start, end: tok.end } : undefined,
  });
}
