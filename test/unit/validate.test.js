/**
 * @file Unit — static validation (IMPL §8, SPEC §1.10). Covers the diagnostics produced
 * by `validate` beyond the conformance fixtures: unknown functions/libraries, policy
 * allow-lists, and that valid declarations/refs produce no diagnostics.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realEngine, codesOf, assertHasCode, assertCodes } from '../helpers/index.js';
import { DiagnosticCode } from '../../src/util/errors.js';
import { defineFunction } from '../../src/index.js';

test('UNKNOWN_FUNCTION for an unknown producer call', () => {
  const diags = realEngine().validate('${ frobnicate(1) }');
  assertHasCode(diags, DiagnosticCode.UNKNOWN_FUNCTION);
  const d = diags.find((x) => x.code === DiagnosticCode.UNKNOWN_FUNCTION);
  assert.deepEqual(d?.data, { name: 'frobnicate' });
});

test('a library that is not enabled parses as a method on an undeclared ref', () => {
  // Without registration `fake.email()` is `Method(receiver: Ref('fake'))`, so `fake`
  // is reported as an undeclared name (the namespace form requires `libraries: ['fake']`).
  const diags = realEngine().validate('${ fake.email() }');
  assertHasCode(diags, DiagnosticCode.UNDECLARED_NAME);
});

test('an enabled library produces no diagnostic', () => {
  const diags = realEngine({ libraries: ['fake'] }).validate('${ fake.email() }');
  assertCodes(diags, []);
});

test('POLICY_FORBIDDEN when a used capability is not allow-listed', () => {
  const engine = realEngine({
    capabilities: { crm: () => 'x', user: () => undefined },
    policy: { allowedCapabilities: ['user'] },
  });
  const diags = engine.validate("${ require({ id:'k', type:string(), capability:'crm' }) }");
  assertHasCode(diags, DiagnosticCode.POLICY_FORBIDDEN);
  const d = diags.find((x) => x.code === DiagnosticCode.POLICY_FORBIDDEN);
  assert.deepEqual(d?.data, { kind: 'capability', name: 'crm' });
});

test('builtin producers and type builders are accepted', () => {
  const engine = realEngine();
  assertCodes(engine.validate('${ now() }'), []);
  assertCodes(engine.validate("${ date('YYYY', '2020') }"), []);
  assertCodes(engine.validate('${ int(1) }'), []);
});

test('a declared requirement is referenceable by name without UNDECLARED_NAME', () => {
  const engine = realEngine({ capabilities: { user: () => undefined } });
  const diags = engine.validate(
    "${ require({ id:'name', type:string(), capability:'user' }) }${ name }"
  );
  assert.ok(!codesOf(diags).includes(DiagnosticCode.UNDECLARED_NAME));
});

test('malformed syntax surfaces a single SYNTAX_ERROR (validate never throws)', () => {
  const diags = realEngine().validate('${ 1 + }');
  assertCodes(diags, [DiagnosticCode.SYNTAX_ERROR]);
  assert.equal(diags[0].recoverable, false);
});

/* ----------------------------------------------------------------------------------- *
 * Static type checks (SPEC §1.10, IMPL §8): UNKNOWN_METHOD / ARITY_MISMATCH / TYPE_ERROR
 * ----------------------------------------------------------------------------------- */

test('UNKNOWN_METHOD for a method that does not exist on the inferred type', () => {
  const engine = realEngine();
  assertHasCode(engine.validate("${ 'abc'.year() }"), DiagnosticCode.UNKNOWN_METHOD);
  // Inference flows through builtins: now() → datetime, which has no .upper().
  assertHasCode(engine.validate('${ now().upper() }'), DiagnosticCode.UNKNOWN_METHOD);
});

test('ARITY_MISMATCH for builtin methods and producers with the wrong argument count', () => {
  const engine = realEngine();
  assertHasCode(engine.validate("${ 'abc'.left() }"), DiagnosticCode.ARITY_MISMATCH); // left needs 1
  assertHasCode(engine.validate('${ now(1) }'), DiagnosticCode.ARITY_MISMATCH); // now needs 0
});

test('TYPE_ERROR for statically provable operator and argument violations', () => {
  const engine = realEngine();
  assertHasCode(engine.validate("${ 1 + 'a' }"), DiagnosticCode.TYPE_ERROR); // no implicit coercion
  assertHasCode(engine.validate('${ now() + now() }'), DiagnosticCode.TYPE_ERROR); // datetime+datetime
  assertHasCode(engine.validate('${ not 1 }'), DiagnosticCode.TYPE_ERROR); // not on int
  assertHasCode(engine.validate("${ 'abc'.left('x') }"), DiagnosticCode.TYPE_ERROR); // left wants numeric
});

test('no false positives: valid pipelines and unknown types produce no type diagnostics', () => {
  const engine = realEngine({ capabilities: { user: () => undefined } });
  assertCodes(engine.validate("${ 'abc'.upper().len() }"), []);
  assertCodes(engine.validate('${ (now() - now()).totalDays().round() }'), []);
  assertCodes(engine.validate('${ int(1) + int(2) }'), []);
  // A member access yields an unknown type, which suppresses downstream method checks.
  assertCodes(
    engine.validate("${ require({id:'o',type:object(),capability:'user'}).whatever.foo() }"),
    []
  );
});

test('a declared requirement type drives method inference (datetime → UNKNOWN_METHOD)', () => {
  const engine = realEngine({ capabilities: { user: () => undefined } });
  const tpl = "${ require({id:'d',type:datetime(),capability:'user'}) }${ d.upper() }";
  assertHasCode(engine.validate(tpl), DiagnosticCode.UNKNOWN_METHOD);
  // The same datetime supports .year(), so that pipeline is clean.
  const ok = "${ require({id:'d',type:datetime(),capability:'user'}) }${ d.year() }";
  assert.ok(!codesOf(engine.validate(ok)).includes(DiagnosticCode.UNKNOWN_METHOD));
});

test('a registered custom transformer is not reported as UNKNOWN_METHOD', () => {
  const engine = realEngine({
    functions: [defineFunction('slugify', { receiver: 'string', eval: (s) => s })],
  });
  assertCodes(engine.validate("${ 'Hello'.slugify() }"), []);
});
