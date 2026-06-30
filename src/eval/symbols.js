/**
 * @file Static declarations and descriptor extraction (IMPL §8, SPEC §1.6/§1.7).
 *
 * A purely syntactic pass over the AST collects every binding into a symbol table
 * (`id → { kind, descriptor }`), realizing the **static scope** of SPEC §1.7 (a name is visible
 * everywhere, regardless of the branch it appears in). Bindings come from two forms:
 *  - `need({...})` — a missing-data requirement resolved by a capability (kind `'require'`);
 *  - `bind(name, descriptor)` — a named binding whose nature is the kind of its descriptor:
 *    a type-builder ⇒ a pure value (`'var'`), `need(...)` ⇒ a requirement (`'require'`), or
 *    `action(...)` ⇒ an effect (`'action'`). The `name` becomes the binding's `id`.
 *
 * Also extracts a {@link import('./evaluator.js').RequirementDescriptor} from a `need(...)` call
 * and evaluates a type-builder expression (`string()`, `array().constraints({...})`, ...) into a
 * {@link import('../runtime/values.js').TypeDescriptor}.
 */

import { builder } from '../runtime/values.js';
import { SeeboError, DiagnosticCode } from '../util/errors.js';
import { BUILTIN_TYPE_NAMES } from '../util/vocabulary.js';

const TYPE_NAMES = new Set(BUILTIN_TYPE_NAMES);

/**
 * Memoized symbol tables keyed by AST identity. The table is a pure function of the AST and
 * is consumed read-only, so a cached one can be safely shared. With `optimizations.astCache`
 * the AST is stable across `run` passes, so the static scan runs once per template instead of
 * once per pass (IMPL §8/§11).
 * @type {WeakMap<import('../ast/nodes.js').Document, Map<string, { kind: 'require'|'var', descriptor: any }>>}
 */
const DECL_CACHE = new WeakMap();

/**
 * Collects all bindings from a document (all branches, statically). Memoized by AST identity.
 * @param {import('../ast/nodes.js').Document} ast
 * @returns {Map<string, { kind: 'require'|'var', descriptor: import('./evaluator.js').RequirementDescriptor }>}
 */
export function collectDeclarations(ast) {
  const cached = DECL_CACHE.get(ast);
  if (cached) return cached;

  /** @type {Map<string, { kind: 'require'|'var', descriptor: any }>} */
  const table = new Map();
  for (const node of ast.nodes) {
    if (node.kind === 'Formula') walkExpr(/** @type {any} */ (node).expr, table);
    else if (node.kind === 'Macro')
      for (const a of /** @type {any} */ (node).args) walkExpr(a, table);
  }
  DECL_CACHE.set(ast, table);
  return table;
}

/** @param {import('../ast/nodes.js').Expr} expr @param {Map<string, any>} table */
function walkExpr(expr, table) {
  if (!expr || typeof expr !== 'object') return;
  if (expr.kind === 'Call') {
    const call = /** @type {import('../ast/nodes.js').CallNode} */ (expr);
    if (call.callee === 'need') {
      // A standalone `need({ id, ... })` registers a requirement. A `need(...)` nested inside a
      // `bind(...)` has no own `id` (it comes from the bind) and is already registered by the
      // `bind` branch below — `extractRequirement` then throws on the missing id, so we skip it.
      try {
        const d = extractRequirement(call);
        if (!table.has(d.id)) table.set(d.id, { kind: 'require', descriptor: d });
      } catch {
        /* bind-wrapped or malformed need: handled by the bind branch / surfaced at eval */
      }
    } else if (call.callee === 'bind') {
      // A malformed `bind` is reported by `validate`/`run`, not here — the static collection must
      // never throw (it feeds `validate`, which is contractually non-throwing).
      try {
        const decl = extractBinding(call);
        if (decl && !table.has(decl.descriptor.id)) {
          table.set(decl.descriptor.id, { kind: decl.kind, descriptor: decl.descriptor });
        }
      } catch {
        /* malformed bind: surfaced by validateBind / evalBind */
      }
    }
  }
  // Recurse into all child expressions.
  for (const child of children(expr)) walkExpr(child, table);
}

/** @param {import('../ast/nodes.js').Expr} expr @returns {import('../ast/nodes.js').Expr[]} */
function children(expr) {
  const e = /** @type {any} */ (expr);
  switch (expr.kind) {
    case 'Unary':
      return [e.arg];
    case 'Binary':
      return [e.left, e.right];
    case 'Ternary':
      return [e.cond, e.then, e.else];
    case 'Call':
      return e.args;
    case 'Method':
      return [e.receiver, ...e.args];
    case 'Namespace':
      return e.args;
    case 'Member':
      return [e.receiver];
    case 'ArrayLit':
      return e.elements;
    case 'ObjectLit':
      return e.entries.map((/** @type {any} */ en) => en.value);
    default:
      return [];
  }
}

