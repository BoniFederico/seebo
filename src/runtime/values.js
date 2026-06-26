/**
 * @file Public contract for the runtime value model (IMPL §4, SPEC §1.3).
 * Source of truth for `Value`, type names, format/constraints shapes, and the typed
 * descriptor produced by builders. No logic here (constructors live in {@link ./index.js}).
 *
 * Principle (SPEC §1.1, #1): every value is typed; stringification happens only at slot
 * emission. A value carries its `format` (how to render) and `constraints` (validity).
 */

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
 * Order of temporal precisions, coarsest → finest (IMPL §4.2). The numeric index is the
 * authority: combining two datetimes keeps the higher rank (`max` over 0..5).
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
 * One of the {@link PRECISION_ORDER} values.
 * @typedef {'year'|'month'|'day'|'hour'|'minute'|'second'} Precision
 */

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

/* ----------------------------------------------------------------------------------- *
 * Format shapes (defaults per type, SPEC §1.3)
 * ----------------------------------------------------------------------------------- */

/** @typedef {Object} IntFormat @property {string} [thousands] Thousands separator. */
/**
 * @typedef {Object} FloatFormat
 * @property {string} [decimalSep] Decimal separator (default ',').
 * @property {string} [thousands]  Thousands separator.
 */
/**
 * @typedef {Object} BoolFormat
 * @property {string} [trueLabel]
 * @property {string} [falseLabel]
 */
/** @typedef {Object} DatetimeFormat @property {string} [pattern] e.g. 'YYYY-MM-DDTHH:mm:ssZ'. */
/** @typedef {Object} DurationFormat @property {string} [pattern] e.g. 'HH:mm:ss'. */

/* ----------------------------------------------------------------------------------- *
 * Constraints shapes (defaults per type, SPEC §1.3)
 * ----------------------------------------------------------------------------------- */

/**
 * @typedef {Object} IntConstraints
 * @property {number} [min]
 * @property {number} [max]
 */
/**
 * @typedef {Object} FloatConstraints
 * @property {number} [min]
 * @property {number} [max]
 * @property {number} [precision] Number of decimals (single source of truth, SPEC §1.3).
 */
/**
 * @typedef {Object} StringConstraints
 * @property {number} [minLen]
 * @property {number} [maxLen]
 */
/**
 * @typedef {Object} TemporalConstraints
 * @property {unknown} [min]
 * @property {unknown} [max]
 * @property {Precision} [precision]
 */
/**
 * @typedef {Object} ArrayConstraints
 * @property {number} [minLen]
 * @property {number} [maxLen]
 * @property {unknown[]} [values] Allowed element set; basis for choice lists (SPEC §1.7).
 */

/* ----------------------------------------------------------------------------------- *
 * Value and typed descriptor
 * ----------------------------------------------------------------------------------- */

/**
 * Value: the immutable typed record flowing through evaluation (IMPL §4).
 *
 * Internal canonical representation of `value` per type (IMPL §4.1):
 *  - datetime: epoch milliseconds UTC (number) + a `precision` carried in constraints;
 *  - duration: number of seconds (number, possibly fractional);
 *  - object/array: plain JSON JS, converted to typed Values on access (clarifications §7).
 *
 * @typedef {Object} Value
 * @property {string} type        One of {@link TypeName}.
 * @property {unknown} value       Internal canonical representation.
 * @property {Record<string, unknown>} format       How it stringifies.
 * @property {Record<string, unknown>} constraints  Validity rules.
 */

/**
 * Typed descriptor produced by builders: `{ type, format, constraints, default? }`
 * (SPEC §1.7). This is what `var`/`require` receive as their `type`. `default` is a
 * top-level field, NOT inside `constraints` (SPEC §1.7).
 *
 * @typedef {Object} TypeDescriptor
 * @property {string} type
 * @property {Record<string, unknown>} [format]
 * @property {Record<string, unknown>} [constraints]
 * @property {unknown} [default]
 */

/**
 * Immutable type builder (clarifications §8). `string()`, `int()`, `array()`, ... return
 * one of these; the fluent methods return NEW builders without mutation. Calling the
 * constructor WITH a value (`int(123)`) produces a {@link Value} instead of a builder.
 *
 * @typedef {Object} TypeBuilder
 * @property {string} type
 * @property {(format: Record<string, unknown>) => TypeBuilder} format
 * @property {(constraints: Record<string, unknown>) => TypeBuilder} constraints
 * @property {(value: unknown) => TypeBuilder} default
 * @property {() => TypeDescriptor} toDescriptor Materializes the descriptor.
 */
