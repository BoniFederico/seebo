/**
 * @file Conformance — expressions: operators, precedence, type rules, transformers
 * (SPEC §1.4 and §1.5). Each case documents the SPEC source, the input formula and the
 * expected stringified output. Real-engine cases are `PENDING` until implemented.
 *
 * Convention: a single-formula template `${ <expr> }` evaluated with no requirements
 * should reach `status: 'completed'` with `output` equal to the stringified result.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realEngine, PENDING } from '../helpers/index.js';

/**
 * Helper: run a pure formula template to completion and return its output.
 * @param {string} expr
 * @param {import('../../src/index.js').EngineConfig} [config]
 * @returns {Promise<string|undefined>}
 */
async function renderExpr(expr, config) {
  const engine = realEngine(config);
  const res = await engine.stebo({ template: '${ ' + expr + ' }' });
  return res.output;
}

// SPEC §1.4 — arithmetic precedence: `*` binds tighter than `+`.
// Input: 1 + 2 * 3   Expected: "7"
test('SPEC §1.4 — arithmetic precedence (1 + 2 * 3 = 7)', PENDING, async () => {
  assert.equal(await renderExpr('1 + 2 * 3'), '7');
});

// SPEC §1.4 — integer division yields float; precision via constraints.
// Input: float(1234.3456).constraints({ precision: 2 })   Expected: "1234,35" (it-IT)
test('SPEC §1.5 — float precision formatting (1234.3456 → 1234,35)', PENDING, async () => {
  assert.equal(
    await renderExpr('float(1234.3456).constraints({ precision: 2 })', { locale: 'it-IT' }),
    '1234,35'
  );
});

// SPEC §1.5 — array pipeline transformer.
// Input: array([3,1,2]).min()   Expected: "1"
test('SPEC §1.5 — array().min() pipeline (=1)', PENDING, async () => {
  assert.equal(await renderExpr('array([3,1,2]).min()'), '1');
});

// SPEC §1.3/§1.5 — duration totals vs components on duration(50 * 3600) (= 50 hours).
//   .totalHours() → "50" ; .days() → "2" ; .hours() → "2"
test('SPEC §1.5 — duration totals vs components (50h)', PENDING, async () => {
  assert.equal(await renderExpr('duration(50 * 3600).totalHours()'), '50');
  assert.equal(await renderExpr('duration(50 * 3600).days()'), '2');
  assert.equal(await renderExpr('duration(50 * 3600).hours()'), '2');
});

// SPEC §1.3 — duration stringification: leftmost token absorbs overflow.
//   duration(50*3600).format({pattern:'HH:mm:ss'})    → "50:00:00"
//   duration(50*3600).format({pattern:'D HH:mm:ss'})  → "2 02:00:00"
test('SPEC §1.3 — duration pattern formatting (overflow on leftmost token)', PENDING, async () => {
  assert.equal(await renderExpr("duration(50 * 3600).format({ pattern: 'HH:mm:ss' })"), '50:00:00');
  assert.equal(
    await renderExpr("duration(50 * 3600).format({ pattern: 'D HH:mm:ss' })"),
    '2 02:00:00'
  );
});

// SPEC §1.4 — string concatenation requires explicit string(); no implicit coercion.
// Input: 'a' + string(1)   Expected: "a1"
test('SPEC §1.4 — explicit string concatenation', PENDING, async () => {
  assert.equal(await renderExpr("'a' + string(1)"), 'a1');
});

// SPEC §1.4 — coalesce `??` returns first non-empty; empty is '' / [] / {} (not 0/false).
// Input: '' ?? 'fallback'   Expected: "fallback"
// Input: 0 ?? 'fallback'    Expected: "0"  (0 is NOT empty)
test('SPEC §1.4 — coalesce and the notion of empty', PENDING, async () => {
  assert.equal(await renderExpr("'' ?? 'fallback'"), 'fallback');
  assert.equal(await renderExpr('0 ?? 99'), '0');
});

// SPEC §1.4 — match desugars to ternary chain; selects the first matching arm.
// Input: 2 match { 1 => 'uno', 2 => 'due', * => 'altro' }   Expected: "due"
test('SPEC §1.4 — match selects the matching arm', PENDING, async () => {
  assert.equal(await renderExpr("2 match { 1 => 'uno', 2 => 'due', * => 'altro' }"), 'due');
});
