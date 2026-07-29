/**
 * @file Unit — runtime values/types (IMPL §4, SPEC §1.3): factories, stringification,
 * equality/comparison, constraint validation, JSON access, serialization, builders, and
 * security (prototype-pollution / untrusted input). Covers conversions and error cases.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TypeName,
  PRECISION_ORDER,
  DURATION_UNITS,
  makeInt,
  makeFloat,
  makeBool,
  makeString,
  makeDatetime,
  makeDuration,
  makeObject,
  makeArray,
  fromJs,
  isValue,
  isNumeric,
  equals,
  compare,
  validate,
  objectGet,
  arrayGet,
  indexedGet,
  serialize,
  deserialize,
  builder,
  makeTypeConstructor,
} from '../../src/runtime/values.js';
import { stringify } from '../../src/runtime/index.js';
import { SeeboError } from '../../src/util/errors.js';

/* ----------------------------------------------------------------------------------- *
 * Constants (contract)
 * ----------------------------------------------------------------------------------- */

test('TypeName covers base + composite types (SPEC §1.3)', () => {
  assert.deepEqual(Object.values(TypeName).sort(), [
    'array',
    'bool',
    'datetime',
    'duration',
    'float',
    'int',
    'object',
    'string',
  ]);
});

test('PRECISION_ORDER is coarsest→finest; DURATION_UNITS has no months/years', () => {
  assert.deepEqual([...PRECISION_ORDER], ['year', 'month', 'day', 'hour', 'minute', 'second']);
  assert.equal(DURATION_UNITS.week, 604800);
  assert.equal(DURATION_UNITS.month, undefined);
  assert.equal(DURATION_UNITS.year, undefined);
});

/* ----------------------------------------------------------------------------------- *
 * Factories + immutability
 * ----------------------------------------------------------------------------------- */

test('factories build typed, frozen values with type defaults', () => {
  const i = makeInt(5);
  assert.deepEqual(i, { type: 'int', value: 5, format: { thousands: '' }, constraints: {} });
  assert.ok(Object.isFrozen(i) && Object.isFrozen(i.format) && Object.isFrozen(i.constraints));

  assert.equal(makeFloat(1.5).constraints.precision, 2);
  assert.deepEqual(makeBool(true).format, { trueLabel: 'true', falseLabel: 'false' });
  assert.equal(makeDatetime(1000.9).value, 1000); // truncated to integer ms
  assert.equal(makeDuration(-90).value, -90);
});

test('object/array values are deep-sanitized and deeply frozen', () => {
  const o = makeObject({ a: 1, b: { c: [2, 3] } });
  assert.deepEqual(o.value, { a: 1, b: { c: [2, 3] } });
  assert.ok(Object.isFrozen(o.value) && Object.isFrozen(o.value.b) && Object.isFrozen(o.value.b.c));
  assert.deepEqual(makeArray([1, 'x', true]).value, [1, 'x', true]);
});

test('factories reject invalid inputs with a typed error', () => {
  assert.throws(() => makeInt(1.5), SeeboError);
  assert.throws(() => makeInt(/** @type {any} */ ('1')), SeeboError);
  assert.throws(() => makeFloat(Infinity), SeeboError);
  assert.throws(() => makeBool(/** @type {any} */ (1)), SeeboError);
  assert.throws(() => makeString(/** @type {any} */ (5)), SeeboError);
  assert.throws(() => makeObject([1, 2]), SeeboError); // array is not an object
  assert.throws(() => makeArray({ a: 1 }), SeeboError); // object is not an array
});

/* ----------------------------------------------------------------------------------- *
 * Stringification (SPEC §1.3, IMPL §4.3/§4.4)
 * ----------------------------------------------------------------------------------- */

test('int stringify with optional thousands separator', () => {
  assert.equal(stringify(makeInt(1234567)), '1234567');
  assert.equal(stringify(makeInt(1234567, { format: { thousands: '.' } })), '1.234.567');
  assert.equal(stringify(makeInt(-1234, { format: { thousands: ',' } })), '-1,234');
});

test('float stringify honors precision and decimal separator (SPEC §1.3)', () => {
  assert.equal(stringify(makeFloat(1234.5)), '1234,50');
  assert.equal(stringify(makeFloat(1234.3456)), '1234,35'); // rounded to precision 2
  assert.equal(stringify(makeFloat(1234.5, { format: { thousands: '.' } })), '1.234,50');
  assert.equal(stringify(makeFloat(-0.5)), '-0,50');
});

test('bool stringify uses labels', () => {
  assert.equal(stringify(makeBool(true)), 'true');
  assert.equal(stringify(makeBool(false, { format: { falseLabel: 'No' } })), 'No');
});

test('datetime stringify formats the pattern in UTC (clarifications §5)', () => {
  assert.equal(stringify(makeDatetime(0)), '1970-01-01T00:00:00Z');
  const dt = makeDatetime(Date.UTC(2026, 5, 20, 10, 0, 0), { format: { pattern: 'YYYY/MM/DD' } });
  assert.equal(stringify(dt), '2026/06/20');
});

