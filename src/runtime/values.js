/**
 * @file Runtime value/type system (IMPL §4, SPEC §1.3). Internal representation + the
 * factory/conversion/comparison API.
 *
 * Internal representation: every value is an immutable, deeply-frozen record
 * `{ type, value, format, constraints }`. Canonical `value` per type (IMPL §4.1):
 *  - int/float → JS number; bool → boolean; string → string;
 *  - datetime → epoch milliseconds UTC (integer), with granularity in `constraints.precision`;
 *  - duration → number of seconds (possibly fractional/negative);
 *  - object/array → sanitized plain JSON (clarifications §7).
 *
 * External API (this module + {@link ./index.js}): `make*` factories, {@link fromJs}
 * inference, {@link toText} (via {@link ./stringify.js}), {@link equals}/{@link compare},
 * {@link validate} (constraints), member/index access, serialization, and the immutable
 * builder ({@link makeTypeConstructor}).
 *
 * Security: object/array inputs are deep-sanitized ({@link ./sanitize.js}) — `__proto__`
 * is dropped, non-plain/non-finite/cyclic inputs are rejected, and depth/size are bounded.
 */

import { SeeboError, DiagnosticCode, createDiagnostic } from '../util/errors.js';
import { sanitizeJson, VALUE_LIMITS } from './sanitize.js';

export { VALUE_LIMITS };

/* ----------------------------------------------------------------------------------- *
 * Constants (SPEC §1.3, IMPL §4)
 * ----------------------------------------------------------------------------------- */

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
 * Temporal precisions, coarsest → finest (IMPL §4.2).
 * @type {ReadonlyArray<string>}
 */
export const PRECISION_ORDER = Object.freeze(['year', 'month', 'day', 'hour', 'minute', 'second']);

/**
 * Conversion factors (seconds) for the allowed duration units (IMPL §4.1).
 * @type {Readonly<Record<string, number>>}
 */
export const DURATION_UNITS = Object.freeze({
  second: 1,
  minute: 60,
  hour: 3600,
  day: 86400,
  week: 604800,
});

/** Default `format` per type (SPEC §1.3). @type {Readonly<Record<string, object>>} */
export const DEFAULT_FORMATS = Object.freeze({
  int: { thousands: '' },
  float: { decimalSep: ',', thousands: '' },
  bool: { trueLabel: 'true', falseLabel: 'false' },
  string: {},
  datetime: { pattern: 'YYYY-MM-DDTHH:mm:ssZ' },
  duration: { pattern: 'HH:mm:ss' },
  object: {},
  array: {},
});

/** Default `constraints` per type (SPEC §1.3). @type {Readonly<Record<string, object>>} */
export const DEFAULT_CONSTRAINTS = Object.freeze({
  int: {},
  float: { precision: 2 },
  bool: {},
  string: {},
  datetime: { precision: 'second' },
  duration: { precision: 'second' },
  object: {},
  array: { minLen: 0 },
});

const TYPE_SET = new Set(Object.values(TypeName));

/* ----------------------------------------------------------------------------------- *
 * Typedefs (contract)
 * ----------------------------------------------------------------------------------- */

/**
 * @typedef {'year'|'month'|'day'|'hour'|'minute'|'second'} Precision
 */

/**
 * Value: the immutable typed record flowing through evaluation (IMPL §4).
 * @typedef {Object} Value
 * @property {string} type        One of {@link TypeName}.
 * @property {unknown} value       Internal canonical representation.
 * @property {Record<string, unknown>} format       How it stringifies.
 * @property {Record<string, unknown>} constraints  Validity rules.
 */

/**
 * Typed descriptor produced by builders: `{ type, format, constraints, default? }`
 * (SPEC §1.7). `default` is a top-level field, NOT inside `constraints`.
 * @typedef {Object} TypeDescriptor
 * @property {string} type
 * @property {Record<string, unknown>} [format]
 * @property {Record<string, unknown>} [constraints]
 * @property {unknown} [default]
 */

/**
 * Immutable type builder (clarifications §8). Fluent methods return NEW builders.
 * @typedef {Object} TypeBuilder
 * @property {string} type
 * @property {(format: Record<string, unknown>) => TypeBuilder} format
 * @property {(constraints: Record<string, unknown>) => TypeBuilder} constraints
 * @property {(value: unknown) => TypeBuilder} default
 * @property {() => TypeDescriptor} toDescriptor
 */

