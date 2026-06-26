/**
 * @file Conformance — validity and errors (SPEC §1.10, IMPL Appendix A/B). Static checks
 * are reported by `validate` as structured diagnostics (codes are the public contract).
 * Real-engine cases are `PENDING` until implemented; codes/expectations are asserted via
 * the harness helpers.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realEngine, assertHasCode, assertCodes, PENDING } from '../helpers/index.js';
import { DiagnosticCode } from '../../src/util/errors.js';

// SPEC §1.7/§1.10 — referencing an undeclared identifier is a static error.
//   Input: ${ nome }   Expected: validate → [UNDECLARED_NAME], recoverable.
test('SPEC §1.10 — UNDECLARED_NAME for unknown reference', PENDING, () => {
  const engine = realEngine();
  const diags = engine.validate('${ nome }');
  assertHasCode(diags, DiagnosticCode.UNDECLARED_NAME);
  assert.equal(diags[0].recoverable, true);
});

// IMPL B.4 — a requirement citing an unregistered capability is a static error.
//   Input: ${ require({ id:'x', type:string(), capability:'ghost' }) }
//   Expected: validate → [UNKNOWN_CAPABILITY] with data.capability = 'ghost' (before any run).
test('IMPL B.4 — UNKNOWN_CAPABILITY for unregistered capability', PENDING, () => {
  const engine = realEngine(); // no capabilities registered
  const diags = engine.validate("${ require({ id:'x', type:string(), capability:'ghost' }) }");
  assertHasCode(diags, DiagnosticCode.UNKNOWN_CAPABILITY);
  const d = diags.find((x) => x.code === DiagnosticCode.UNKNOWN_CAPABILITY);
  assert.deepEqual(d?.data, { capability: 'ghost' });
});

// IMPL B.3 — a non-exhaustive match (no `*`, non-exhaustive cases) is a static error.
//   Input: ${ n match { 1 => 'uno', 2 => 'due' } }   Expected: validate → [NON_EXHAUSTIVE_MATCH].
//   With a `* => 'altro'` arm added: no diagnostics.
test('IMPL B.3 — NON_EXHAUSTIVE_MATCH without default arm', PENDING, () => {
  const engine = realEngine({ capabilities: { user: () => undefined } });
  const bad = engine.validate(
    "${ require({id:'n',type:int(),capability:'user'}) match { 1 => 'uno', 2 => 'due' } }"
  );
  assertHasCode(bad, DiagnosticCode.NON_EXHAUSTIVE_MATCH);

  const good = engine.validate(
    "${ require({id:'n',type:int(),capability:'user'}) match { 1 => 'uno', 2 => 'due', * => 'altro' } }"
  );
  assertCodes(good, []);
});

// SPEC §2.3 — a well-formed, fully-declared template yields no diagnostics.
//   Input: ${ 1 + 2 }   Expected: validate → [].
test('SPEC §2.3 — clean template has no diagnostics', PENDING, () => {
  const engine = realEngine();
  assertCodes(engine.validate('${ 1 + 2 }'), []);
});

// SPEC §2.3 — parse throws (with position) on malformed syntax, unlike validate/tokenize.
//   Input: ${ 1 +    Expected: throws (SYNTAX_ERROR-coded error).
test('SPEC §2.3 — parse throws on malformed syntax', PENDING, () => {
  const engine = realEngine();
  assert.throws(() => engine.parse('${ 1 + }'));
});

// IMPL B.5 — cyclic inclusion is detected (statically by analyze, fatally by run/expand).
//   templates: a → ABSORB('b'), b → ABSORB('a')
//   Expected: status 'failed' with INCLUSION_CYCLE; analyze.potentialCycles non-empty.
test('IMPL B.5 — INCLUSION_CYCLE on cyclic ABSORB', PENDING, async () => {
  const engine = realEngine();
  const templates = { a: "@{ABSORB('b')}", b: "@{ABSORB('a')}" };
  const res = await engine.stebo({ template: templates.a, templates });
  assert.equal(res.status, 'failed');
  assertHasCode(res.diagnostics ?? [], DiagnosticCode.INCLUSION_CYCLE);
});
