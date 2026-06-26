/**
 * @file Unit — suspendable evaluator (IMPL §5). The three-way result tag is a contract
 * checkable now; `evaluate` behavior is PENDING until implemented.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResultKind, evaluate } from '../../src/eval/evaluator.js';
import { assertNotImplemented, PENDING } from '../helpers/index.js';

test('ResultKind is the three-way Ok|Susp|Err (IMPL §5)', () => {
  assert.deepEqual(ResultKind, { OK: 'Ok', SUSP: 'Susp', ERR: 'Err' });
});

test('evaluate is a placeholder in v1 (throws NotImplemented)', () => {
  assertNotImplemented(() =>
    evaluate(
      /** @type {any} */ ({ kind: 'Lit', position: { start: 0, end: 1 }, type: 'int', value: 1 }),
      { resolved: {} }
    )
  );
});

// IMPL §5 — a literal evaluates to Ok(value); pure, no requirements.
test('IMPL §5 — literal evaluates to Ok', PENDING, () => {
  const res = evaluate(
    /** @type {any} */ ({ kind: 'Lit', position: { start: 0, end: 1 }, type: 'int', value: 1 }),
    { resolved: {} }
  );
  assert.equal(res.kind, ResultKind.OK);
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