/* ----------------------------------------------------------------------------------- *
 * Internal helpers
 * ----------------------------------------------------------------------------------- */

/** @param {string} message */
function typeError(message) {
  return new SeeboError(message, { code: DiagnosticCode.TYPE_ERROR_RUNTIME });
}

/** @param {string} type */
function assertKnownType(type) {
  if (!TYPE_SET.has(type)) throw typeError(`unknown type '${String(type)}'`);
}

/**
 * Deep-freezes a JSON-only structure for true immutability.
 * @template T
 * @param {T} v
 * @returns {T}
 */
function deepFreeze(v) {
  if (Array.isArray(v)) {
    v.forEach(deepFreeze);
    return Object.freeze(v);
  }
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) deepFreeze(/** @type {Record<string, unknown>} */ (v)[k]);
    return Object.freeze(v);
  }
  return v;
}

/**
 * Sanitizes a user-supplied `format`/`constraints` object (drops `__proto__`, bounds it).
 * @param {unknown} obj
 * @returns {Record<string, unknown>}
 */
function sanitizeOptions(obj) {
  if (obj === undefined || obj === null) return {};
  if (typeof obj !== 'object' || Array.isArray(obj)) {
    throw typeError('format/constraints must be a plain object');
  }
  return /** @type {Record<string, unknown>} */ (sanitizeJson(obj));
}

/**
 * Builds an immutable, deeply-frozen value record with type defaults merged in.
 * @param {string} type
 * @param {unknown} value
 * @param {{ format?: unknown, constraints?: unknown }} [opts]
 * @returns {Value}
 */
function makeValue(type, value, opts = {}) {
  const format = deepFreeze({ ...DEFAULT_FORMATS[type], ...sanitizeOptions(opts.format) });
  const constraints = deepFreeze({
    ...DEFAULT_CONSTRAINTS[type],
    ...sanitizeOptions(opts.constraints),
  });
  return Object.freeze({ type, value, format, constraints });
}

/* ----------------------------------------------------------------------------------- *
 * Factories (constructors from canonical JS inputs)
 * ----------------------------------------------------------------------------------- */

/** @param {number} n @param {{ format?: unknown, constraints?: unknown }} [opts] @returns {Value} */
export function makeInt(n, opts) {
  if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n)) {
    throw typeError(`int requires an integer number, got ${describe(n)}`);
  }
  return makeValue('int', n, opts);
}

/** @param {number} n @param {{ format?: unknown, constraints?: unknown }} [opts] @returns {Value} */
export function makeFloat(n, opts) {
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw typeError(`float requires a finite number, got ${describe(n)}`);
  }
  return makeValue('float', n, opts);
}

/** @param {boolean} b @param {{ format?: unknown, constraints?: unknown }} [opts] @returns {Value} */
export function makeBool(b, opts) {
  if (typeof b !== 'boolean') throw typeError(`bool requires a boolean, got ${describe(b)}`);
  return makeValue('bool', b, opts);
}

/** @param {string} s @param {{ format?: unknown, constraints?: unknown }} [opts] @returns {Value} */
export function makeString(s, opts) {
  if (typeof s !== 'string') throw typeError(`string requires a string, got ${describe(s)}`);
  return makeValue('string', s, opts);
}

/** @param {number} seconds @param {{ format?: unknown, constraints?: unknown }} [opts] @returns {Value} */
export function makeDuration(seconds, opts) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
    throw typeError(`duration requires a finite number of seconds, got ${describe(seconds)}`);
  }
  return makeValue('duration', seconds, opts);
}

/** @param {number} epochMs @param {{ format?: unknown, constraints?: unknown }} [opts] @returns {Value} */
export function makeDatetime(epochMs, opts) {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) {
    throw typeError(`datetime requires a finite epoch-ms number, got ${describe(epochMs)}`);
  }
  return makeValue('datetime', Math.trunc(epochMs), opts);
}

