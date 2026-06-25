/**
 * @file Runtime type system (IMPL §4). A Value is an immutable record
 * `{ type, value, format, constraints }`. Type constructors have **dual semantics**
 * (clarifications §8): `int()` is a *builder*, `int(123)` produces a *Value*.
 * v1 placeholder.
 */

import { NotImplementedError } from '../util/errors.js';

/**
 * Builtin types (SPEC §1.3). Base + composite.
 * @type {Readonly<Record<string, string>>}
 */
export const TypeName = Object.freeze({
  INT: 'int',
  FLOAT: 'float',
  BOOL: 'bool',
  STRING: 'string',
  DATETIME: 'datetime',
  DURATION: 'duration',
  OBJECT: 'object',
  ARRAY: 'array',
});

/**
 * Order of temporal precisions, from coarsest to finest (IMPL §4.2). The index is the
 * authority: combining two datetimes keeps the higher rank.
 * @type {ReadonlyArray<string>}
 */
export const PRECISION_ORDER = Object.freeze([
  'year',
  'month',
  'day',
  'hour',
  'minute',
  'second',
]);

/**
 * Conversion factors (in seconds) of the allowed duration units (IMPL §4.1).
 * Months and years are intentionally excluded (SPEC §1.3).
 * @type {Readonly<Record<string, number>>}
 */
export const DURATION_UNITS = Object.freeze({
  second: 1,
  minute: 60,
  hour: 3600,
  day: 86400,
  week: 604800,
});

/**
 * Value: immutable typed object that flows through evaluation (IMPL §4).
 * @typedef {Object} Value
 * @property {string} type        One of {@link TypeName}.
 * @property {unknown} value       Internal canonical representation (see IMPL §4.1).
 * @property {Record<string, unknown>} format       How it is stringified.
 * @property {Record<string, unknown>} constraints  Validity rules.
 */

/**
 * Typed descriptor produced by builders (`{ type, format, constraints, default? }`,
 * SPEC §1.7). This is what `var`/`require` receive as `type`.
 * @typedef {Object} TypeDescriptor
 * @property {string} type
 * @property {Record<string, unknown>} [format]
 * @property {Record<string, unknown>} [constraints]
 * @property {unknown} [default]
 */

/**
 * Generic dual-semantics constructor (clarifications §8): with no argument it returns an
 * immutable builder, with an argument it produces a {@link Value}. v1 placeholder.
 *
 * @param {string} _typeName One of {@link TypeName}.
 * @param {unknown} [_value] If present ⇒ producer; if absent ⇒ builder.
 * @returns {never}
 */
export function makeTypeConstructor(_typeName, _value) {
  throw new NotImplementedError('runtime.makeTypeConstructor');
}

/**
 * Stringifies a {@link Value} using its `format` and the `locale` (IMPL §4).
 * Happens **only at slot emission** (SPEC §1.1, principle 1). v1 placeholder.
 *
 * @param {Value} _value
 * @param {string} [_locale]
 * @returns {never}
 */
export function stringify(_value, _locale) {
  throw new NotImplementedError('runtime.stringify');
}
