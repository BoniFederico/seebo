/**
 * @file Conformance — IMPL Appendix B (normative borderline cases). An implementation is
 * conformant if it reproduces these.
 *
 * Coverage map (cases are grouped by topic across files):
 *  - B.1 nested-branch phases      → test/conformance/analyze.test.js
 *  - B.3 non-exhaustive match      → test/conformance/errors.test.js
 *  - B.4 unknown capability        → test/conformance/errors.test.js
 *  - B.5 inclusion cycle           → test/conformance/errors.test.js
 *  - B.2 need in non-taken branch  → here
 *  - B.6 layout macros / removal   → here
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realEngine, normalizeOutput } from '../helpers/index.js';
import { Status } from '../../src/run/run.js';

// IMPL B.2 — a Need in a non-taken branch is NOT emitted (lazy evaluation, IMPL §5).
//   Input: ${ flag ? require({id:'x', type:string(), capability:'user'}) : 'ok' }
//   With resolved {flag:false}: status completed, output 'ok', pending [].
//   With resolved {flag:true} and x absent: status waiting, pending [x].
test('IMPL B.2 — need in non-taken branch is not emitted', () => {
  const engine = realEngine({ capabilities: { user: () => undefined } });
  const template = "${ flag ? require({id:'x', type:string(), capability:'user'}) : 'ok' }";

  const off = engine.run(engine.start(template, { flag: false }));
  assert.equal(off.status, Status.COMPLETED);
  assert.equal(off.output, 'ok');
  assert.deepEqual(off.pending, []);

  const on = engine.run(engine.start(template, { flag: true }));
  assert.equal(on.status, Status.WAITING);
  assert.deepEqual(
    on.pending.map((r) => r.id),
    ['x']
  );
});

// IMPL B.6 — adjacent layout macros and removal conflicts (post-pass finalize, §10.2).
//   Input:
//     riga1
//     ${ empty }@{REMOVE_LINE}
//     ${ x }@{REMOVE_RIGHT(2)}AB
//   With empty = '' and x = 'V':
//     - the second line is removed entirely (REMOVE_LINE on the slot's line);
//     - REMOVE_RIGHT(2) removes itself and the two chars to its right ('AB'),
//       leaving just the value of x.
//   Expected output:
//     riga1
//     V
test('IMPL B.6 — layout macros: REMOVE_LINE and REMOVE_RIGHT', async () => {
  const engine = realEngine({ capabilities: { user: () => undefined } });
  const template = ['riga1', '${ empty }@{REMOVE_LINE}', '${ x }@{REMOVE_RIGHT(2)}AB'].join('\n');
  const res = await engine.stebo({ template, values: { empty: '', x: 'V' } });
  assert.equal(res.status, Status.COMPLETED);
  assert.equal(normalizeOutput(/** @type {string} */ (res.output)), normalizeOutput('riga1\nV'));
});
