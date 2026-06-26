/**
 * @file Complete parser (IMPL §3): `parse(tokens, options?) → Document`.
 *
 * Consumes the flat token stream produced by the lexer (IMPL §2) and builds the typed AST
 * (src/ast/nodes.js). Structure (document text/slots, primaries, calls, member/method
 * chains, object/array literals, `match`) uses predictive recursive descent; infix
 * operators use Pratt / precedence climbing driven by {@link PRECEDENCE} (must match
 * SPEC §1.4). `match` is desugared immediately into nested ternaries (IMPL §3), so
 * downstream phases never see a `match` node.
 *
 * Config-dependent desugaring (IMPL §3, applied only when the names are supplied in
 * `options`, e.g. by `engine.parse`):
 *  - capability sugar: `cap({...})` → `require({..., capability:'cap'})` when `cap` is a
 *    registered capability (SPEC §1.6);
 *  - library namespaces: `ns.name(...)` → a `Namespace` node when `ns` is a registered
 *    library (SPEC §1.5).
 *
 * `parse` THROWS a {@link SeeboError} with `SYNTAX_ERROR` and a position on malformed
 * input (SPEC §2.3). It needs the original `source` (via `options.source`) to read token
 * lexemes, since tokens carry only offsets.
 *
 * Macro ordering (per IMPL §10): aggregator macros (`ABSORB`/`MERGE`) are expanded by the
 * EXPAND pre-pass on the raw template BEFORE parsing; this parser only builds `Macro`
 * nodes (both families) structurally — it does not expand them.
 */

import { TokenType } from '../lexer/tokens.js';
import { AST_VERSION } from '../util/versions.js';
import { SeeboError, DiagnosticCode } from '../util/errors.js';
import { DEFAULT_LIMITS } from '../util/limits.js';

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

/** Binding power of the ternary `?:` (SPEC §1.4 level 10), right-associative. */
const TERNARY_BINDING = PRECEDENCE['?:'].binding;

const AGGREGATOR_MACROS = new Set(['ABSORB', 'MERGE']);
const LAYOUT_MACROS = new Set(['COLLAPSE', 'REMOVE_LINE', 'REMOVE_LEFT', 'REMOVE_RIGHT']);

/**
 * @typedef {Object} ParseOptions
 * @property {string} source The original template (required to read token lexemes).
 * @property {Record<string, string>} [delimiters] Sigils/braces (for text unescaping).
 * @property {Iterable<string>} [capabilities] Registered capability names (enables sugar).
 * @property {Iterable<string>} [libraries] Registered library names (enables Namespace).
 * @property {Record<string, 'aggregator'|'layout'>} [macros] Custom macro → family map.
 * @property {Record<string, number>} [limits] Resource limits (`maxNodes`, `maxNestingDepth`).
 */

/**
 * Parses tokens into a Document AST (IMPL §3.1).
 *
 * @param {import('../lexer/tokens.js').Token[]} tokens
 * @param {ParseOptions} options
 * @returns {import('../ast/nodes.js').Document}
 */
export function parse(tokens, options) {
  if (!options || typeof options.source !== 'string') {
    throw new SeeboError('parse(tokens, options): options.source is required', {
      code: DiagnosticCode.SYNTAX_ERROR,
    });
  }
  const ctx = createContext(tokens, options);
  /** @type {import('../ast/nodes.js').Node[]} */
  const nodes = [];

  while (!ctx.atEnd()) {
    const tok = ctx.peek();
    ctx.countNode(); // one document node (IMPL §13)
    if (tok.kind === TokenType.TEXT) {
      ctx.next();
      nodes.push({
        kind: 'Text',
        position: { start: tok.start, end: tok.end },
        value: unescapeText(ctx.text(tok), ctx.delimiters),
      });
    } else if (tok.kind === TokenType.SLOT_OPEN) {
      nodes.push(parseSlot(ctx));
    } else {
      throw ctx.error(`unexpected token '${tok.kind}' at document level`, tok);
    }
  }

  return { astVersion: AST_VERSION, nodes };
}

