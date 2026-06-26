/**
 * @file Static declarations and descriptor extraction (IMPL §8, SPEC §1.6/§1.7).
 *
 * A purely syntactic pass over the AST collects every `require`/`var` declaration into a
 * symbol table (`id → { kind, descriptor }`), realizing the **static scope** of SPEC §1.7
 * (a name is visible everywhere, regardless of the branch it appears in). Also extracts a
 * {@link import('./evaluator.js').RequirementDescriptor} from a `require(...)` call and
 * evaluates a type-builder expression (`string()`, `array().constraints({...})`, ...) into
 * a {@link import('../runtime/values.js').TypeDescriptor}.
 */

import { builder } from '../runtime/values.js';
import { SeeboError, DiagnosticCode } from '../util/errors.js';

const TYPE_NAMES = new Set([
  'int',
  'float',
  'bool',
  'string',
  'datetime',
  'duration',
  'object',
  'array',
]);

/**
 * Collects all `require`/`var` declarations from a document (all branches, statically).
 * @param {import('../ast/nodes.js').Document} ast
 * @returns {Map<string, { kind: 'require'|'var', descriptor: import('./evaluator.js').RequirementDescriptor }>}
 */
export function collectDeclarations(ast) {
  /** @type {Map<string, { kind: 'require'|'var', descriptor: any }>} */
  const table = new Map();
  for (const node of ast.nodes) {
    if (node.kind === 'Formula') walkExpr(/** @type {any} */ (node).expr, table);
    else if (node.kind === 'Macro')
      for (const a of /** @type {any} */ (node).args) walkExpr(a, table);
  }
  return table;
}

/** @param {import('../ast/nodes.js').Expr} expr @param {Map<string, any>} table */
function walkExpr(expr, table) {
  if (!expr || typeof expr !== 'object') return;
  if (expr.kind === 'Call') {
    const call = /** @type {import('../ast/nodes.js').CallNode} */ (expr);
    if (call.callee === 'require') {
      const d = extractRequirement(call);
      if (!table.has(d.id)) table.set(d.id, { kind: 'require', descriptor: d });
    } else if (call.callee === 'var') {
      const d = extractVar(call);
      if (!table.has(d.id)) table.set(d.id, { kind: 'var', descriptor: d });
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
 * Extracts a requirement descriptor from a `require({...})` call (SPEC §1.6).
 * @param {import('../ast/nodes.js').CallNode} call
 * @returns {import('./evaluator.js').RequirementDescriptor}
 */
export function extractRequirement(call) {
  const obj = call.args[0];
  if (!obj || obj.kind !== 'ObjectLit')
    throw syntax('require(...) expects a descriptor object', call);
  const d = readDescriptorObject(/** @type {import('../ast/nodes.js').ObjectLitNode} */ (obj));
  if (typeof d.id !== 'string') throw syntax("require descriptor needs a string 'id'", call);
  if (typeof d.capability !== 'string') {
    throw syntax(`require '${d.id}' needs a 'capability'`, call);
  }
  if (!d.type) d.type = builder('string').toDescriptor();
  return /** @type {any} */ (d);
}

/**
 * Extracts a var declaration from a `var('name', type?)` call (SPEC §1.7).
 * @param {import('../ast/nodes.js').CallNode} call
 */
function extractVar(call) {
  const nameNode = call.args[0];
  if (!nameNode || nameNode.kind !== 'Lit' || /** @type {any} */ (nameNode).type !== 'string') {
    throw syntax('var(...) expects a string name', call);
  }
  const id = /** @type {string} */ (/** @type {any} */ (nameNode).value);
  const typeNode = call.args[1];
  const type = typeNode ? evalTypeExpr(typeNode) : builder('string').toDescriptor();
  return { id, type };
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