/** @param {unknown} json @param {{ format?: unknown, constraints?: unknown }} [opts] @returns {Value} */
export function makeObject(json, opts) {
  const clean = sanitizeJson(json);
  if (clean === null || typeof clean !== 'object' || Array.isArray(clean)) {
    throw typeError(`object requires a plain object, got ${describe(json)}`);
  }
  return makeValue('object', deepFreeze(clean), opts);
}

/** @param {unknown} items @param {{ format?: unknown, constraints?: unknown }} [opts] @returns {Value} */
export function makeArray(items, opts) {
  const clean = sanitizeJson(items);
  if (!Array.isArray(clean)) throw typeError(`array requires an array, got ${describe(items)}`);
  return makeValue('array', deepFreeze(clean), opts);
}

/* ----------------------------------------------------------------------------------- *
 * Guards and inference
 * ----------------------------------------------------------------------------------- */

/** @param {unknown} x @returns {x is Value} */
export function isValue(x) {
  return (
    !!x &&
    typeof x === 'object' &&
    typeof (/** @type {any} */ (x).type) === 'string' &&
    TYPE_SET.has(/** @type {any} */ (x).type) &&
    'value' in /** @type {any} */ (x) &&
    'format' in /** @type {any} */ (x) &&
    'constraints' in /** @type {any} */ (x)
  );
}

/** @param {Value} v @returns {boolean} */
export function isNumeric(v) {
  return v.type === 'int' || v.type === 'float';
}

/** @param {unknown} x @returns {Value} */
function ensureValue(x) {
  if (!isValue(x)) throw typeError(`expected a Seebo value, got ${describe(x)}`);
  return x;
}

/**
 * Infers a typed value from a plain JS input (clarifications §7). A `Date` becomes a
 * `datetime` (internal-only); strings are NOT parsed as datetimes. `null`/`undefined`
 * and non-JSON inputs are rejected. An existing {@link Value} is returned unchanged.
 *
 * @param {unknown} input
 * @returns {Value}
 */
export function fromJs(input) {
  if (isValue(input)) return input;
  if (input === null || input === undefined) {
    throw typeError('cannot infer a value from null/undefined');
  }
  const t = typeof input;
  if (t === 'boolean') return makeBool(/** @type {boolean} */ (input));
  if (t === 'number') {
    const n = /** @type {number} */ (input);
    if (!Number.isFinite(n)) throw typeError('cannot infer a value from a non-finite number');
    return Number.isInteger(n) ? makeInt(n) : makeFloat(n);
  }
  if (t === 'string') return makeString(/** @type {string} */ (input));
  if (input instanceof Date) return makeDatetime(input.getTime());
  if (Array.isArray(input)) return makeArray(input);
  if (t === 'object') return makeObject(input);
  throw typeError(`cannot infer a value from '${t}'`);
}

/* ----------------------------------------------------------------------------------- *
 * Equality and comparison (SPEC §1.4)
 * ----------------------------------------------------------------------------------- */

/**
 * Structural equality for `==`/`!=` (SPEC §1.4: only between equal types). Comparing
 * different types is a type error.
 * @param {Value} a @param {Value} b @returns {boolean}
 */
export function equals(a, b) {
  ensureValue(a);
  ensureValue(b);
  if (a.type !== b.type) {
    throw typeError(`cannot compare equality of '${a.type}' and '${b.type}'`);
  }
  if (a.type === 'object' || a.type === 'array') return jsonEqual(a.value, b.value);
  return a.value === b.value;
}

/**
 * Ordering for `< <= > >=` (SPEC §1.4): numeric pairs (int/float, mixed), datetime pairs,
 * duration pairs. Returns -1, 0 or 1. Other combinations are a type error.
 * @param {Value} a @param {Value} b @returns {-1|0|1}
 */
export function compare(a, b) {
  ensureValue(a);
  ensureValue(b);
  if (isNumeric(a) && isNumeric(b))
    return sign(/** @type {number} */ (a.value) - /** @type {number} */ (b.value));
  if (a.type === 'datetime' && b.type === 'datetime')
    return sign(/** @type {number} */ (a.value) - /** @type {number} */ (b.value));
  if (a.type === 'duration' && b.type === 'duration')
    return sign(/** @type {number} */ (a.value) - /** @type {number} */ (b.value));
  throw typeError(`cannot order '${a.type}' and '${b.type}'`);
}

