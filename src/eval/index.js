/**
 * @file Suspendable evaluator (IMPL §5): a pure function `Expr × env →
 * Ok(Value) | Susp(Need) | Err(Diagnostic)` (a "three-way monad"). v1 placeholder.
 */

import { NotImplementedError } from '../util/errors.js';

/**
 * Evaluation outcomes (SPEC §1.6, IMPL §5).
 * @type {Readonly<Record<string, string>>}
 */
export const ResultKind = Object.freeze({
  OK: 'Ok',
  SUSP: 'Susp',
  ERR: 'Err',
});

/**
 * @typedef {{ kind: 'Ok', value: import('../runtime/index.js').Value }} Ok
 * @typedef {{ kind: 'Susp', need: RequirementDescriptor }} Susp
 * @typedef {{ kind: 'Err', diagnostic: import('../util/errors.js').Diagnostic }} Err
 * @typedef {Ok | Susp | Err} EvalResult
 */

/**
 * Requirement descriptor (SPEC §1.6). `phase`/`options` are derived by `analyze`.
 * @typedef {Object} RequirementDescriptor
 * @property {string} id
 * @property {import('../runtime/index.js').TypeDescriptor} type
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
 * Evaluates an expression node in the given environment (the already-resolved
 * requirements). Pure, synchronous, no I/O (IMPL §5). v1 placeholder.
 *
 * @param {import('../ast/index.js').Expr} _expr
 * @param {{ resolved: Record<string, import('../runtime/index.js').Value> }} _env
 * @returns {EvalResult}
 */
export function evaluate(_expr, _env) {
  throw new NotImplementedError('eval.evaluate');
}
