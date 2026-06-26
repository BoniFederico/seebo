/**
 * @file Suspendable evaluator (IMPL §5). Pure function `Expr × env → Ok | Susp | Err`.
 *
 * v1 SLICE: evaluates the arithmetic/literal subset produced by the slice parser —
 * `Lit` (int/float/string), `Unary('-')`, and `Binary` with `+ - * /`. It enforces the
 * SPEC §1.4 type rules for these operators (no implicit string coercion; `/` is always
 * float; division by zero is an error). No `Susp` arises in the slice (there are no
 * requirements yet); the `Susp` outcome and the rest of the operators land in later
 * milestones.
 */

import { intValue, floatValue, stringValue, isNumeric, renderValue } from '../runtime/factory.js';
import { createDiagnostic, DiagnosticCode } from '../util/errors.js';

export { renderValue };

/**
 * Evaluation outcome tags (SPEC §1.6, IMPL §5).
 * @type {Readonly<Record<string, string>>}
 */
export const ResultKind = Object.freeze({ OK: 'Ok', SUSP: 'Susp', ERR: 'Err' });

/**
 * @typedef {Object} Ok
 * @property {'Ok'} kind
 * @property {import('../runtime/values.js').Value} value
 */
/**
 * @typedef {Object} Susp
 * @property {'Susp'} kind
 * @property {RequirementDescriptor} need
 */
/**
 * @typedef {Object} Err
 * @property {'Err'} kind
 * @property {import('../util/errors.js').Diagnostic} diagnostic
 */
/** @typedef {Ok | Susp | Err} EvalResult */

/**
 * Requirement descriptor (SPEC §1.6). Declared fields plus analyze-derived `phase`/
 * `options` (IMPL §9). Only `id`, `type`, `capability` are mandatory.
 * @typedef {Object} RequirementDescriptor
 * @property {string} id
 * @property {import('../runtime/values.js').TypeDescriptor} type
 * @property {string} capability
 * @property {string} [label]
 * @property {string} [description]
 * @property {boolean} [optional]
 * @property {number} [priority]
 * @property {string} [group]
 * @property {Record<string, unknown>} [resolverHints]
 * @property {number} [phase]
 * @property {unknown[]} [options]
 */

/**
 * @typedef {Object} EvalEnv
 * @property {Record<string, import('../runtime/values.js').Value>} resolved
 */

/**
 * Evaluates one expression node. Pure, synchronous, no I/O (IMPL §5).
 *
 * @param {import('../ast/nodes.js').Expr} expr
 * @param {EvalEnv} env
 * @param {import('../index.js').EngineConfig} [config]
 * @returns {EvalResult}
 */
export function evaluate(expr, env, config) {
  switch (expr.kind) {
    case 'Lit':
      return evalLit(/** @type {any} */ (expr));
    case 'Unary':
      return evalUnary(/** @type {any} */ (expr), env, config);
    case 'Binary':
      return evalBinary(/** @type {any} */ (expr), env, config);
    default:
      return err(DiagnosticCode.TYPE_ERROR_RUNTIME, expr, {
        got: expr.kind,
        message: `unsupported expression '${expr.kind}' in v1 slice`,
      });
  }
}

/** @param {import('../ast/nodes.js').LitNode} expr @returns {EvalResult} */
function evalLit(expr) {
  switch (expr.type) {
    case 'int':
      return ok(intValue(/** @type {number} */ (expr.value)));
    case 'float':
      return ok(floatValue(/** @type {number} */ (expr.value)));
    case 'string':
      return ok(stringValue(/** @type {string} */ (expr.value)));
    default:
      return err(DiagnosticCode.TYPE_ERROR_RUNTIME, expr, { got: expr.type });
  }
}

/**
 * @param {import('../ast/nodes.js').UnaryNode} expr
 * @param {EvalEnv} env
 * @param {import('../index.js').EngineConfig} [config]
 */