/** @param {number} d @returns {-1|0|1} */
function sign(d) {
  return d < 0 ? -1 : d > 0 ? 1 : 0;
}

/**
 * Deep equality for sanitized JSON (object/array values).
 * @param {unknown} a @param {unknown} b @returns {boolean}
 */
function jsonEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return (
      ka.length === kb.length &&
      ka.every(
        (k) =>
          Object.prototype.hasOwnProperty.call(b, k) &&
          jsonEqual(/** @type {any} */ (a)[k], /** @type {any} */ (b)[k])
      )
    );
  }
  return false;
}

/* ----------------------------------------------------------------------------------- *
 * Constraint validation (SPEC §1.3 / §1.10)
 * ----------------------------------------------------------------------------------- */

/**
 * Checks a value against its own constraints. Returns a `CONSTRAINT_VIOLATION` diagnostic,
 * or `null` when valid.
 * @param {Value} value
 * @returns {import('../util/errors.js').Diagnostic | null}
 */
export function validate(value) {
  ensureValue(value);
  const c = value.constraints ?? {};
  switch (value.type) {
    case 'int':
    case 'float':
    case 'datetime':
    case 'duration':
      return checkRange(/** @type {number} */ (value.value), c);
    case 'string':
      return checkLength(/** @type {string} */ (value.value).length, c);
    case 'array': {
      const arr = /** @type {unknown[]} */ (value.value);
      const lenDiag = checkLength(arr.length, c);
      if (lenDiag) return lenDiag;
      if (Array.isArray(c.values)) {
        for (const el of arr) {
          if (!c.values.some((allowed) => jsonEqual(allowed, el))) {
            return violation('values', el);
          }
        }
      }
      return null;
    }
    default:
      return null;
  }
}

/** @param {number} n @param {Record<string, unknown>} c */
function checkRange(n, c) {
  const min = numOf(c.min);
  const max = numOf(c.max);
  if (min !== undefined && n < min) return violation('min', n);
  if (max !== undefined && n > max) return violation('max', n);
  return null;
}

/** @param {number} len @param {Record<string, unknown>} c */
function checkLength(len, c) {
  if (typeof c.minLen === 'number' && len < c.minLen) return violation('minLen', len);
  if (typeof c.maxLen === 'number' && len > c.maxLen) return violation('maxLen', len);
  return null;
}

/** @param {unknown} x @returns {number | undefined} */
function numOf(x) {
  if (typeof x === 'number' && Number.isFinite(x)) return x;
  if (isValue(x) && typeof x.value === 'number') return x.value;
  return undefined;
}

/** @param {string} constraint @param {unknown} got */
function violation(constraint, got) {
  return createDiagnostic(DiagnosticCode.CONSTRAINT_VIOLATION, {
    severity: 'error',
    phase: 'run',
    recoverable: false,
    message: `constraint '${constraint}' violated`,
    data: { constraint, got },
  });
}

/* ----------------------------------------------------------------------------------- *
 * Member / index access (clarifications §7) — convert JSON to typed values on access.
 * ----------------------------------------------------------------------------------- */

/**
 * Reads `key` from an object value, returning a typed value (prototype-pollution safe).
 * @param {Value} value @param {string} key @returns {Value}
 */
export function objectGet(value, key) {
  if (value.type !== 'object') throw typeError(`cannot read a member of '${value.type}'`);
  if (typeof key !== 'string') throw typeError('object key must be a string');
  const obj = /** @type {Record<string, unknown>} */ (value.value);
  if (key === '__proto__' || !Object.prototype.hasOwnProperty.call(obj, key)) {
    throw typeError(`missing object key '${key}'`);
  }
  return fromJs(obj[key]);
}

/**
 * Reads index `i` from an array value, returning a typed value.
 * @param {Value} value @param {number} i @returns {Value}
 */
export function arrayGet(value, i) {
  if (value.type !== 'array') throw typeError(`cannot index '${value.type}'`);
  const arr = /** @type {unknown[]} */ (value.value);
  if (!Number.isInteger(i) || i < 0 || i >= arr.length) {
    throw typeError(`array index ${describe(i)} out of bounds`);
  }
  return fromJs(arr[i]);
}

/* ----------------------------------------------------------------------------------- *
 * Serialization (the value record is already a serializable POJO, IMPL §6.1)
 * ----------------------------------------------------------------------------------- */

