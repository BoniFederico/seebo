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
 * Immutable typed record flowing through evaluation (IMPL §4).
 * Always produced by a `make*` factory or {@link fromJs}; never constructed manually.
 * Deeply frozen — mutating any property is a silent no-op.
 * @typedef {Object} Value
 * @property {string} type  One of {@link TypeName}.
 * @property {unknown} value  Internal canonical JS representation (see IMPL §4.1 for per-type details).
 * @property {Record<string, unknown>} format  Display options, merged from {@link DEFAULT_FORMATS}. Frozen.
 * @property {Record<string, unknown>} constraints  Validity rules, merged from {@link DEFAULT_CONSTRAINTS}. Frozen.
 */

/**
 * Typed descriptor produced by a {@link TypeBuilder}: `{ type, format, constraints, default? }`
 * (SPEC §1.7). `default` is a top-level field, NOT nested inside `constraints`.
 * @typedef {Object} TypeDescriptor
 * @property {string} type  One of {@link TypeName}.
 * @property {Record<string, unknown>} [format]  Display options, merged from {@link DEFAULT_FORMATS}.
 * @property {Record<string, unknown>} [constraints]  Validity rules, merged from {@link DEFAULT_CONSTRAINTS}.
 * @property {unknown} [default]  Default value for the requirement; present only when `.default(d)` was called.
 */

/**
 * Immutable type builder (clarifications §8). Every mutating method returns a NEW builder;
 * the original is unchanged. End the chain with {@link TypeBuilder.toDescriptor} to obtain
 * a {@link TypeDescriptor}.
 * @typedef {Object} TypeBuilder
 * @property {string} type  The base type name this builder targets.
 * @property {(f: Record<string, unknown>) => TypeBuilder} format  Returns a new builder with `f` merged into the format options.
 * @property {(c: Record<string, unknown>) => TypeBuilder} constraints  Returns a new builder with `c` merged into the constraint options.
 * @property {(d: unknown) => TypeBuilder} default  Returns a new builder with a default value set.
 * @property {() => TypeDescriptor} toDescriptor  Finalises and returns a frozen {@link TypeDescriptor}.
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

/**
 * Creates an immutable integer {@link Value}. Deeply frozen.
 * @param {number} n  Must be a finite integer.
 * @param {{ format?: unknown, constraints?: unknown }} [opts]
 * @returns {Value}
 * @throws {import('../util/errors.js').SeeboError}  If `n` is not a finite integer.
 */
export function makeInt(n, opts) {
  if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n)) {
    throw typeError(`int requires an integer number, got ${describe(n)}`);
  }
  return makeValue('int', n, opts);
}

/**
 * Creates an immutable float {@link Value}. Deeply frozen.
 * @param {number} n  Must be a finite number.
 * @param {{ format?: unknown, constraints?: unknown }} [opts]
 * @returns {Value}
 * @throws {import('../util/errors.js').SeeboError}  If `n` is not a finite number.
 */
export function makeFloat(n, opts) {
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw typeError(`float requires a finite number, got ${describe(n)}`);
  }
  return makeValue('float', n, opts);
}

/**
 * Creates an immutable bool {@link Value}. Deeply frozen.
 * @param {boolean} b
 * @param {{ format?: unknown, constraints?: unknown }} [opts]
 * @returns {Value}
 * @throws {import('../util/errors.js').SeeboError}  If `b` is not a boolean.
 */
export function makeBool(b, opts) {
  if (typeof b !== 'boolean') throw typeError(`bool requires a boolean, got ${describe(b)}`);
  return makeValue('bool', b, opts);
}

/**
 * Creates an immutable string {@link Value}. Deeply frozen.
 * @param {string} s
 * @param {{ format?: unknown, constraints?: unknown }} [opts]
 * @returns {Value}
 * @throws {import('../util/errors.js').SeeboError}  If `s` is not a string.
 */
export function makeString(s, opts) {
  if (typeof s !== 'string') throw typeError(`string requires a string, got ${describe(s)}`);
  return makeValue('string', s, opts);
}

/**
 * Creates an immutable duration {@link Value}. Canonical unit is seconds (may be fractional
 * or negative). Deeply frozen.
 * @param {number} seconds  Duration in seconds; must be a finite number.
 * @param {{ format?: unknown, constraints?: unknown }} [opts]
 * @returns {Value}
 * @throws {import('../util/errors.js').SeeboError}  If `seconds` is not a finite number.
 */
export function makeDuration(seconds, opts) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
    throw typeError(`duration requires a finite number of seconds, got ${describe(seconds)}`);
  }
  return makeValue('duration', seconds, opts);
}

