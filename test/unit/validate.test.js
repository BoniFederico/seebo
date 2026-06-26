/**
 * @file Unit — static validation (IMPL §8, SPEC §1.10). Covers the diagnostics produced
 * by `validate` beyond the conformance fixtures: unknown functions/libraries, policy
 * allow-lists, and that valid declarations/refs produce no diagnostics.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realEngine, codesOf, assertHasCode, assertCodes } from '../helpers/index.js';
import { DiagnosticCode } from '../../src/util/errors.js';

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