/* ----------------------------------------------------------------------------------- *
 * Slots: ${ formula }, #{ comment }, @{ macro }
 * ----------------------------------------------------------------------------------- */

/** @param {Context} ctx @returns {import('../ast/nodes.js').Node} */
function parseSlot(ctx) {
  const openTok = ctx.next(); // slot-open
  const sigil = ctx.source[openTok.start];

  if (sigil === ctx.delimiters.comment) {
    if (ctx.check(TokenType.COMMENT_BODY)) ctx.next();
    const close = ctx.expect(TokenType.SLOT_CLOSE, "expected '}' to close comment");
    return { kind: 'Comment', position: span(openTok, close) };
  }

  if (sigil === ctx.delimiters.macro) {
    return parseMacro(ctx, openTok);
  }

  // Formula slot ${ ... }
  const expr = parseExpr(ctx, 0);
  const close = ctx.expect(TokenType.SLOT_CLOSE, "expected '}' to close slot");
  return { kind: 'Formula', position: span(openTok, close), expr };
}

/**
 * @param {Context} ctx
 * @param {import('../lexer/tokens.js').Token} openTok
 * @returns {import('../ast/nodes.js').MacroNode}
 */
function parseMacro(ctx, openTok) {
  const nameTok = ctx.expect(TokenType.MACRO_NAME, 'expected a macro name');
  const name = ctx.text(nameTok);
  /** @type {import('../ast/nodes.js').Expr[]} */
  let args = [];
  if (ctx.checkPunct(TokenType.PAREN, '(')) args = parseArgs(ctx);
  const close = ctx.expect(TokenType.SLOT_CLOSE, "expected '}' to close macro");
  return {
    kind: 'Macro',
    position: span(openTok, close),
    name,
    args,
    family: macroFamily(name, ctx.macros),
  };
}

/** @param {string} name @param {Record<string, 'aggregator'|'layout'>} custom */
function macroFamily(name, custom) {
  if (custom && custom[name]) return custom[name];
  if (AGGREGATOR_MACROS.has(name)) return 'aggregator';
  if (LAYOUT_MACROS.has(name)) return 'layout';
  return 'layout'; // unknown custom macros default to layout (finalize) until configured
}

/* ----------------------------------------------------------------------------------- *
 * Expressions: Pratt precedence climbing + recursive-descent primaries
 * ----------------------------------------------------------------------------------- */

/**
 * @param {Context} ctx
 * @param {number} minBinding
 * @returns {import('../ast/nodes.js').Expr}
 */
function parseExpr(ctx, minBinding) {
  // Nesting guard (IMPL §13). No try/finally: a thrown error aborts the whole parse, so the
  // depth counter need not be unwound — we just decrement on the normal return path.
  ctx.enter();
  let left = parseUnary(ctx);

  for (;;) {
    const tok = ctx.peek();
    if (!tok || tok.kind !== TokenType.OPERATOR) break;
    const op = ctx.text(tok);

    // Ternary: cond ? then : else  (right-associative, SPEC §1.4 level 10)
    if (op === '?') {
      if (TERNARY_BINDING < minBinding) break;
      ctx.next();
      const thenExpr = parseExpr(ctx, 0);
      ctx.expectPunct(TokenType.OPERATOR, ':', "expected ':' in ternary");
      const elseExpr = parseExpr(ctx, TERNARY_BINDING);
      ctx.countNode();
      left = {
        kind: 'Ternary',
        position: span(left, elseExpr),
        cond: left,
        then: thenExpr,
        else: elseExpr,
      };
      continue;
    }

    const prec = PRECEDENCE[op];
    if (!prec) break;
    if (prec.binding < minBinding) break;
    ctx.next();
    const right = parseExpr(ctx, prec.assoc === 'left' ? prec.binding + 1 : prec.binding);
    ctx.countNode();
    left = { kind: 'Binary', position: span(left, right), op, left, right };
  }

  ctx.exit();
  return left;
}

