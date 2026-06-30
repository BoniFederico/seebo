/**
 * @file Conformance — validity and errors (SPEC §1.10, IMPL Appendix A/B). Static checks
 * are reported by `validate` as structured diagnostics (codes are the public contract).
 * Codes/expectations are asserted via the harness helpers.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realEngine, assertHasCode, assertCodes } from '../helpers/index.js';
import { DiagnosticCode } from '../../src/util/errors.js';
import { Status } from '../../src/run/run.js';

// SPEC §1.7/§1.10 — referencing an undeclared identifier is a static error.
//   Input: ${ nome }   Expected: validate → [UNDECLARED_NAME], recoverable.
test('SPEC §1.10 — UNDECLARED_NAME for unknown reference', () => {
  const engine = realEngine();
  const diags = engine.validate('${ nome }');
  assertHasCode(diags, DiagnosticCode.UNDECLARED_NAME);
  assert.equal(diags[0].recoverable, true);
});

// IMPL B.4 — a requirement citing an unregistered capability is a static error.
//   Input: ${ need({ id:'x', type:string(), capability:'ghost' }) }
//   Expected: validate → [UNKNOWN_CAPABILITY] with data.capability = 'ghost' (before any run).
test('IMPL B.4 — UNKNOWN_CAPABILITY for unregistered capability', () => {
  const engine = realEngine(); // no capabilities registered
  const diags = engine.validate("${ need({ id:'x', type:string(), capability:'ghost' }) }");
  assertHasCode(diags, DiagnosticCode.UNKNOWN_CAPABILITY);
  const d = diags.find((x) => x.code === DiagnosticCode.UNKNOWN_CAPABILITY);
  assert.deepEqual(d?.data, { capability: 'ghost' });
});

// IMPL B.3 — a non-exhaustive match (no `*`, non-exhaustive cases) is a static error.
//   Input: ${ n match { 1 => 'one', 2 => 'two' } }   Expected: validate → [NON_EXHAUSTIVE_MATCH].
//   With a `* => 'other'` arm added: no diagnostics.
test('IMPL B.3 — NON_EXHAUSTIVE_MATCH without default arm', () => {
  const engine = realEngine({ capabilities: { user: () => undefined } });
  const bad = engine.validate(
    "${ need({id:'n',type:int(),capability:'user'}) match { 1 => 'one', 2 => 'two' } }"
  );
  assertHasCode(bad, DiagnosticCode.NON_EXHAUSTIVE_MATCH);

  const good = engine.validate(
    "${ need({id:'n',type:int(),capability:'user'}) match { 1 => 'one', 2 => 'two', * => 'other' } }"
  );
  assertCodes(good, []);
});

// IMPL B.3 — a `bool` match covering both `true` and `false` is provably exhaustive even
// without a `*` arm (closed domain), so no NON_EXHAUSTIVE_MATCH is reported.
test('IMPL B.3 — bool match with true+false is exhaustive without default', () => {
  const engine = realEngine({ capabilities: { user: () => undefined } });
  const ok = engine.validate(
    "${ need({id:'b',type:bool(),capability:'user'}) match { true => 'yes', false => 'no' } }"
  );
  assertCodes(ok, []);

  // A single boolean arm does NOT cover the domain → still non-exhaustive.
  const partial = engine.validate(
    "${ need({id:'b',type:bool(),capability:'user'}) match { true => 'yes' } }"
  );
  assertHasCode(partial, DiagnosticCode.NON_EXHAUSTIVE_MATCH);
});

// SPEC §2.3 — a well-formed, fully-declared template yields no diagnostics.
//   Input: ${ 1 + 2 }   Expected: validate → [].
test('SPEC §2.3 — clean template has no diagnostics', () => {
  const engine = realEngine();
  assertCodes(engine.validate('${ 1 + 2 }'), []);
});

// SPEC §2.3 — parse throws (with position) on malformed syntax, unlike validate/tokenize.
//   Input: ${ 1 +    Expected: throws (SYNTAX_ERROR-coded error).
test('SPEC §2.3 — parse throws on malformed syntax', () => {
  const engine = realEngine();
  assert.throws(() => engine.parse('${ 1 + }')); // ACTIVE: implemented by the v1 slice
});

// SPEC §1.10 — a value that violates its OWN constraints surfaces at run (not at validate),
// because the violation depends on the concrete value, not the structure.
//   Input: ${ int(5).constraints({ max: 3 }) }   Expected: status failed, [CONSTRAINT_VIOLATION].
test('SPEC §1.10 — CONSTRAINT_VIOLATION on a computed value (max)', async () => {
  const engine = realEngine();
  // Static validate sees nothing wrong (the value is only known at run).
  assertCodes(engine.validate('${ int(5).constraints({ max: 3 }) }'), []);
  const res = await engine.stebo({ template: '${ int(5).constraints({ max: 3 }) }' });
  assert.equal(res.status, Status.FAILED);
  assertHasCode(res.diagnostics ?? [], DiagnosticCode.CONSTRAINT_VIOLATION);
});

// SPEC §1.10 — string length and array `values` constraints are likewise enforced at run.
test('SPEC §1.10 — CONSTRAINT_VIOLATION on string length and array values', async () => {
  const engine = realEngine();
  const tooLong = await engine.stebo({ template: "${ 'abcd'.constraints({ maxLen: 2 }) }" });
  assert.equal(tooLong.status, Status.FAILED);
  assertHasCode(tooLong.diagnostics ?? [], DiagnosticCode.CONSTRAINT_VIOLATION);

  const notAllowed = await engine.stebo({
    template: "${ array(['x']).constraints({ values: ['a', 'b'] }) }",
  });
  assert.equal(notAllowed.status, Status.FAILED);
  assertHasCode(notAllowed.diagnostics ?? [], DiagnosticCode.CONSTRAINT_VIOLATION);
});

// SPEC §1.10 — a value that satisfies its constraints renders normally.
test('SPEC §1.10 — satisfied constraints render normally', async () => {
  const engine = realEngine();
  const res = await engine.stebo({ template: '${ int(2).constraints({ max: 3 }) }' });
  assert.equal(res.status, Status.COMPLETED);
  assert.equal(res.output, '2');
});

// IMPL B.5 — cyclic inclusion is detected (statically by analyze, fatally by run/expand).
//   templates: a → ABSORB('b'), b → ABSORB('a')
//   Expected: status 'failed' with INCLUSION_CYCLE; analyze.potentialCycles non-empty.
test('IMPL B.5 — INCLUSION_CYCLE on cyclic ABSORB', async () => {
  const engine = realEngine();
  const templates = { a: "@{ABSORB('b')}", b: "@{ABSORB('a')}" };
  const res = await engine.stebo({ template: templates.a, templates });
  assert.equal(res.status, 'failed');
  assertHasCode(res.diagnostics ?? [], DiagnosticCode.INCLUSION_CYCLE);
});
