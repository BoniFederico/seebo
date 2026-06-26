/**
 * @file Pure evaluation helpers for operators (SPEC §1.4, IMPL §4.2). No suspension, no
 * environment, no I/O: given concrete {@link import('../runtime/values.js').Value}s they
 * return a Value or throw a {@link SeeboError} (the evaluator turns throws into `Err`).
 */

import {
  makeInt,
  makeFloat,
  makeBool,
  makeString,
  makeDuration,
  makeDatetime,
  isNumeric,
  equals,
  compare,
  jsonEqual,
} from '../runtime/values.js';
import { SeeboError, DiagnosticCode } from '../util/errors.js';

/** @param {string} op @param {string} got */
function typeErr(op, got) {
  return new SeeboError(`type error in '${op}': ${got}`, {
    code: DiagnosticCode.TYPE_ERROR_RUNTIME,
  });
}

/**
 * SPEC §1.4 «vuoto»: `''` / `[]` / `{}` are empty; `0` / `false` / 0-duration are NOT.
 * @param {import('../runtime/values.js').Value} v
 * @returns {boolean}
 */
export function isEmpty(v) {
  if (v.type === 'string') return v.value === '';
  if (v.type === 'array') return /** @type {unknown[]} */ (v.value).length === 0;
  if (v.type === 'object') return Object.keys(/** @type {object} */ (v.value)).length === 0;
  return false;
}

/**
 * Applies a unary prefix operator (SPEC §1.4 level 2).
 * @param {string} op @param {import('../runtime/values.js').Value} v
 * @returns {import('../runtime/values.js').Value}
 */
export function applyUnary(op, v) {
  if (op === 'not') {
    if (v.type !== 'bool') throw typeErr('not', `expected bool, got ${v.type}`);
    return makeBool(!v.value);
  }
  if (op === '-') {
    if (v.type === 'int') return makeInt(-(/** @type {number} */ (v.value)));
    if (v.type === 'float') return makeFloat(-(/** @type {number} */ (v.value)));
    if (v.type === 'duration') return makeDuration(-(/** @type {number} */ (v.value)));
    throw typeErr('-', `expected int/float/duration, got ${v.type}`);
  }
  throw typeErr(op, 'unknown unary operator');
}

/**
 * Applies an infix operator to two concrete values (SPEC §1.4, IMPL §4.2).
 * `and`/`or`/`??` and the ternary are handled lazily by the evaluator, not here.
 * @param {string} op
 * @param {import('../runtime/values.js').Value} a
 * @param {import('../runtime/values.js').Value} b
 * @returns {import('../runtime/values.js').Value}
 */
export function applyBinary(op, a, b) {
  switch (op) {
    case '+':
      return add(a, b);
    case '-':
      return subtract(a, b);
    case '*':
      return multiply(a, b);
    case '/':
      return divide(a, b);
    case '==':
      return makeBool(equals(a, b));
    case '!=':
      return makeBool(!equals(a, b));
    case '<':
      return makeBool(compare(a, b) < 0);
    case '<=':
      return makeBool(compare(a, b) <= 0);
    case '>':
      return makeBool(compare(a, b) > 0);
    case '>=':
      return makeBool(compare(a, b) >= 0);
    case 'in':
      return memberOf(a, b);
    default:
      throw typeErr(op, 'unknown binary operator');
  }
}

/** @param {number} n @param {import('../runtime/values.js').Value} a @param {import('../runtime/values.js').Value} b */
function num(n, a, b) {
  return a.type === 'int' && b.type === 'int' ? makeInt(n) : makeFloat(n);
}

/** @param {import('../runtime/values.js').Value} a @param {import('../runtime/values.js').Value} b @returns {import('../runtime/values.js').Value} */
function add(a, b) {
  if (a.type === 'string' && b.type === 'string') {
    return makeString(/** @type {string} */ (a.value) + /** @type {string} */ (b.value));
  }
  if (a.type === 'string' || b.type === 'string') {
    throw typeErr(
      '+',
      `no implicit coercion between string and ${a.type === 'string' ? b.type : a.type}`
    );
  }
  // temporal (IMPL §4.2)
  if (a.type === 'datetime' && b.type === 'duration') return makeDatetime(num2(a) + num2(b) * 1000);
  if (a.type === 'duration' && b.type === 'datetime') return makeDatetime(num2(b) + num2(a) * 1000);
  if (a.type === 'duration' && b.type === 'duration') return makeDuration(num2(a) + num2(b));
  if (a.type === 'datetime' && b.type === 'datetime')
    throw typeErr('+', 'cannot add two datetimes');
  if (isNumeric(a) && isNumeric(b)) return num(num2(a) + num2(b), a, b);
  throw typeErr('+', `${a.type} + ${b.type}`);
}

/** @param {import('../runtime/values.js').Value} a @param {import('../runtime/values.js').Value} b @returns {import('../runtime/values.js').Value} */
function subtract(a, b) {
  if (a.type === 'datetime' && b.type === 'datetime')
    return makeDuration((num2(a) - num2(b)) / 1000);
  if (a.type === 'datetime' && b.type === 'duration') return makeDatetime(num2(a) - num2(b) * 1000);
  if (a.type === 'duration' && b.type === 'duration') return makeDuration(num2(a) - num2(b));
  if (isNumeric(a) && isNumeric(b)) return num(num2(a) - num2(b), a, b);
  throw typeErr('-', `${a.type} - ${b.type}`);
}

/** @param {import('../runtime/values.js').Value} a @param {import('../runtime/values.js').Value} b @returns {import('../runtime/values.js').Value} */
function multiply(a, b) {
  if (a.type === 'duration' && isNumeric(b)) return makeDuration(num2(a) * num2(b));
  if (isNumeric(a) && b.type === 'duration') return makeDuration(num2(b) * num2(a));
  if (isNumeric(a) && isNumeric(b)) return num(num2(a) * num2(b), a, b);
  throw typeErr('*', `${a.type} * ${b.type}`);
}

/** @param {import('../runtime/values.js').Value} a @param {import('../runtime/values.js').Value} b @returns {import('../runtime/values.js').Value} */
function divide(a, b) {
  if (a.type === 'duration' && isNumeric(b)) {
    if (num2(b) === 0) throw divZero();
    return makeDuration(num2(a) / num2(b));
  }
  if (a.type === 'duration' && b.type === 'duration') {
    if (num2(b) === 0) throw divZero();
    return makeFloat(num2(a) / num2(b)); // dimensionless ratio
  }
  if (isNumeric(a) && isNumeric(b)) {
    if (num2(b) === 0) throw divZero();
    return makeFloat(num2(a) / num2(b)); // `/` is always float (SPEC §1.4)
  }
  throw typeErr('/', `${a.type} / ${b.type}`);
}

/** @param {import('../runtime/values.js').Value} a @param {import('../runtime/values.js').Value} b */
function memberOf(a, b) {
  if (b.type !== 'array') throw typeErr('in', `right operand must be an array, got ${b.type}`);
  const arr = /** @type {unknown[]} */ (b.value);
  return makeBool(arr.some((el) => jsonEqual(el, a.value)));
}

/** @param {import('../runtime/values.js').Value} v */
function num2(v) {
  return /** @type {number} */ (v.value);
}

function divZero() {
  return new SeeboError('division by zero', { code: DiagnosticCode.DIVISION_BY_ZERO });
}