/**
 * Creates an immutable datetime {@link Value}. Canonical representation is epoch
 * milliseconds UTC (truncated to integer). Deeply frozen.
 * @param {number} epochMs  Epoch milliseconds UTC; must be a finite number.
 * @param {{ format?: unknown, constraints?: unknown }} [opts]
 * @returns {Value}
 * @throws {import('../util/errors.js').SeeboError}  If `epochMs` is not a finite number.
 */
export function makeDatetime(epochMs, opts) {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) {
    throw typeError(`datetime requires a finite epoch-ms number, got ${describe(epochMs)}`);
  }
  return makeValue('datetime', Math.trunc(epochMs), opts);
}

/**
 * Creates an immutable object {@link Value}. Input is deep-sanitized (see `sanitize.js`):
 * `__proto__` dropped, non-plain/cyclic inputs rejected, depth/size bounded. Deeply frozen.
 * @param {unknown} json  Plain JSON-compatible object.
 * @param {{ format?: unknown, constraints?: unknown }} [opts]
 * @returns {Value}
 * @throws {import('../util/errors.js').SeeboError}  If `json` is not a plain object or fails sanitization.
 */
export function makeObject(json, opts) {
  const clean = sanitizeJson(json);
  if (clean === null || typeof clean !== 'object' || Array.isArray(clean)) {
    throw typeError(`object requires a plain object, got ${describe(json)}`);
  }
  return makeValue('object', deepFreeze(clean), opts);
}

/**
 * Creates an immutable array {@link Value}. Input is deep-sanitized (see `sanitize.js`):
 * non-JSON/cyclic elements rejected, depth/size bounded. Deeply frozen.
 * @param {unknown} items  Array of JSON-compatible items.
 * @param {{ format?: unknown, constraints?: unknown }} [opts]
 * @returns {Value}
 * @throws {import('../util/errors.js').SeeboError}  If `items` is not an array or fails sanitization.
 */
export function makeArray(items, opts) {
  const clean = sanitizeJson(items);
  if (!Array.isArray(clean)) throw typeError(`array requires an array, got ${describe(items)}`);
  return makeValue('array', deepFreeze(clean), opts);
}

/* ----------------------------------------------------------------------------------- *
 * Guards and inference
 * ----------------------------------------------------------------------------------- */

/**
 * Returns `true` if `x` is a well-formed {@link Value} record (the shape `{ type, value,
 * format, constraints }` with a non-empty string `type`). Does not verify that the `type` is
 * a builtin nor that the `value` satisfies type-specific invariants — type membership is a
 * type-specific concern, so a registered custom-type value (SPEC §2.6) is also a Value here.
 * @param {unknown} x
 * @returns {x is Value}
 */
export function isValue(x) {
  return (
    !!x &&
    typeof x === 'object' &&
    typeof (/** @type {any} */ (x).type) === 'string' &&
    /** @type {any} */ (x).type.length > 0 &&
    'value' in /** @type {any} */ (x) &&
    'format' in /** @type {any} */ (x) &&
    'constraints' in /** @type {any} */ (x)
  );
}

/**
 * Creates an immutable value of a **custom** type (SPEC §2.6 `defineType`). The runtime
 * core stays type-agnostic: the value is an ordinary `{ type, value, format, constraints }`
 * record whose `value` is deep-sanitized (pollution-safe, JSON-only). Construction-time
 * validation and stringification are driven by the engine's registered type descriptor, not
 * by this factory.
 * @param {string} type  The custom type name (must not be a builtin type).
 * @param {unknown} value  Plain JSON-compatible payload.
 * @param {{ format?: unknown, constraints?: unknown }} [opts]
 * @returns {Value}
 * @throws {import('../util/errors.js').SeeboError}  If `type` is empty/builtin or the value is not JSON-safe.
 */
export function makeCustom(type, value, opts) {
  if (typeof type !== 'string' || type.length === 0) {
    throw typeError(`custom type requires a non-empty name, got ${describe(type)}`);
  }
  if (TYPE_SET.has(type)) throw typeError(`'${type}' is a builtin type, not a custom one`);
  const clean = sanitizeJson(value);
  const frozen = clean !== null && typeof clean === 'object' ? deepFreeze(clean) : clean;
  return makeValue(type, frozen, opts);
}

