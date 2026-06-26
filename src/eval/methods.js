/**
 * @file Pure transformer methods (SPEC §1.5): `receiver.name(args)`. Given concrete
 * values, return a value or throw a {@link SeeboError}. No suspension/I/O. A representative
 * core set is implemented; unimplemented methods raise `UNKNOWN_METHOD` (validate will
 * eventually pre-empt these statically).
 */

import {
  makeInt,
  makeFloat,
  makeBool,
  makeString,
  makeArray,
  makeDuration,
  makeDatetime,
  isNumeric,
  objectGet,
  arrayGet,
  withFormat,
  withConstraints,
  validate,
  DURATION_UNITS,
  PRECISION_ORDER,
} from '../runtime/values.js';
import { SeeboError, DiagnosticCode } from '../util/errors.js';

/** @typedef {import('../runtime/values.js').Value} Value */

/**
 * Dispatches a method call on a concrete receiver value (SPEC §1.5).
 *
 * @param {Value} recv  Receiver value (the subject left of the dot).
 * @param {string} name  Method name.
 * @param {Value[]} args  Evaluated argument values.
 * @returns {Value}
 * @throws {SeeboError}  On unknown method, wrong arity, or type error.
 */
export function applyMethod(recv, name, args) {
  // Presentation / constraint builders are available on any value (SPEC §1.5).
  if (name === 'format') return withFormat(recv, asJson(arg(args, 0, name)));
  if (name === 'constraints') {
    // Attaching constraints to a concrete value validates it on the spot: a value that
    // violates its own constraints surfaces as `CONSTRAINT_VIOLATION` in `run` (SPEC §1.10).
    const constrained = withConstraints(recv, asJson(arg(args, 0, name)));
    const diag = validate(constrained);
    if (diag) {
      throw new SeeboError(diag.message, { code: DiagnosticCode.CONSTRAINT_VIOLATION });
    }
    return constrained;
  }

  switch (recv.type) {
    case 'string':
      return stringMethod(recv, name, args);
    case 'array':
      return arrayMethod(recv, name, args);
    case 'int':
    case 'float':
      return numberMethod(recv, name);
    case 'duration':
      return durationMethod(recv, name, args);
    case 'datetime':
      return datetimeMethod(recv, name, args);
    case 'object':
      return objectMethod(recv, name, args);
    default:
      throw unknownMethod(recv.type, name);
  }
}

/* ----------------------------------------------------------------------------------- *
 * string
 * ----------------------------------------------------------------------------------- */

/** @param {Value} recv @param {string} name @param {Value[]} args @returns {Value} */
function stringMethod(recv, name, args) {
  const s = /** @type {string} */ (recv.value);
  switch (name) {
    case 'upper':
      return makeString(s.toUpperCase());
    case 'lower':
      return makeString(s.toLowerCase());
    case 'trim':
      return makeString(s.trim());
    case 'reverse':
      return makeString([...s].reverse().join(''));
    case 'len':
      return makeInt(s.length);
    case 'left':
      return makeString(s.slice(0, intArg(args, 0, name)));
    case 'right':
      return makeString(s.slice(s.length - intArg(args, 0, name)));
    case 'contains':
      return makeBool(s.includes(strArg(args, 0, name)));
    case 'startsWith':
      return makeBool(s.startsWith(strArg(args, 0, name)));
    case 'endsWith':
      return makeBool(s.endsWith(strArg(args, 0, name)));
    case 'remove':
      return makeString(s.split(strArg(args, 0, name)).join(''));
    case 'replace':
      return makeString(s.split(strArg(args, 0, name)).join(strArg(args, 1, name)));
    default:
      throw unknownMethod('string', name);
  }
}

/* ----------------------------------------------------------------------------------- *
 * array
 * ----------------------------------------------------------------------------------- */

/** @param {Value} recv @param {string} name @param {Value[]} args @returns {Value} */
function arrayMethod(recv, name, args) {
  const arr = /** @type {unknown[]} */ (recv.value);
  switch (name) {
    case 'len':
      return makeInt(arr.length);
    case 'first':
      return arrayGet(recv, 0);
    case 'last':
      return arrayGet(recv, arr.length - 1);
    case 'get':
      return arrayGet(recv, intArg(args, 0, name));
    case 'reverse':
      return makeArray([...arr].reverse());
    case 'min':
      return numericReduce(arr, name, (xs) => Math.min(...xs));
    case 'max':
      return numericReduce(arr, name, (xs) => Math.max(...xs));
    case 'sum':
      return numericReduce(arr, name, (xs) => xs.reduce((a, b) => a + b, 0), true);
    case 'avg': {
      if (arr.length === 0) throw typeErr('avg of empty array');
      const nums = numbers(arr, name);
      return makeFloat(nums.reduce((a, b) => a + b, 0) / nums.length);
    }
    default:
      throw unknownMethod('array', name);
  }
}

/**
 * Reduces a numeric array to a single value, keeping `int` when all inputs are integers.
 *
 * @param {unknown[]} arr
 * @param {string} name  Method name (for error messages).
 * @param {(xs: number[]) => number} fn  Reducer over the numeric elements.
 * @param {boolean} [allowEmpty=false]  When true, an empty array yields `int(0)`.
 * @returns {Value}
 */