/**
 * Extracts a requirement descriptor from a `need({...})` call (SPEC §1.6). When the call is the
 * descriptor of a `bind(name, need({...}))`, the binding `name` supplies the `id` (so it need not
 * be repeated in the descriptor); otherwise the descriptor itself must carry a string `id`.
 * @param {import('../ast/nodes.js').CallNode} call
 * @param {string} [idFromBind]  The enclosing `bind` name, injected as the requirement `id`.
 * @returns {import('./evaluator.js').RequirementDescriptor}
 */
export function extractRequirement(call, idFromBind) {
  const obj = call.args[0];
  if (!obj || obj.kind !== 'ObjectLit') throw syntax('need(...) expects a descriptor object', call);
  const d = readDescriptorObject(/** @type {import('../ast/nodes.js').ObjectLitNode} */ (obj));
  if (idFromBind !== undefined && d.id === undefined) d.id = idFromBind;
  if (typeof d.id !== 'string') throw syntax("need descriptor needs a string 'id'", call);
  if (typeof d.capability !== 'string') {
    throw syntax(`need '${d.id}' needs a 'capability'`, call);
  }
  if (!d.type) d.type = builder('string').toDescriptor();
  return /** @type {any} */ (d);
}

/**
 * Statically extracts the descriptor of an `action({...})` call (SPEC §2.8), reading only the
 * fields that are syntactically constant. Used by `analyze`/`validate`; the runtime evaluator
 * evaluates the descriptor fully (its `input` may depend on requirements). Dynamic fields are
 * reported via `dynamic` so callers can mark best-effort metadata.
 *
 * @param {import('../ast/nodes.js').CallNode} call
 * @returns {{ id: string | undefined, type: string | undefined, environment: string | undefined, confirm: boolean, dryRun: boolean, permissions: string[], dynamicInput: boolean }}
 */
export function extractActionStatic(call) {
  const obj = call.args[0];
  if (!obj || obj.kind !== 'ObjectLit') {
    throw syntax('action(...) expects a descriptor object', call);
  }
  const entries = /** @type {import('../ast/nodes.js').ObjectLitNode} */ (obj).entries;
  /** @type {Record<string, import('../ast/nodes.js').Expr>} */
  const byKey = {};
  for (const e of entries) if (e.key !== '__proto__') byKey[e.key] = e.value;

  return {
    id: literalString(byKey.id),
    type: literalString(byKey.type),
    environment: literalString(byKey.environment),
    confirm: literalBool(byKey.confirm) === true,
    dryRun: literalBool(byKey.dryRun) === true,
    permissions: literalStringArray(byKey.permissions),
    dynamicInput: byKey.input ? !isConstant(byKey.input) : false,
  };
}

/** @param {import('../ast/nodes.js').Expr | undefined} expr @returns {string | undefined} */
function literalString(expr) {
  const e = /** @type {any} */ (expr);
  return e && e.kind === 'Lit' && e.type === 'string' ? /** @type {string} */ (e.value) : undefined;
}

/** @param {import('../ast/nodes.js').Expr | undefined} expr @returns {boolean | undefined} */
function literalBool(expr) {
  const e = /** @type {any} */ (expr);
  return e && e.kind === 'Lit' && e.type === 'bool' ? /** @type {boolean} */ (e.value) : undefined;
}

/** @param {import('../ast/nodes.js').Expr | undefined} expr @returns {string[]} */
function literalStringArray(expr) {
  const e = /** @type {any} */ (expr);
  if (!e || e.kind !== 'ArrayLit') return [];
  /** @type {string[]} */
  const out = [];
  for (const el of e.elements) {
    const s = literalString(el);
    if (s !== undefined) out.push(s);
  }
  return out;
}

/** `true` when an expression is a compile-time constant (no refs/requires/calls). @param {import('../ast/nodes.js').Expr} expr @returns {boolean} */
function isConstant(expr) {
  const e = /** @type {any} */ (expr);
  switch (e.kind) {
    case 'Lit':
      return true;
    case 'ArrayLit':
      return e.elements.every(isConstant);
    case 'ObjectLit':
      return e.entries.every((/** @type {any} */ en) => isConstant(en.value));
    case 'Unary':
      return e.op === '-' && isConstant(e.arg);
    default:
      return false;
  }
}