/**
 * Returns `true` when `v` has type `'int'` or `'float'`.
 * @param {Value} v
 * @returns {boolean}
 */
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
 * Structural equality for `==`/`!=` (SPEC §1.4). Only defined between values of the same
 * type; comparing different types is a type error.
 * @param {Value} a
 * @param {Value} b
 * @returns {boolean}
 * @throws {import('../util/errors.js').SeeboError}  If `a.type !== b.type`, or if either argument is not a {@link Value}.
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
 * Three-way ordering for `< <= > >=` (SPEC §1.4). Valid between numeric pairs (int/float,
 * mixed), datetime pairs, and duration pairs. Returns `-1`, `0`, or `1`.
 * @param {Value} a
 * @param {Value} b
 * @returns {-1|0|1}
 * @throws {import('../util/errors.js').SeeboError}  If the type combination is not orderable, or if either argument is not a {@link Value}.
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
 * Returns a new value with merged `format` (immutable builder, SPEC §1.5 `x.format(...)`).
 * @param {Value} value @param {unknown} format @returns {Value}
 */
export function withFormat(value, format) {
  ensureValue(value);
  return makeValue(value.type, value.value, {
    format: { ...value.format, ...sanitizeOptions(format) },
    constraints: value.constraints,
  });
}

/**
 * Returns a new value with merged `constraints` (immutable, SPEC §1.5 `x.constraints(...)`).
 * @param {Value} value @param {unknown} constraints @returns {Value}
 */
export function withConstraints(value, constraints) {
  ensureValue(value);
  return makeValue(value.type, value.value, {
    format: value.format,
    constraints: { ...value.constraints, ...sanitizeOptions(constraints) },
  });
}

/**
 * The "empty" value of a type (SPEC §1.7 — unsatisfied optional requirement). For
 * string/array/object this is the SPEC «vuoto» (`''`/`[]`/`{}`); other types use their
 * natural zero.
 * @param {string} type
 * @param {{ format?: unknown, constraints?: unknown }} [opts]
 * @returns {Value}
 */
export function emptyValue(type, opts) {
  switch (type) {
    case 'string':
      return makeString('', opts);
    case 'array':
      return makeArray([], opts);
    case 'object':
      return makeObject({}, opts);
    case 'int':
      return makeInt(0, opts);
    case 'float':
      return makeFloat(0, opts);
    case 'bool':
      return makeBool(false, opts);
    case 'duration':
      return makeDuration(0, opts);
    case 'datetime':
      return makeDatetime(0, opts);
    default:
      throw typeError(`no empty value for type '${type}'`);
  }
}

/**
 * Deep equality for sanitized JSON (object/array values).
 * @param {unknown} a @param {unknown} b @returns {boolean}
 */
export function jsonEqual(a, b) {
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
 * Validates a value against its own `constraints` field (SPEC §1.3 / §1.10).
 * Returns a `CONSTRAINT_VIOLATION` {@link import('../util/errors.js').Diagnostic} when a
 * constraint is violated, or `null` when the value is valid.
 * Never throws; constraint failures are returned as diagnostics.
 * @param {Value} value
 * @returns {import('../util/errors.js').Diagnostic | null}
 * @throws {import('../util/errors.js').SeeboError}  If `value` is not a {@link Value}.
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
 * Reads `key` from an object {@link Value}, converting the raw JSON entry to a typed
 * {@link Value} via {@link fromJs}. Prototype-pollution safe: rejects `__proto__` and
 * missing keys.
 * @param {Value} value  Must have `type === 'object'`.
 * @param {string} key  Key to read.
 * @returns {Value}
 * @throws {import('../util/errors.js').SeeboError}  If `value` is not an object value, `key` is not a string, or the key is missing.
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
 * Reads index `i` from an array {@link Value}, converting the element to a typed
 * {@link Value} via {@link fromJs}.
 * @param {Value} value  Must have `type === 'array'`.
 * @param {number} i  Zero-based integer index; must be within bounds.
 * @returns {Value}
 * @throws {import('../util/errors.js').SeeboError}  If `value` is not an array value or `i` is out of bounds.
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
 * Returns a plain, JSON-safe snapshot of a {@link Value} suitable for storage or
 * transmission (IMPL §6.1). Object/array `value` fields are deep-copied defensively.
 * @param {Value} value
 * @returns {Value}
 * @throws {import('../util/errors.js').SeeboError}  If `value` is not a {@link Value}.
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
 * Rebuilds a {@link Value} from an untrusted serialized snapshot (e.g. from storage),
 * re-validating shape and re-applying type defaults and sanitization.
 * @param {unknown} obj  Raw deserialized object (e.g. from `JSON.parse`).
 * @returns {Value}
 * @throws {import('../util/errors.js').SeeboError}  If `obj` is not a valid serialized value or has an unknown type.
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
 * Creates a fresh {@link TypeBuilder} for `type`. The idiomatic starting point when
 * building a {@link TypeDescriptor} programmatically (clarifications §8).
 * @param {string} type  Must be a known {@link TypeName}.
 * @returns {TypeBuilder}
 * @throws {import('../util/errors.js').SeeboError}  If `type` is unknown.
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
