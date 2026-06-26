/**
 * @file Conformance — v1 vertical slice (SPEC §1.2 slots/escaping, §1.3 typed values,
 * §1.4 arithmetic operators & precedence, §2.4/§2.5 run/stebo). End-to-end through the
 * real engine pipeline: lexer → parser → evaluator → run → stebo.
 *
 * Subset under test: text, comment slots `#{}`, formula slots `${}` with int/float/string
 * literals, `+ - * /`, unary `-`, and parentheses. Out-of-subset constructs must fail.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realEngine } from '../helpers/index.js';
import { Status } from '../../src/run/run.js';

/**
 * @param {string} template
 * @param {import('../../src/index.js').EngineConfig} [config]
 */
async function render(template, config) {
  return realEngine(config).stebo({ template });
}

// SPEC §1.2 — verbatim text passes through unchanged.
test('SPEC §1.2 — plain text passthrough', async () => {
  const r = await render('Hello world');
  assert.equal(r.status, Status.COMPLETED);
  assert.equal(r.output, 'Hello world');
});

// SPEC §1.2 — a comment slot #{ ... } is removed at emission.
test('SPEC §1.2 — comment slot is removed', async () => {
  const r = await render('a #{ note } b');
  assert.equal(r.status, Status.COMPLETED);
  assert.equal(r.output, 'a  b'); // surrounding spaces remain; the slot vanishes
});

// SPEC §1.2 — escaping: \${ \#{ \@{ emit the literal sigil+open.
test('SPEC §1.2 — escaped sigils become literals', async () => {
  const r = await render('\\${ literal } and \\#{ c } and \\@{ m }');
  assert.equal(r.status, Status.COMPLETED);
  assert.equal(r.output, '${ literal } and #{ c } and @{ m }');
});

// SPEC §1.4 — arithmetic precedence: * binds tighter than +.
test('SPEC §1.4 — precedence (1 + 2 * 3 = 7)', async () => {
  assert.equal((await render('${ 1 + 2 * 3 }')).output, '7');
});

// SPEC §1.4 — parentheses override precedence.
test('SPEC §1.4 — parentheses ((1 + 2) * 3 = 9)', async () => {
  assert.equal((await render('${ (1 + 2) * 3 }')).output, '9');
});

// SPEC §1.4 — `/` is always float; SPEC §1.3 float default precision 2, decimalSep ','.
test('SPEC §1.4/§1.3 — division yields float (7 / 2 = "3,50")', async () => {
  assert.equal((await render('${ 7 / 2 }')).output, '3,50');
});

// SPEC §1.3 — int op int stays int (no decimals).
test('SPEC §1.3 — int arithmetic stays int (10 - 4 = "6")', async () => {
  assert.equal((await render('${ 10 - 4 }')).output, '6');
});

// SPEC §1.3 — a float literal renders with precision 2.
test('SPEC §1.3 — float literal formatting (3.5 → "3,50")', async () => {
  assert.equal((await render('${ 3.5 }')).output, '3,50');
});

// SPEC §1.4 — string + string concatenates.
test('SPEC §1.4 — string concatenation', async () => {
  assert.equal((await render("${ 'a' + 'b' }")).output, 'ab');
});

// SPEC §1.4 — unary minus.
test('SPEC §1.4 — unary minus (-2 + 5 = "3")', async () => {
  assert.equal((await render('${ -2 + 5 }')).output, '3');
});

// SPEC §1.4 — no implicit coercion: string + non-string is a runtime type error.
test('SPEC §1.4 — string + int is TYPE_ERROR_RUNTIME', async () => {
  const r = await render("${ 'a' + 1 }");
  assert.equal(r.status, Status.FAILED);
  assert.equal(r.diagnostics?.[0]?.code, 'TYPE_ERROR_RUNTIME');
});

// SPEC §1.4 — division by zero is a runtime error.
test('SPEC §1.4 — division by zero is DIVISION_BY_ZERO', async () => {
  const r = await render('${ 1 / 0 }');
  assert.equal(r.status, Status.FAILED);
  assert.equal(r.diagnostics?.[0]?.code, 'DIVISION_BY_ZERO');
});

// SPEC §2.3 — malformed syntax fails with SYNTAX_ERROR (run catches the parse throw).
test('SPEC §2.3 — malformed formula fails with SYNTAX_ERROR', async () => {
  const r = await render('${ 1 + }');
  assert.equal(r.status, Status.FAILED);
  assert.equal(r.diagnostics?.[0]?.code, 'SYNTAX_ERROR');
});

// Slice boundary — a bare identifier now PARSES (full parser → Ref), but the slice
// evaluator does not evaluate references yet, so it fails at run time (not parse time).
test('slice boundary — bare identifier parses but is not yet evaluable', async () => {
  const r = await render('${ nome }');
  assert.equal(r.status, Status.FAILED);
  assert.equal(r.diagnostics?.[0]?.code, 'TYPE_ERROR_RUNTIME');
  assert.equal(r.diagnostics?.[0]?.phase, 'run');
});

// SPEC §2.4 — a completed state is serializable (IMPL §6.1).
test('SPEC §2.4 — completed state round-trips through JSON', async () => {
  const r = await render('${ 1 + 1 }');
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
});