/**
 * Extracts a binding from a `bind('name', descriptor)` call (SPEC §1.7). The nature of the
 * binding is the kind of its descriptor argument:
 *  - a type-builder (`int()`, `string().constraints({...})`) ⇒ a pure value (kind `'var'`);
 *  - `need({...})` ⇒ a requirement (kind `'require'`), with `id` taken from `name`;
 *  - `action({...})` ⇒ an effect (kind `'action'`); the descriptor keeps the `action` Call node
 *    so the evaluator can record it into the action plan when the bound name is referenced.
 *
 * @param {import('../ast/nodes.js').CallNode} call
 * @returns {{ kind: 'var'|'require'|'action', descriptor: any } | undefined}
 */
export function extractBinding(call) {
  const nameNode = call.args[0];
  if (!nameNode || nameNode.kind !== 'Lit' || /** @type {any} */ (nameNode).type !== 'string') {
    throw syntax('bind(...) expects a string name', call);
  }
  const id = /** @type {string} */ (/** @type {any} */ (nameNode).value);
  const descNode = /** @type {any} */ (call.args[1]);
  if (!descNode)
    throw syntax(`bind '${id}' needs a descriptor (a type, need(...) or action(...))`, call);

  if (descNode.kind === 'Call' && descNode.callee === 'need') {
    return { kind: 'require', descriptor: extractRequirement(descNode, id) };
  }
  if (descNode.kind === 'Call' && descNode.callee === 'action') {
    // The action descriptor is evaluated lazily by the evaluator; statically we keep the id and
    // the AST node so a `Ref` to `id` can run `evalAction` on it.
    return { kind: 'action', descriptor: { id, actionNode: descNode } };
  }
  // Otherwise the descriptor is a type-builder ⇒ a pure value binding (the former `var`).
  return { kind: 'var', descriptor: { id, type: evalTypeExpr(descNode) } };
}

/**
 * Reads a descriptor `ObjectLit` into a plain object, evaluating the `type` field as a
 * type-builder and other fields as constant literals/JSON.
 * @param {import('../ast/nodes.js').ObjectLitNode} obj
 * @returns {Record<string, unknown>}
 */
function readDescriptorObject(obj) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const entry of obj.entries) {
    if (entry.key === 'type') out.type = evalTypeExpr(entry.value);
    else out[entry.key] = constToJson(entry.value);
  }
  return out;
}

/**
 * Evaluates a type-builder expression into a TypeDescriptor (SPEC §1.7).
 * Supports `T()`, `T(args)`-free builders and chained `.format/.constraints/.default`.
 * @param {import('../ast/nodes.js').Expr} expr
 * @returns {import('../runtime/values.js').TypeDescriptor}
 */
export function evalTypeExpr(expr) {
  return evalTypeBuilder(expr).toDescriptor();
}

/** @param {import('../ast/nodes.js').Expr} expr @returns {import('../runtime/values.js').TypeBuilder} */
function evalTypeBuilder(expr) {
  const e = /** @type {any} */ (expr);
  if (e.kind === 'Call' && TYPE_NAMES.has(e.callee) && e.args.length === 0) {
    return builder(e.callee);
  }
  if (e.kind === 'Method') {
    const recv = evalTypeBuilder(e.receiver);
    if (e.name === 'constraints') {
      return recv.constraints(/** @type {Record<string, unknown>} */ (constToJson(e.args[0])));
    }
    if (e.name === 'format') {
      return recv.format(/** @type {Record<string, unknown>} */ (constToJson(e.args[0])));
    }
    if (e.name === 'default') return recv.default(constToJson(e.args[0]));
    throw syntax(`unsupported type-builder method '${e.name}'`, expr);
  }
  throw syntax('invalid type expression in descriptor', expr);
}

/**
 * Evaluates a constant expression (literals / array / object literals) to plain JSON,
 * used for descriptor metadata and builder config. Rejects non-constant expressions.
 * @param {import('../ast/nodes.js').Expr} expr
 * @returns {unknown}
 */
export function constToJson(expr) {
  const e = /** @type {any} */ (expr);
  switch (e.kind) {
    case 'Lit':
      return e.value;
    case 'ArrayLit':
      return e.elements.map(constToJson);
    case 'ObjectLit': {
      /** @type {Record<string, unknown>} */
      const out = {};
      for (const entry of e.entries) {
        if (entry.key === '__proto__') continue;
        out[entry.key] = constToJson(entry.value);
      }
      return out;
    }
    case 'Unary':
      if (e.op === '-') return -(/** @type {number} */ (constToJson(e.arg)));
      break;
    default:
      break;
  }
  throw syntax(`expected a constant value, got '${e.kind}'`, expr);
}

/** @param {string} message @param {import('../ast/nodes.js').Expr|import('../ast/nodes.js').Node} node */
function syntax(message, node) {
  return new SeeboError(message, {
    code: DiagnosticCode.SYNTAX_ERROR,
    position: /** @type {any} */ (node)?.position,
  });
}