/** @param {Context} ctx @returns {import('../ast/nodes.js').Expr} */
function parseUnary(ctx) {
  const tok = ctx.peek();
  if (tok && tok.kind === TokenType.OPERATOR) {
    const op = ctx.text(tok);
    if (op === '-' || op === 'not') {
      ctx.next();
      ctx.enter(); // guard chained unary recursion (`not not …`)
      const arg = parseUnary(ctx);
      ctx.countNode();
      ctx.exit();
      return { kind: 'Unary', position: span(tok, arg), op, arg };
    }
  }
  return parsePostfix(ctx);
}

/** @param {Context} ctx @returns {import('../ast/nodes.js').Expr} */
function parsePostfix(ctx) {
  let node = parseAtom(ctx);

  for (;;) {
    const tok = ctx.peek();
    if (!tok) break;

    if (tok.kind === TokenType.DOT) {
      ctx.next();
      const nameTok = ctx.expectIdentifier('expected a member or method name after "."');
      const name = ctx.text(nameTok);
      if (ctx.checkPunct(TokenType.PAREN, '(')) {
        const args = parseArgs(ctx);
        const end = ctx.last();
        if (node.kind === 'Ref' && ctx.libraries.has(node.name)) {
          node = { kind: 'Namespace', position: span(node, end), ns: node.name, name, args };
        } else {
          node = { kind: 'Method', position: span(node, end), receiver: node, name, args };
        }
      } else {
        node = { kind: 'Member', position: span(node, nameTok), receiver: node, key: name };
      }
      continue;
    }

    // Producer call: name(...)
    if (node.kind === 'Ref' && tok.kind === TokenType.PAREN && ctx.source[tok.start] === '(') {
      const args = parseArgs(ctx);
      node = makeCall(ctx, node, args);
      continue;
    }

    break;
  }

  // Primary `match` form (SPEC §1.4): subject match { arms }
  const next = ctx.peek();
  if (next && next.kind === TokenType.OPERATOR && ctx.text(next) === 'match') {
    node = parseMatch(ctx, node);
  }

  return node;
}

/** @param {Context} ctx @returns {import('../ast/nodes.js').Expr} */
function parseAtom(ctx) {
  const tok = ctx.peek();
  if (!tok) throw ctx.error('unexpected end of expression', ctx.last());

  ctx.countNode(); // one primary node (IMPL §13)
  switch (tok.kind) {
    case TokenType.NUMBER: {
      ctx.next();
      const raw = ctx.text(tok);
      const isFloat = raw.includes('.');
      return {
        kind: 'Lit',
        position: span(tok, tok),
        type: isFloat ? 'float' : 'int',
        value: Number(raw),
      };
    }
    case TokenType.STRING:
      ctx.next();
      return {
        kind: 'Lit',
        position: span(tok, tok),
        type: 'string',
        value: unquote(ctx.text(tok)),
      };
    case TokenType.BOOL:
      ctx.next();
      return {
        kind: 'Lit',
        position: span(tok, tok),
        type: 'bool',
        value: ctx.text(tok) === 'true',
      };
    case TokenType.NAME:
      ctx.next();
      return { kind: 'Ref', position: span(tok, tok), name: ctx.text(tok) };
    case TokenType.PAREN:
      if (ctx.source[tok.start] === '(') {
        ctx.next();
        const inner = parseExpr(ctx, 0);
        ctx.expectPunct(TokenType.PAREN, ')', "expected ')'");
        return inner;
      }
      break;
    case TokenType.BRACKET:
      if (ctx.source[tok.start] === '[') return parseArrayLit(ctx);
      break;
    case TokenType.BRACE:
      if (ctx.source[tok.start] === '{') return parseObjectLit(ctx);
      break;
    default:
      break;
  }
  throw ctx.error(`unexpected token '${tok.kind}' in expression`, tok);
}