/**
 * Returns a plain, JSON-safe snapshot of a value (defensive deep copy of object/array).
 * @param {Value} value @returns {Value}
 */
export function serialize(value) {
  ensureValue(value);
  const out = {
    type: value.type,
    value: value.value,
    format: value.format,
    constraints: value.constraints,
  };
  if (value.type === 'object' || value.type === 'array') {
    out.value = sanitizeJson(value.value);
  }
  return out;
}

/**
 * Rebuilds a value from an untrusted serialized snapshot, re-validating shape and
 * re-applying type defaults/sanitization.
 * @param {unknown} obj @returns {Value}
 */
export function deserialize(obj) {
  if (!obj || typeof obj !== 'object') throw typeError('cannot deserialize: not an object');
  const rec = /** @type {Record<string, unknown>} */ (obj);
  const type = rec.type;
  if (typeof type !== 'string' || !TYPE_SET.has(type)) {
    throw typeError(`cannot deserialize: unknown type '${String(type)}'`);
  }
  return construct(type, rec.value, { format: rec.format, constraints: rec.constraints });
}

/* ----------------------------------------------------------------------------------- *
 * Builders and the dual-semantics constructor (clarifications §8)
 * ----------------------------------------------------------------------------------- */

/**
 * Creates an immutable type builder. `string()`, `int()`, ... return one of these; the
 * fluent methods return NEW builders without mutation (clarifications §8).
 * @param {string} type
 * @returns {TypeBuilder}
 */
export function builder(type) {
  assertKnownType(type);
  /** @param {{ format: object, constraints: object, hasDefault: boolean, default?: unknown }} state */
  function make(state) {
    return Object.freeze({
      type,
      /** @param {Record<string, unknown>} f */
      format: (f) => make({ ...state, format: { ...state.format, ...sanitizeOptions(f) } }),
      /** @param {Record<string, unknown>} c */
      constraints: (c) =>
        make({ ...state, constraints: { ...state.constraints, ...sanitizeOptions(c) } }),
      /** @param {unknown} d */
      default: (d) => make({ ...state, hasDefault: true, default: d }),
      toDescriptor: () => {
        /** @type {TypeDescriptor} */
        const desc = {
          type,
          format: deepFreeze({ ...DEFAULT_FORMATS[type], ...state.format }),
          constraints: deepFreeze({ ...DEFAULT_CONSTRAINTS[type], ...state.constraints }),
        };
        if (state.hasDefault) desc.default = state.default;
        return Object.freeze(desc);
      },
    });
  }
  return make({ format: {}, constraints: {}, hasDefault: false });
}

/**
 * Dual-semantics constructor (clarifications §8): with no value it returns a builder,
 * with a value it produces a {@link Value}.
 * @param {string} type
 * @param {unknown} [value]
 * @returns {Value | TypeBuilder}
 */
export function makeTypeConstructor(type, value) {
  assertKnownType(type);
  if (arguments.length < 2 || value === undefined) return builder(type);
  return construct(type, value);
}

/**
 * @param {string} type
 * @param {unknown} value
 * @param {{ format?: unknown, constraints?: unknown }} [opts]
 * @returns {Value}
 */
function construct(type, value, opts) {
  switch (type) {
    case 'int':
      return makeInt(/** @type {number} */ (value), opts);
    case 'float':
      return makeFloat(/** @type {number} */ (value), opts);
    case 'bool':
      return makeBool(/** @type {boolean} */ (value), opts);
    case 'string':
      return makeString(/** @type {string} */ (value), opts);
    case 'datetime':
      return makeDatetime(/** @type {number} */ (value), opts);
    case 'duration':
      return makeDuration(/** @type {number} */ (value), opts);
    case 'object':
      return makeObject(value, opts);
    case 'array':
      return makeArray(value, opts);
    default:
      throw typeError(`unknown type '${type}'`);
  }
}

/** @param {unknown} x Short, safe description of a value for error messages. */
function describe(x) {
  if (x === null) return 'null';
  if (Array.isArray(x)) return 'array';
  const t = typeof x;
  if (t === 'number' || t === 'boolean') return String(x);
  if (t === 'string') return 'string';
  return t;
}