function numericReduce(arr, name, fn, allowEmpty = false) {
  if (arr.length === 0) {
    if (allowEmpty) return makeInt(0);
    throw typeErr(`${name} of empty array`);
  }
  const nums = numbers(arr, name);
  const allInt = nums.every((n) => Number.isInteger(n));
  const result = fn(nums);
  return allInt && Number.isInteger(result) ? makeInt(result) : makeFloat(result);
}

/** @param {unknown[]} arr @param {string} name @returns {number[]} */
function numbers(arr, name) {
  return arr.map((el) => {
    if (typeof el !== 'number' || !Number.isFinite(el)) {
      throw typeErr(`${name} requires a numeric array`);
    }
    return el;
  });
}

/* ----------------------------------------------------------------------------------- *
 * int / float
 * ----------------------------------------------------------------------------------- */

/** @param {Value} recv @param {string} name @returns {Value} */
function numberMethod(recv, name) {
  const n = /** @type {number} */ (recv.value);
  switch (name) {
    case 'abs':
      return recv.type === 'int' ? makeInt(Math.abs(n)) : makeFloat(Math.abs(n));
    case 'round':
      return makeInt(Math.round(n));
    case 'floor':
      return makeInt(Math.floor(n));
    case 'ceil':
      return makeInt(Math.ceil(n));
    default:
      throw unknownMethod(recv.type, name);
  }
}

/* ----------------------------------------------------------------------------------- *
 * duration (IMPL §4.3)
 * ----------------------------------------------------------------------------------- */

/** @param {Value} recv @param {string} name @param {Value[]} args @returns {Value} */
function durationMethod(recv, name, args) {
  const sec = /** @type {number} */ (recv.value);
  switch (name) {
    case 'totalSeconds':
      return total(sec / DURATION_UNITS.second);
    case 'totalMinutes':
      return total(sec / DURATION_UNITS.minute);
    case 'totalHours':
      return total(sec / DURATION_UNITS.hour);
    case 'totalDays':
      return total(sec / DURATION_UNITS.day);
    case 'totalWeeks':
      return total(sec / DURATION_UNITS.week);
    case 'weeks':
      return makeInt(component(sec, 'week'));
    case 'days':
      return makeInt(component(sec, 'day'));
    case 'hours':
      return makeInt(component(sec, 'hour'));
    case 'minutes':
      return makeInt(component(sec, 'minute'));
    case 'seconds':
      return makeInt(component(sec, 'second'));
    case 'abs':
      return makeDuration(Math.abs(sec));
    case 'neg':
      return makeDuration(-sec);
    case 'isNegative':
      return makeBool(sec < 0);
    case 'round':
      return makeDuration(roundTo(sec, unitArg(args, 0, name)));
    case 'truncate':
      return makeDuration(truncTo(sec, unitArg(args, 0, name)));
    default:
      throw unknownMethod('duration', name);
  }
}

/**
 * A duration **total** as a float rendered in its natural form (no padding zeros): SPEC §1.5
 * shows `duration(50*3600).totalHours()` as `50`, not `50,00` (IMPL §4.3).
 * @param {number} n @returns {Value}
 */
function total(n) {
  return makeFloat(n, { format: { trimZeros: true } });
}

/**
 * Clock-style component of a duration (IMPL §4.3): the sign is applied only to the
 * highest present unit; lower units are the modular remainder of the absolute value.
 *
 * @param {number} sec  Total seconds (signed).
 * @param {string} unit  One of `week`/`day`/`hour`/`minute`/`second`.
 * @returns {number}
 */
function component(sec, unit) {
  const order = ['week', 'day', 'hour', 'minute', 'second'];
  let r = Math.abs(sec);
  /** @type {Record<string, number>} */
  const comp = {};
  for (const u of order) {
    comp[u] = Math.floor(r / DURATION_UNITS[u]);
    r %= DURATION_UNITS[u];
  }
  // Sign on the highest non-zero component.
  if (sec < 0) {
    const highest = order.find((u) => comp[u] !== 0);
    if (highest === unit) return -comp[unit];
  }
  return comp[unit];
}

/** @param {number} sec @param {string} unit @returns {number} */
function roundTo(sec, unit) {
  const f = DURATION_UNITS[unit] ?? 1;
  return Math.round(sec / f) * f;
}

/** @param {number} sec @param {string} unit @returns {number} */
function truncTo(sec, unit) {
  const f = DURATION_UNITS[unit] ?? 1;
  return Math.trunc(sec / f) * f;
}

/* ----------------------------------------------------------------------------------- *
 * datetime (IMPL §4.1)
 * ----------------------------------------------------------------------------------- */