/** @param {Context} ctx @returns {import('../ast/nodes.js').Expr[]} */
function parseArgs(ctx) {
  ctx.expectPunct(TokenType.PAREN, '(', "expected '('");
  /** @type {import('../ast/nodes.js').Expr[]} */
  const args = [];
  if (ctx.checkPunct(TokenType.PAREN, ')')) {
    ctx.next();
    return args;
  }
  for (;;) {
    args.push(parseExpr(ctx, 0));
    if (ctx.checkPunct(TokenType.COMMA, ',')) {
      ctx.next();
      if (ctx.checkPunct(TokenType.PAREN, ')')) break; // trailing comma
      continue;
    }
    break;
  }
  ctx.expectPunct(TokenType.PAREN, ')', "expected ')' to close arguments");
  return args;
}

/** @param {Context} ctx @returns {import('../ast/nodes.js').ArrayLitNode} */
function parseArrayLit(ctx) {
  const open = ctx.expectPunct(TokenType.BRACKET, '[', "expected '['");
  /** @type {import('../ast/nodes.js').Expr[]} */
  const elements = [];
  if (ctx.checkPunct(TokenType.BRACKET, ']')) {
    const close = ctx.next();
    return { kind: 'ArrayLit', position: span(open, close), elements };
  }
  for (;;) {
    elements.push(parseExpr(ctx, 0));
    if (ctx.checkPunct(TokenType.COMMA, ',')) {
      ctx.next();
      if (ctx.checkPunct(TokenType.BRACKET, ']')) break;
      continue;
    }
    break;
  }
  const close = ctx.expectPunct(TokenType.BRACKET, ']', "expected ']' to close array");
  return { kind: 'ArrayLit', position: span(open, close), elements };
}

/** @param {Context} ctx @returns {import('../ast/nodes.js').ObjectLitNode} */
function parseObjectLit(ctx) {
  const open = ctx.expectPunct(TokenType.BRACE, '{', "expected '{'");
  /** @type {import('../ast/nodes.js').ObjectEntry[]} */
  const entries = [];
  if (ctx.checkPunct(TokenType.BRACE, '}')) {
    const close = ctx.next();
    return { kind: 'ObjectLit', position: span(open, close), entries };
  }
  for (;;) {
    const keyTok = ctx.peek();
    let key;
    if (keyTok && keyTok.kind === TokenType.NAME) key = ctx.text(keyTok);
    else if (keyTok && keyTok.kind === TokenType.STRING) key = unquote(ctx.text(keyTok));
    else throw ctx.error('expected an object key', keyTok);
    ctx.next();
    ctx.expectPunct(TokenType.OPERATOR, ':', "expected ':' after object key");
    const value = parseExpr(ctx, 0);
    entries.push({ key, value });
    if (ctx.checkPunct(TokenType.COMMA, ',')) {
      ctx.next();
      if (ctx.checkPunct(TokenType.BRACE, '}')) break;
      continue;
    }
    break;
  }
  const close = ctx.expectPunct(TokenType.BRACE, '}', "expected '}' to close object");
  return { kind: 'ObjectLit', position: span(open, close), entries };
}

/**
 * Parses a `match` form and desugars it into nested ternaries (IMPL §3).
 * @param {Context} ctx
 * @param {import('../ast/nodes.js').Expr} subject
 * @returns {import('../ast/nodes.js').Expr}
 */