function evalUnary(expr, env, config) {
  const r = evaluate(expr.arg, env, config);
  if (r.kind !== 'Ok') return r;
  if (expr.op === '-' && isNumeric(r.value)) {
    const n = -(/** @type {number} */ (r.value.value));
    return ok(r.value.type === 'int' ? intValue(n) : floatValue(n));
  }
  return err(DiagnosticCode.TYPE_ERROR_RUNTIME, expr, { op: expr.op, got: r.value.type });
}

/**
 * @param {import('../ast/nodes.js').BinaryNode} expr
 * @param {EvalEnv} env
 * @param {import('../index.js').EngineConfig} [config]
 */
function evalBinary(expr, env, config) {
  const l = evaluate(expr.left, env, config);
  if (l.kind !== 'Ok') return l;
  const r = evaluate(expr.right, env, config);
  if (r.kind !== 'Ok') return r;
  return applyBinary(expr.op, l.value, r.value, expr);
}

/**
 * @param {string} op
 * @param {import('../runtime/values.js').Value} a
 * @param {import('../runtime/values.js').Value} b
 * @param {import('../ast/nodes.js').Expr} expr
 * @returns {EvalResult}
 */
function applyBinary(op, a, b, expr) {
  const an = /** @type {number} */ (a.value);
  const bn = /** @type {number} */ (b.value);

  if (op === '+') {
    if (a.type === 'string' && b.type === 'string') {
      return ok(stringValue(/** @type {string} */ (a.value) + /** @type {string} */ (b.value)));
    }
    // No implicit coercion: string + non-string (or vice versa) is a type error (SPEC §1.4).
    if (a.type === 'string' || b.type === 'string') {
      return err(DiagnosticCode.TYPE_ERROR_RUNTIME, expr, { op, got: `${a.type}+${b.type}` });
    }
    if (!isNumeric(a) || !isNumeric(b)) {
      return err(DiagnosticCode.TYPE_ERROR_RUNTIME, expr, { op, got: `${a.type}+${b.type}` });
    }
    return ok(numeric(a, b, an + bn));
  }

  if (op === '-' || op === '*') {
    if (!isNumeric(a) || !isNumeric(b)) {
      return err(DiagnosticCode.TYPE_ERROR_RUNTIME, expr, { op, got: `${a.type}${op}${b.type}` });
    }
    return ok(numeric(a, b, op === '-' ? an - bn : an * bn));
  }

  if (op === '/') {
    if (!isNumeric(a) || !isNumeric(b)) {
      return err(DiagnosticCode.TYPE_ERROR_RUNTIME, expr, { op, got: `${a.type}/${b.type}` });
    }
    if (bn === 0) return err(DiagnosticCode.DIVISION_BY_ZERO, expr, {});
    return ok(floatValue(an / bn)); // `/` is always float (SPEC §1.4)
  }

  // Operators outside the slice (comparisons, logical, ??, etc.).
  return err(DiagnosticCode.TYPE_ERROR_RUNTIME, expr, {
    op,
    message: `operator '${op}' not supported in v1 slice`,
  });
}

/**
 * Numeric result type rule (SPEC §1.4): int op int → int; any float → float.
 * @param {import('../runtime/values.js').Value} a
 * @param {import('../runtime/values.js').Value} b
 * @param {number} value
 */
function numeric(a, b, value) {
  return a.type === 'int' && b.type === 'int' ? intValue(value) : floatValue(value);
}

/** @param {import('../runtime/values.js').Value} value @returns {Ok} */
function ok(value) {
  return { kind: 'Ok', value };
}

/**
 * @param {string} code
 * @param {import('../ast/nodes.js').Expr} expr
 * @param {Record<string, unknown> & { message?: string }} data
 * @returns {Err}
 */
function err(code, expr, data) {
  const { message, ...rest } = data;
  return {
    kind: 'Err',
    diagnostic: createDiagnostic(code, {
      severity: 'error',
      phase: 'run',
      recoverable: false,
      message: message ?? code,
      position: expr.position,
      data: rest,
    }),
  };
}
