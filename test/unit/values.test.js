/**
 * @file Unit — runtime values (IMPL §4). Type/precision/unit contracts pass now; builder
 * and stringification behavior is PENDING until implemented.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TypeName, PRECISION_ORDER, DURATION_UNITS } from '../../src/runtime/values.js';
import { makeTypeConstructor, stringify } from '../../src/runtime/index.js';
import { assertNotImplemented, PENDING } from '../helpers/index.js';

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

test('PRECISION_ORDER is coarsest→finest (IMPL §4.2)', () => {
  assert.deepEqual([...PRECISION_ORDER], ['year', 'month', 'day', 'hour', 'minute', 'second']);
});

test('DURATION_UNITS uses constant factors; no months/years (SPEC §1.3)', () => {
  assert.equal(DURATION_UNITS.second, 1);
  assert.equal(DURATION_UNITS.minute, 60);
  assert.equal(DURATION_UNITS.hour, 3600);
  assert.equal(DURATION_UNITS.day, 86400);
  assert.equal(DURATION_UNITS.week, 604800);
  assert.equal(DURATION_UNITS.month, undefined);
  assert.equal(DURATION_UNITS.year, undefined);
});

test('value constructors/stringify are placeholders in v1', () => {
  assertNotImplemented(() => makeTypeConstructor('int', 1));
  assertNotImplemented(() =>
    stringify({ type: 'int', value: 1, format: {}, constraints: {} }, 'it-IT')
  );
});

// IMPL §4 / clarifications §8 — dual semantics: int() is a builder, int(1) a Value.
test('clarifications §8 — int() builder vs int(1) value', PENDING, () => {
  const builder = /** @type {any} */ (makeTypeConstructor('int')); // no value ⇒ builder
  assert.equal(builder.type, 'int');
  const value = /** @type {any} */ (makeTypeConstructor('int', 1)); // value ⇒ Value
  assert.equal(value.type, 'int');
  assert.equal(value.value, 1);
});

// IMPL §4 — float stringification honors precision + decimal separator (it-IT).
test('IMPL §4 — float stringify with precision 2 (1234.5 → 1234,50)', PENDING, () => {
  const v = makeTypeConstructor('float', 1234.5);
  assert.equal(stringify(v, 'it-IT'), '1234,50');
});
