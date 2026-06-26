/**
 * @file Unit — suspendable evaluator (IMPL §5). The three-way result tag is a contract
 * checkable now; `evaluate` behavior is PENDING until implemented.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResultKind, evaluate } from '../../src/eval/evaluator.js';
import { PENDING } from '../helpers/index.js';

/** @param {string} type @param {unknown} value */
const lit = (type, value) => ({ kind: 'Lit', position: { start: 0, end: 1 }, type, value });

test('ResultKind is the three-way Ok|Susp|Err (IMPL §5)', () => {
  assert.deepEqual(ResultKind, { OK: 'Ok', SUSP: 'Susp', ERR: 'Err' });
});

// IMPL §5 — a literal evaluates to Ok(value); pure, no requirements.
test('IMPL §5 — literal evaluates to Ok', () => {
  const res = evaluate(/** @type {any} */ (lit('int', 1)), { resolved: {} });
  assert.equal(res.kind, ResultKind.OK);
  assert.equal(/** @type {any} */ (res).value.type, 'int');
  assert.equal(/** @type {any} */ (res).value.value, 1);
});

// SPEC §1.4 — string + non-string is a runtime type error (no implicit coercion).
test('IMPL §5 — type mismatch yields Err', () => {
  const expr = {
    kind: 'Binary',
    position: { start: 0, end: 1 },
    op: '+',
    left: lit('string', 'a'),
    right: lit('int', 1),
  };
  const res = evaluate(/** @type {any} */ (expr), { resolved: {} });
  assert.equal(res.kind, ResultKind.ERR);
  assert.equal(/** @type {any} */ (res).diagnostic.code, 'TYPE_ERROR_RUNTIME');
});

// IMPL §5 — an unsatisfied, non-optional requirement with no default yields Susp(Need).
test('IMPL §5 — unresolved required requirement yields Susp', PENDING, () => {
  const req = /** @type {any} */ ({
    kind: 'Call',
    position: { start: 0, end: 1 },
    callee: 'require',
    args: [],
  });
  const res = evaluate(req, { resolved: {} });
  assert.equal(res.kind, ResultKind.SUSP);
});