function parseMatch(ctx, subject) {
  ctx.next(); // consume 'match'
  ctx.expectPunct(TokenType.BRACE, '{', "expected '{' after match");

  /** @type {{ test: import('../ast/nodes.js').Expr, result: import('../ast/nodes.js').Expr }[]} */
  const arms = [];
  /** @type {import('../ast/nodes.js').Expr | null} */
  let defaultExpr = null;

  if (!ctx.checkPunct(TokenType.BRACE, '}')) {
    for (;;) {
      if (ctx.check(TokenType.STAR)) {
        ctx.next();
        ctx.expect(TokenType.ARROW, "expected '=>' after match default '*'");
        defaultExpr = parseExpr(ctx, 0);
        // A default must be the last arm.
        if (ctx.checkPunct(TokenType.COMMA, ',')) ctx.next();
        break;
      }
      const test = parseExpr(ctx, 0);
      ctx.expect(TokenType.ARROW, "expected '=>' in match arm");
      const result = parseExpr(ctx, 0);
      arms.push({ test, result });
      if (ctx.checkPunct(TokenType.COMMA, ',')) {
        ctx.next();
        if (ctx.checkPunct(TokenType.BRACE, '}')) break;
        continue;
      }
      break;
    }
  }

  const close = ctx.expectPunct(TokenType.BRACE, '}', "expected '}' to close match");

  // Desugar to nested ternaries. When there is no default arm, the innermost else falls
  // back to the empty string; validate (future) is responsible for flagging
  // NON_EXHAUSTIVE_MATCH when the cases are not provably exhaustive (IMPL §3).
  /** @type {import('../ast/nodes.js').Expr} */
  let elseExpr = defaultExpr ?? {
    kind: 'Lit',
    position: span(close, close),
    type: 'string',
    value: '',
  };
  for (let i = arms.length - 1; i >= 0; i--) {
    const arm = arms[i];
    /** @type {import('../ast/nodes.js').BinaryNode} */
    const cond = {
      kind: 'Binary',
      position: span(subject, arm.test),
      op: '==',
      left: subject,
      right: arm.test,
    };
    elseExpr = {
      kind: 'Ternary',
      position: span(subject, elseExpr),
      cond,
      then: arm.result,
      else: elseExpr,
    };
  }

  // Non-normative marker: a `match` without a `*` default arm is not provably exhaustive
  // over an open domain (int/string/…). The marker is attached only in that case, so the
  // exhaustive form's AST stays byte-identical; `validate` reads it to emit
  // NON_EXHAUSTIVE_MATCH (IMPL §3 / B.3). It is ignored by every other phase.
  if (defaultExpr === null && arms.length > 0) {
    /** @type {any} */ (elseExpr).nonExhaustiveMatch = true;
  }
  return elseExpr;
}

/**
 * Builds a producer Call, applying capability sugar (SPEC §1.6) when the callee is a
 * registered capability: `cap({...})` → `require({..., capability:'cap'})`.
 * @param {Context} ctx
 * @param {import('../ast/nodes.js').RefNode} calleeRef
 * @param {import('../ast/nodes.js').Expr[]} args
 * @returns {import('../ast/nodes.js').CallNode}
 */
function makeCall(ctx, calleeRef, args) {
  const end = ctx.last();
  const position = span(calleeRef, end);
  const name = calleeRef.name;

  if (ctx.capabilities.has(name)) {
    return {
      kind: 'Call',
      position,
      callee: 'require',
      args: injectCapability(args, name, position),
    };
  }
  return { kind: 'Call', position, callee: name, args };
}

/**
 * Adds `capability: '<name>'` to the descriptor (first arg) of a capability-sugar call.
 * @param {import('../ast/nodes.js').Expr[]} args
 * @param {string} name
 * @param {import('../ast/nodes.js').Position} position
 * @returns {import('../ast/nodes.js').Expr[]}
 */
function injectCapability(args, name, position) {
  const first = args[0];
  if (!first || first.kind !== 'ObjectLit') return args; // malformed; validate will flag
  const hasCapability = first.entries.some((e) => e.key === 'capability');
  if (hasCapability) return args;
  /** @type {import('../ast/nodes.js').ObjectLitNode} */
  const descriptor = {
    kind: 'ObjectLit',
    position: first.position,
    entries: [
      ...first.entries,
      { key: 'capability', value: { kind: 'Lit', position, type: 'string', value: name } },
    ],
  };
  return [descriptor, ...args.slice(1)];
}

/* ----------------------------------------------------------------------------------- *
 * Cursor / context utilities
 * ----------------------------------------------------------------------------------- */

/**
 * @typedef {ReturnType<typeof createContext>} Context
 */

/**
 * @param {import('../lexer/tokens.js').Token[]} tokens
 * @param {ParseOptions} options
 */
