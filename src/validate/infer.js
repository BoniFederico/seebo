/**
 * @file Static type metadata and pure inference helpers for `validate` (SPEC §1.5/§1.10,
 * IMPL §8). This module mirrors the runtime contract of {@link ../eval/methods.js} and
 * {@link ../eval/operators.js} at the type level so `validate` can statically report
 * {@link DiagnosticCode.UNKNOWN_METHOD}, {@link DiagnosticCode.ARITY_MISMATCH} and
 * (statically deducible) {@link DiagnosticCode.TYPE_ERROR}.
 *
 * Design: the inferred-type lattice is the eight base types plus `'unknown'`. Inference is
 * deliberately conservative — anything not provable collapses to `'unknown'`, and any
 * operation involving `'unknown'` yields `'unknown'` and is never reported as an error.
 * This guarantees `validate` only flags violations it can prove, never false positives.
 */

import { BUILTIN_TYPE_NAMES } from '../util/vocabulary.js';

/** The base Seebo type names, also usable as producers/builders (SPEC §1.3/§1.5). */
export const TYPE_NAMES = new Set(BUILTIN_TYPE_NAMES);

/**
 * A statically inferred type: a base type, or `'unknown'` when not provable.
 * @typedef {'int'|'float'|'bool'|'string'|'datetime'|'duration'|'object'|'array'|'unknown'} InferredType
 */

/**
 * A builtin method signature.
 * @typedef {Object} MethodSig
 * @property {number} min  Minimum argument count.
 * @property {number} max  Maximum argument count.
 * @property {ArgClass[]} args  Expected class per positional argument.
 * @property {InferredType|'self'} ret  Return type; `'self'` echoes the receiver type.
 */

/**
 * Argument type classes used for static argument checking.
 * @typedef {'numeric'|'string'|'object'|'duration'|'any'} ArgClass
 */

/** @type {(min: number, max: number, args: ArgClass[], ret: InferredType|'self') => MethodSig} */
const sig = (min, max, args, ret) => ({ min, max, args, ret });

/** Builders available on every value (SPEC §1.5): they echo the receiver type. */
const ANY_METHODS = {
  format: sig(1, 1, ['object'], 'self'),
  constraints: sig(1, 1, ['object'], 'self'),
};

/** Numeric methods shared by `int` and `float` (IMPL §4). `abs` echoes the receiver type. */
const NUMBER_METHODS = {
  abs: sig(0, 0, [], 'self'),
  round: sig(0, 0, [], 'int'),
  floor: sig(0, 0, [], 'int'),
  ceil: sig(0, 0, [], 'int'),
};

/**
 * Builtin transformer signatures per receiver type — the type-level mirror of
 * {@link ../eval/methods.js}. `ANY_METHODS` apply to every type in addition to these.
 * @type {Record<string, Record<string, MethodSig>>}
 */
