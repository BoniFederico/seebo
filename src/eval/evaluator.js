/**
 * @file Public contract for the suspendable evaluator (IMPL §5). Source of truth for the
 * three-way result (`Ok | Susp | Err`), the requirement descriptor, and the evaluator
 * signature. No logic here beyond `throw new Error('TODO')` placeholders.
 *
 * Suspend/resume model (IMPL §5 / §6.4): the evaluator itself is a PURE single-pass
 * function over an expression. "Suspension" is the `Susp` outcome (an unmet `Need`);
 * "resume" is NOT a coroutine here — in v1 the run loop ({@link ../run/run.js}) resumes by
 * full re-evaluation against an enriched `resolved` environment (strategy 1, IMPL §6.4).
 * Continuations/checkpoints are optional future optimizations, intentionally absent in v1.
 */

import { NotImplementedError } from '../util/errors.js';

/**
 * Evaluation outcome tags (SPEC §1.6, IMPL §5).
 * @type {Readonly<Record<string, string>>}
 */
export const ResultKind = Object.freeze({
  OK: 'Ok',
  SUSP: 'Susp',
  ERR: 'Err',
});

/**
 * Successful evaluation: a concrete typed value is available.
 * @typedef {Object} Ok
 * @property {'Ok'} kind
 * @property {import('../runtime/values.js').Value} value
 */

/**
 * Suspension: the expression needs an external datum not yet in `resolved` (a `Need`).
 * The branch suspends instead of failing (SPEC §1.6).
 * @typedef {Object} Susp
 * @property {'Susp'} kind
 * @property {RequirementDescriptor} need
 */

/**
 * Failure: a fatal/typing diagnostic for this expression.
 * @typedef {Object} Err
 * @property {'Err'} kind
 * @property {import('../util/errors.js').Diagnostic} diagnostic
 */

/**
 * The three possible results of evaluating an expression (IMPL §5).
 * @typedef {Ok | Susp | Err} EvalResult
 */

/**
 * Requirement descriptor (SPEC §1.6). Declared fields plus the analyze-derived `phase`
 * and `options` (IMPL §9). Only `id`, `type`, `capability` are mandatory.
 *
 * @typedef {Object} RequirementDescriptor
 * @property {string} id                 Unique requirement id (key in state).
 * @property {import('../runtime/values.js').TypeDescriptor} type Expected Seebo type (builder).
 * @property {string} capability         Capability that can satisfy it.
 * @property {string} [label]            Short UI label.
 * @property {string} [description]      Extended help text.
 * @property {boolean} [optional]        If true, may stay unsatisfied (→ empty value).
 * @property {number} [priority]         Suggested ordering/urgency.
 * @property {string} [group]            Logical grouping (e.g. a form section).
 * @property {Record<string, unknown>} [resolverHints] Hints for the resolver.
 * @property {number} [phase]            Derived by analyze (IMPL §9).
 * @property {unknown[]} [options]       Derived from `type.constraints.values` (IMPL §9).
 */

/**
 * Evaluation environment: the requirements already satisfied in the current state, by id.
 * @typedef {Object} EvalEnv
 * @property {Record<string, import('../runtime/values.js').Value>} resolved
 */

/**
 * Evaluates one expression node in the given environment. Pure, synchronous, no I/O
 * (IMPL §5). Returns one of {@link EvalResult}. v1 placeholder.
 *
 * @param {import('../ast/nodes.js').Expr} _expr
 * @param {EvalEnv} _env
 * @param {import('../index.js').EngineConfig} [_config]
 * @returns {EvalResult}
 */
export function evaluate(_expr, _env, _config) {
  throw new NotImplementedError('eval.evaluate');
}