test('duration stringify: leftmost token absorbs overflow; sign prefixes (IMPL §4.4)', () => {
  assert.equal(stringify(makeDuration(50 * 3600)), '50:00:00'); // HH:mm:ss default
  assert.equal(
    stringify(makeDuration(50 * 3600, { format: { pattern: 'D HH:mm:ss' } })),
    '2 02:00:00'
  );
  assert.equal(stringify(makeDuration(-3661)), '-01:01:01');
});

test('object/array stringify as JSON', () => {
  assert.equal(stringify(makeObject({ a: 1 })), '{"a":1}');
  assert.equal(stringify(makeArray([1, 2, 3])), '[1,2,3]');
});

/* ----------------------------------------------------------------------------------- *
 * Inference (clarifications §7)
 * ----------------------------------------------------------------------------------- */

test('fromJs infers types per the v1 table', () => {
  assert.equal(fromJs(3).type, 'int');
  assert.equal(fromJs(3.5).type, 'float');
  assert.equal(fromJs(true).type, 'bool');
  assert.equal(fromJs('x').type, 'string');
  assert.equal(fromJs([1, 2]).type, 'array');
  assert.equal(fromJs({ a: 1 }).type, 'object');
  assert.equal(fromJs(new Date(0)).type, 'datetime'); // Date → datetime (internal only)
});

test('fromJs does NOT parse ISO strings as datetime', () => {
  const v = fromJs('2026-06-20T10:00:00Z');
  assert.equal(v.type, 'string');
});

test('fromJs rejects null/undefined and non-JSON inputs', () => {
  assert.throws(() => fromJs(null), SeeboError);
  assert.throws(() => fromJs(undefined), SeeboError);
  assert.throws(() => fromJs(() => 1), SeeboError);
  assert.throws(() => fromJs(Symbol('x')), SeeboError);
});

test('isValue / isNumeric guards', () => {
  assert.equal(isValue(makeInt(1)), true);
  assert.equal(isValue({ type: 'int' }), false);
  assert.equal(isValue(null), false);
  assert.equal(isNumeric(makeInt(1)), true);
  assert.equal(isNumeric(makeFloat(1)), true);
  assert.equal(isNumeric(makeString('x')), false);
});

/* ----------------------------------------------------------------------------------- *
 * Equality and comparison (SPEC §1.4)
 * ----------------------------------------------------------------------------------- */

test('equals requires the same type (no cross-type equality)', () => {
  assert.equal(equals(makeInt(1), makeInt(1)), true);
  assert.equal(equals(makeInt(1), makeInt(2)), false);
  assert.equal(equals(makeString('a'), makeString('a')), true);
  assert.equal(equals(makeObject({ a: 1 }), makeObject({ a: 1 })), true);
  assert.equal(equals(makeArray([1, 2]), makeArray([1, 2])), true);
  assert.throws(() => equals(makeInt(1), makeFloat(1)), SeeboError); // different types
});

test('compare orders numeric (mixed), datetime and duration pairs', () => {
  assert.equal(compare(makeInt(1), makeFloat(2)), -1);
  assert.equal(compare(makeFloat(2), makeInt(2)), 0);
  assert.equal(compare(makeDatetime(2000), makeDatetime(1000)), 1);
  assert.equal(compare(makeDuration(10), makeDuration(10)), 0);
  assert.throws(() => compare(makeInt(1), makeString('a')), SeeboError);
  assert.throws(() => compare(makeDatetime(1), makeDuration(1)), SeeboError);
});

/* ----------------------------------------------------------------------------------- *
 * Constraint validation (SPEC §1.3 / §1.10)
 * ----------------------------------------------------------------------------------- */

test('validate returns null when valid', () => {
  assert.equal(validate(makeInt(5, { constraints: { min: 0, max: 10 } })), null);
  assert.equal(validate(makeString('abc', { constraints: { minLen: 1, maxLen: 5 } })), null);
});

test('validate reports CONSTRAINT_VIOLATION with data', () => {
  const d1 = validate(makeInt(5, { constraints: { min: 10 } }));
  assert.equal(d1?.code, 'CONSTRAINT_VIOLATION');
  assert.deepEqual(d1?.data, { constraint: 'min', got: 5 });

  assert.equal(
    validate(makeString('ab', { constraints: { minLen: 3 } }))?.data?.constraint,
    'minLen'
  );
  assert.equal(
    validate(makeArray([1, 2, 9], { constraints: { values: [1, 2] } }))?.data?.constraint,
    'values'
  );
  assert.equal(
    validate(makeArray([1], { constraints: { maxLen: 0 } }))?.data?.constraint,
    'maxLen'
  );
});

/* ----------------------------------------------------------------------------------- *
 * Access (clarifications §7)
 * ----------------------------------------------------------------------------------- */