/** @param {Value} recv @param {string} name @param {Value[]} args @returns {Value} */
function datetimeMethod(recv, name, args) {
  const epochMs = /** @type {number} */ (recv.value);
  const d = new Date(epochMs);
  switch (name) {
    case 'year':
      return makeInt(d.getUTCFullYear());
    case 'month':
      return makeInt(d.getUTCMonth() + 1);
    case 'day':
      return makeInt(d.getUTCDate());
    case 'hour':
      return makeInt(d.getUTCHours());
    case 'minute':
      return makeInt(d.getUTCMinutes());
    case 'second':
      return makeInt(d.getUTCSeconds());
    case 'truncate':
      return truncateDatetime(d, precisionArg(args, 0, name));
    case 'add':
      return makeDatetime(epochMs + durationSecArg(args, 0, name) * 1000);
    case 'sub':
      return makeDatetime(epochMs - durationSecArg(args, 0, name) * 1000);
    default:
      throw unknownMethod('datetime', name);
  }
}

/**
 * Truncates a datetime to the given calendar precision in UTC (SPEC §1.5 `d.truncate`).
 * The resulting value records its coarser granularity in `constraints.precision`.
 * @param {Date} d  Source instant.
 * @param {string} unit  One of {@link PRECISION_ORDER}.
 * @returns {Value}
 */
function truncateDatetime(d, unit) {
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth();
  const day = d.getUTCDate();
  const h = d.getUTCHours();
  const mi = d.getUTCMinutes();
  const s = d.getUTCSeconds();
  /** @type {Record<string, number>} */
  const ms = {
    year: Date.UTC(y, 0, 1),
    month: Date.UTC(y, mo, 1),
    day: Date.UTC(y, mo, day),
    hour: Date.UTC(y, mo, day, h),
    minute: Date.UTC(y, mo, day, h, mi),
    second: Date.UTC(y, mo, day, h, mi, s),
  };
  return makeDatetime(ms[unit], { constraints: { precision: unit } });
}

/* ----------------------------------------------------------------------------------- *
 * object
 * ----------------------------------------------------------------------------------- */

/** @param {Value} recv @param {string} name @param {Value[]} args @returns {Value} */
function objectMethod(recv, name, args) {
  switch (name) {
    case 'get':
      return objectGet(recv, strArg(args, 0, name));
    case 'keys':
      return makeArray(Object.keys(/** @type {object} */ (recv.value)));
    case 'values':
      return makeArray(Object.values(/** @type {object} */ (recv.value)));
    default:
      throw unknownMethod('object', name);
  }
}

/* ----------------------------------------------------------------------------------- *
 * Argument helpers
 * ----------------------------------------------------------------------------------- */

/** Returns the i-th argument or throws `ARITY_MISMATCH`. @param {Value[]} args @param {number} i @param {string} name @returns {Value} */
function arg(args, i, name) {
  if (args.length <= i) {
    throw new SeeboError(`'${name}' missing argument ${i + 1}`, {
      code: DiagnosticCode.ARITY_MISMATCH,
    });
  }
  return args[i];
}

/** @param {Value[]} args @param {number} i @param {string} name @returns {string} */
function strArg(args, i, name) {
  const v = arg(args, i, name);
  if (v.type !== 'string') throw typeErr(`'${name}' expects a string argument`);
  return /** @type {string} */ (v.value);
}

/** @param {Value[]} args @param {number} i @param {string} name @returns {number} */
function intArg(args, i, name) {
  const v = arg(args, i, name);
  if (!isNumeric(v)) throw typeErr(`'${name}' expects a numeric argument`);
  return Math.trunc(/** @type {number} */ (v.value));
}

/** @param {Value[]} args @param {number} i @param {string} name @returns {string} */
function unitArg(args, i, name) {
  const u = strArg(args, i, name);
  if (!(u in DURATION_UNITS) && !PRECISION_ORDER.includes(u)) {
    throw typeErr(`'${name}' expects a unit, got '${u}'`);
  }
  return u;
}

/** @param {Value[]} args @param {number} i @param {string} name @returns {string} */
function precisionArg(args, i, name) {
  const u = strArg(args, i, name);
  if (!PRECISION_ORDER.includes(u)) {
    throw typeErr(`'${name}' expects a calendar precision, got '${u}'`);
  }
  return u;
}

/** @param {Value[]} args @param {number} i @param {string} name @returns {number} */
function durationSecArg(args, i, name) {
  const v = arg(args, i, name);
  if (v.type !== 'duration') throw typeErr(`'${name}' expects a duration argument`);
  return /** @type {number} */ (v.value);
}

/** Reads a config-object argument's JSON (for format/constraints). @param {Value} v @returns {Record<string, unknown>} */
function asJson(v) {
  if (v.type !== 'object') throw typeErr('format/constraints expects an object argument');
  return /** @type {Record<string, unknown>} */ (v.value);
}

/** @param {string} msg @returns {SeeboError} */
function typeErr(msg) {
  return new SeeboError(msg, { code: DiagnosticCode.TYPE_ERROR_RUNTIME });
}

/** @param {string} receiverType @param {string} name @returns {SeeboError} */
function unknownMethod(receiverType, name) {
  return new SeeboError(`unknown method '${name}' on ${receiverType}`, {
    code: DiagnosticCode.UNKNOWN_METHOD,
  });
}