function createContext(tokens, options) {
  let pos = 0;
  const source = options.source;
  const delimiters = {
    formula: '$',
    comment: '#',
    macro: '@',
    open: '{',
    close: '}',
    ...(options.delimiters ?? {}),
  };
  const capabilities = new Set(options.capabilities ?? []);
  const libraries = new Set(options.libraries ?? []);
  const macros = options.macros ?? {};
  const limits = options.limits ?? {};
  const maxNodes = limits.maxNodes ?? DEFAULT_LIMITS.maxNodes;
  const maxNestingDepth = limits.maxNestingDepth ?? DEFAULT_LIMITS.maxNestingDepth;

  let nodeCount = 0;
  let depth = 0;

  const IDENTIFIER_KINDS = new Set([TokenType.NAME, TokenType.METHOD]);

  return {
    source,
    delimiters,
    capabilities,
    libraries,
    macros,
    /** Counts one AST node toward `maxNodes` (IMPL §13). @throws {SeeboError} */
    countNode() {
      if (++nodeCount > maxNodes) {
        throw new SeeboError(`template exceeds maxNodes (${maxNodes})`, {
          code: DiagnosticCode.NODE_LIMIT_EXCEEDED,
        });
      }
    },
    /** Enters one nesting level, guarding `maxNestingDepth` (stack-overflow guard, IMPL §13). @throws {SeeboError} */
    enter() {
      if (++depth > maxNestingDepth) {
        throw new SeeboError(`expression nesting exceeds maxNestingDepth (${maxNestingDepth})`, {
          code: DiagnosticCode.NESTING_LIMIT_EXCEEDED,
        });
      }
    },
    /** Leaves one nesting level. */
    exit() {
      depth--;
    },
    atEnd: () => pos >= tokens.length,
    peek: (offset = 0) => tokens[pos + offset],
    next: () => tokens[pos++],
    last: () => tokens[pos - 1],
    /** @param {import('../lexer/tokens.js').Token} t */
    text: (t) => source.slice(t.start, t.end),
    /** @param {string} kind */
    check: (kind) => {
      const t = tokens[pos];
      return Boolean(t) && t.kind === kind;
    },
    /** @param {string} kind @param {string} ch */
    checkPunct: (kind, ch) => {
      const t = tokens[pos];
      return Boolean(t) && t.kind === kind && source.slice(t.start, t.end) === ch;
    },
    /** @param {string} kind @param {string} message */
    expect(kind, message) {
      const t = tokens[pos];
      if (!t || t.kind !== kind) throw this.error(message, t);
      pos++;
      return t;
    },
    /** @param {string} kind @param {string} ch @param {string} message */
    expectPunct(kind, ch, message) {
      const t = tokens[pos];
      if (!t || t.kind !== kind || source.slice(t.start, t.end) !== ch)
        throw this.error(message, t);
      pos++;
      return t;
    },
    /** @param {string} message */
    expectIdentifier(message) {
      const t = tokens[pos];
      if (!t || !IDENTIFIER_KINDS.has(t.kind)) throw this.error(message, t);
      pos++;
      return t;
    },
    /**
     * @param {string} message
     * @param {import('../lexer/tokens.js').Token} [tok]
     * @returns {SeeboError}
     */
    error(message, tok) {
      const at = tok ?? tokens[pos - 1];
      const where = at ? ` near "${source.slice(at.start, at.end)}"` : '';
      return new SeeboError(`${message}${where}`, {
        code: DiagnosticCode.SYNTAX_ERROR,
        position: at ? { start: at.start, end: at.end } : undefined,
      });
    },
  };
}

/* ----------------------------------------------------------------------------------- *
 * Helpers
 * ----------------------------------------------------------------------------------- */

/**
 * Position spanning from `a` to `b` (each a token `{start,end}` or a node `{position}`).
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
 * @param {{ formula: string, comment: string, macro: string, open: string }} d
 */
function unescapeText(raw, d) {
  const cls = [d.formula, d.comment, d.macro].map(escapeRegExp).join('');
  const re = new RegExp(`\\\\([${cls}])${escapeRegExp(d.open)}`, 'g');
  return raw.replace(re, `$1${d.open}`);
}

/** @param {string} s */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Strips the surrounding single quotes and resolves `\'` / `\\` (SPEC §1.2).
 * @param {string} raw
 */
function unquote(raw) {
  return raw.slice(1, -1).replace(/\\(['\\])/g, '$1');
}