export const METHODS = {
  string: {
    upper: sig(0, 0, [], 'string'),
    lower: sig(0, 0, [], 'string'),
    trim: sig(0, 0, [], 'string'),
    reverse: sig(0, 0, [], 'string'),
    len: sig(0, 0, [], 'int'),
    left: sig(1, 1, ['numeric'], 'string'),
    right: sig(1, 1, ['numeric'], 'string'),
    contains: sig(1, 1, ['string'], 'bool'),
    startsWith: sig(1, 1, ['string'], 'bool'),
    endsWith: sig(1, 1, ['string'], 'bool'),
    remove: sig(1, 1, ['string'], 'string'),
    replace: sig(2, 2, ['string', 'string'], 'string'),
  },
  array: {
    len: sig(0, 0, [], 'int'),
    first: sig(0, 0, [], 'unknown'),
    last: sig(0, 0, [], 'unknown'),
    get: sig(1, 1, ['numeric'], 'unknown'),
    reverse: sig(0, 0, [], 'array'),
    min: sig(0, 0, [], 'unknown'),
    max: sig(0, 0, [], 'unknown'),
    sum: sig(0, 0, [], 'unknown'),
    avg: sig(0, 0, [], 'float'),
  },
  int: NUMBER_METHODS,
  float: NUMBER_METHODS,
  duration: {
    totalSeconds: sig(0, 0, [], 'float'),
    totalMinutes: sig(0, 0, [], 'float'),
    totalHours: sig(0, 0, [], 'float'),
    totalDays: sig(0, 0, [], 'float'),
    totalWeeks: sig(0, 0, [], 'float'),
    weeks: sig(0, 0, [], 'int'),
    days: sig(0, 0, [], 'int'),
    hours: sig(0, 0, [], 'int'),
    minutes: sig(0, 0, [], 'int'),
    seconds: sig(0, 0, [], 'int'),
    abs: sig(0, 0, [], 'duration'),
    neg: sig(0, 0, [], 'duration'),
    isNegative: sig(0, 0, [], 'bool'),
    round: sig(1, 1, ['string'], 'duration'),
    truncate: sig(1, 1, ['string'], 'duration'),
  },
  datetime: {
    year: sig(0, 0, [], 'int'),
    month: sig(0, 0, [], 'int'),
    day: sig(0, 0, [], 'int'),
    hour: sig(0, 0, [], 'int'),
    minute: sig(0, 0, [], 'int'),
    second: sig(0, 0, [], 'int'),
    truncate: sig(1, 1, ['string'], 'datetime'),
    add: sig(1, 1, ['duration'], 'datetime'),
    sub: sig(1, 1, ['duration'], 'datetime'),
  },
  object: {
    get: sig(1, 1, ['string'], 'unknown'),
    keys: sig(0, 0, [], 'array'),
    values: sig(0, 0, [], 'array'),
  },
  bool: {},
};

/**
 * Builtin producer arities (SPEC §1.5). Type builders accept 0 (builder form) or 1 (value
 * form) argument and return their own type. `need`/`bind` are intentionally absent: their
 * descriptors are checked separately (their arity errors surface as syntax issues).
 * @type {Record<string, { min: number, max: number, args?: ArgClass[], ret: InferredType }>}
 */
export const PRODUCERS = {
  now: { min: 0, max: 0, args: [], ret: 'datetime' },
  date: { min: 2, max: 2, args: ['string', 'string'], ret: 'datetime' },
};

/**
 * Looks up the signature of a builtin method on a known receiver type.
 * @param {string} type  Receiver type (a base type name).
 * @param {string} name  Method name.
 * @returns {MethodSig | undefined}
 */
export function methodSig(type, name) {
  if (name in ANY_METHODS) return /** @type {any} */ (ANY_METHODS)[name];
  const table = METHODS[type];
  return table ? table[name] : undefined;
}

/** @param {InferredType} t @returns {boolean} True when the type is concretely known. */
export function isKnown(t) {
  return t !== 'unknown';
}

/** @param {InferredType} t @returns {boolean} */
function isNumeric(t) {
  return t === 'int' || t === 'float';
}

/**
 * Checks whether an actual argument type satisfies an expected class. `'unknown'` always
 * matches (conservative).
 * @param {ArgClass} expected
 * @param {InferredType} actual
 * @returns {boolean}
 */
export function argMatches(expected, actual) {
  if (actual === 'unknown' || expected === 'any') return true;
  switch (expected) {
    case 'numeric':
      return isNumeric(actual);
    case 'string':
      return actual === 'string';
    case 'object':
      return actual === 'object';
    case 'duration':
      return actual === 'duration';
    default:
      return true;
  }
}

/**
 * Result of an operator type check: a concrete/`unknown` return type, or an error marker.
 * @typedef {{ ret: InferredType } | { error: string }} OpResult
 */

/** @type {(ret: InferredType) => OpResult} */
const okType = (ret) => ({ ret });
/** @type {(message: string) => OpResult} */
const typeError = (message) => ({ error: message });

/**
 * Computes the result type of a binary operator from operand types, mirroring
 * {@link ../eval/operators.js}. Returns an `{ error }` marker only when the violation is
 * provable (both operands concretely typed); any `'unknown'` operand yields `'unknown'`.
 * @param {string} op
 * @param {InferredType} l
 * @param {InferredType} r
 * @returns {OpResult}
 */