test('objectGet / arrayGet convert JSON to typed values on access', () => {
  const o = makeObject({ name: 'Ada', age: 36, tags: ['x'] });
  assert.deepEqual(objectGet(o, 'name'), makeString('Ada'));
  assert.deepEqual(objectGet(o, 'age'), makeInt(36));
  assert.equal(objectGet(o, 'tags').type, 'array');

  const a = makeArray([10, 20, 30]);
  assert.deepEqual(arrayGet(a, 1), makeInt(20));
});

test('access errors: missing key, __proto__, out of bounds, wrong type', () => {
  const o = makeObject({ a: 1 });
  assert.throws(() => objectGet(o, 'missing'), SeeboError);
  assert.throws(() => objectGet(o, '__proto__'), SeeboError);
  assert.throws(() => objectGet(makeArray([1]), 'a'), SeeboError);
  assert.throws(() => arrayGet(makeArray([1]), 5), SeeboError);
  assert.throws(() => arrayGet(makeArray([1]), -1), SeeboError);
});

test('indexedGet dispatches object[string] / array[int] (bracket member access)', () => {
  const o = makeObject({ 'strange key!': 'Ada', age: 36 });
  assert.deepEqual(indexedGet(o, makeString('strange key!')), makeString('Ada'));
  assert.deepEqual(indexedGet(o, makeString('age')), makeInt(36));

  const a = makeArray([10, 20, 30]);
  assert.deepEqual(indexedGet(a, makeInt(1)), makeInt(20));
});

test('indexedGet errors: wrong key type, non-indexable receiver', () => {
  const o = makeObject({ a: 1 });
  const a = makeArray([1, 2]);
  assert.throws(() => indexedGet(o, makeInt(0)), SeeboError); // object needs a string key
  assert.throws(() => indexedGet(a, makeString('0')), SeeboError); // array needs a numeric index
  assert.throws(() => indexedGet(makeInt(1), makeString('a')), SeeboError); // int is not indexable
});

/* ----------------------------------------------------------------------------------- *
 * Security: prototype pollution / untrusted input
 * ----------------------------------------------------------------------------------- */

test('makeObject drops __proto__ and never pollutes Object.prototype', () => {
  const evil = JSON.parse('{ "a": 1, "__proto__": { "polluted": true } }');
  const v = makeObject(evil);
  assert.deepEqual(v.value, { a: 1 });
  assert.equal(/** @type {any} */ ({}).polluted, undefined);
});

test('sanitization rejects circular and non-plain inputs', () => {
  const cyclic = /** @type {any} */ ({});
  cyclic.self = cyclic;
  assert.throws(() => makeObject(cyclic), SeeboError);
  assert.throws(() => makeObject(new Date()), SeeboError); // not a plain object
});

/* ----------------------------------------------------------------------------------- *
 * Serialization (IMPL §6.1)
 * ----------------------------------------------------------------------------------- */

test('serialize/deserialize round-trips through JSON', () => {
  const v = makeObject({ a: [1, 2], b: 'x' });
  const json = JSON.parse(JSON.stringify(serialize(v)));
  const back = deserialize(json);
  assert.deepEqual(back.value, v.value);
  assert.equal(back.type, 'object');
});

test('deserialize re-sanitizes untrusted snapshots and rejects bad shapes', () => {
  const back = deserialize({ type: 'object', value: JSON.parse('{"__proto__":{"x":1},"k":2}') });
  assert.deepEqual(back.value, { k: 2 });
  assert.throws(() => deserialize({ type: 'nope', value: 1 }), SeeboError);
  assert.throws(() => deserialize(null), SeeboError);
});

/* ----------------------------------------------------------------------------------- *
 * Builders and dual-semantics constructor (clarifications §8)
 * ----------------------------------------------------------------------------------- */

test('makeTypeConstructor: int() is a builder, int(1) is a value', () => {
  const b = /** @type {any} */ (makeTypeConstructor('int'));
  assert.equal(b.type, 'int');
  assert.equal(typeof b.toDescriptor, 'function');

  const v = /** @type {any} */ (makeTypeConstructor('int', 1));
  assert.equal(v.type, 'int');
  assert.equal(v.value, 1);

  assert.throws(() => makeTypeConstructor('money'), SeeboError);
});

test('builder is immutable and toDescriptor merges defaults + default value', () => {
  const base = builder('string');
  const withMin = base.constraints({ minLen: 1 });
  const full = withMin.default('N/D');

  // original builder is unaffected
  assert.deepEqual(base.toDescriptor(), { type: 'string', format: {}, constraints: {} });
  assert.deepEqual(withMin.toDescriptor(), {
    type: 'string',
    format: {},
    constraints: { minLen: 1 },
  });
  assert.deepEqual(full.toDescriptor(), {
    type: 'string',
    format: {},
    constraints: { minLen: 1 },
    default: 'N/D',
  });
});

test('builder applies type defaults in the descriptor (float precision)', () => {
  assert.deepEqual(builder('float').toDescriptor(), {
    type: 'float',
    format: { decimalSep: ',', thousands: '' },
    constraints: { precision: 2 },
  });
});