export function binaryResult(op, l, r) {
  switch (op) {
    case '==':
    case '!=':
      return okType('bool'); // equality never type-errors (cross-type → false)
    case 'and':
    case 'or':
      if (isKnown(l) && l !== 'bool') return typeError(`'${op}' expects bool, got ${l}`);
      if (isKnown(r) && r !== 'bool') return typeError(`'${op}' expects bool, got ${r}`);
      return okType('bool');
    case '<':
    case '<=':
    case '>':
    case '>=':
      if (!isKnown(l) || !isKnown(r)) return okType('bool');
      if (isNumeric(l) && isNumeric(r)) return okType('bool');
      if (l === 'datetime' && r === 'datetime') return okType('bool');
      if (l === 'duration' && r === 'duration') return okType('bool');
      return typeError(`cannot order '${l}' and '${r}'`);
    case 'in':
      if (isKnown(r) && r !== 'array') return typeError(`'in' expects an array, got ${r}`);
      return okType('bool');
    case '??':
      return okType(l === r ? l : 'unknown');
    case '+':
      return addResult(l, r);
    case '-':
      return subResult(l, r);
    case '*':
      return mulResult(l, r);
    case '/':
      return divResult(l, r);
    default:
      return okType('unknown');
  }
}

/** @param {InferredType} l @param {InferredType} r @returns {OpResult} */
function addResult(l, r) {
  if (!isKnown(l) || !isKnown(r)) return okType('unknown');
  if (l === 'string' && r === 'string') return okType('string');
  if (l === 'string' || r === 'string') {
    return typeError(`no implicit coercion between string and ${l === 'string' ? r : l}`);
  }
  if (l === 'datetime' && r === 'duration') return okType('datetime');
  if (l === 'duration' && r === 'datetime') return okType('datetime');
  if (l === 'duration' && r === 'duration') return okType('duration');
  if (l === 'datetime' && r === 'datetime') return typeError('cannot add two datetimes');
  if (isNumeric(l) && isNumeric(r)) return okType(numResult(l, r));
  return typeError(`'+' on ${l} and ${r}`);
}

/** @param {InferredType} l @param {InferredType} r @returns {OpResult} */
function subResult(l, r) {
  if (!isKnown(l) || !isKnown(r)) return okType('unknown');
  if (l === 'datetime' && r === 'datetime') return okType('duration');
  if (l === 'datetime' && r === 'duration') return okType('datetime');
  if (l === 'duration' && r === 'duration') return okType('duration');
  if (isNumeric(l) && isNumeric(r)) return okType(numResult(l, r));
  return typeError(`'-' on ${l} and ${r}`);
}

/** @param {InferredType} l @param {InferredType} r @returns {OpResult} */
function mulResult(l, r) {
  if (!isKnown(l) || !isKnown(r)) return okType('unknown');
  if (l === 'duration' && isNumeric(r)) return okType('duration');
  if (isNumeric(l) && r === 'duration') return okType('duration');
  if (isNumeric(l) && isNumeric(r)) return okType(numResult(l, r));
  return typeError(`'*' on ${l} and ${r}`);
}

/** @param {InferredType} l @param {InferredType} r @returns {OpResult} */
function divResult(l, r) {
  if (!isKnown(l) || !isKnown(r)) return okType('unknown');
  if (l === 'duration' && isNumeric(r)) return okType('duration');
  if (l === 'duration' && r === 'duration') return okType('float');
  if (isNumeric(l) && isNumeric(r)) return okType('float'); // `/` is always float (SPEC §1.4)
  return typeError(`'/' on ${l} and ${r}`);
}

/** @param {InferredType} l @param {InferredType} r @returns {InferredType} */
function numResult(l, r) {
  return l === 'int' && r === 'int' ? 'int' : 'float';
}

/**
 * Computes the result type of a unary operator, mirroring {@link ../eval/operators.js}.
 * @param {string} op
 * @param {InferredType} t
 * @returns {OpResult}
 */
export function unaryResult(op, t) {
  if (op === 'not') {
    if (isKnown(t) && t !== 'bool') return typeError(`'not' expects bool, got ${t}`);
    return okType('bool');
  }
  if (op === '-') {
    if (!isKnown(t)) return okType('unknown');
    if (t === 'int' || t === 'float' || t === 'duration') return okType(t);
    return typeError(`unary '-' expects int/float/duration, got ${t}`);
  }
  return okType('unknown');
}
