/**
 * @file Conformance — extensibility (SPEC §2.6, IMPL §3/§13). Custom producers,
 * transformers and libraries are consulted by the evaluator; the driver enforces the
 * trusted/untrusted capability policy. Name governance fails at `createEngine`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, defineFunction, defineLibrary } from '../../src/index.js';
import { realEngine, assertHasCode } from '../helpers/index.js';
import { DiagnosticCode } from '../../src/util/errors.js';
import { Status } from '../../src/run/run.js';

/** Renders a fully-static template through one synchronous `run`. @param {any} engine @param {string} t @returns {string} */
function render(engine, t) {
  const state = engine.run(engine.start(t));
  assert.equal(state.status, Status.COMPLETED, `expected completed, got ${state.status}`);
  return /** @type {string} */ (state.output);
}

test('SPEC §2.6 — a custom producer is callable as name(...)', () => {
  const engine = realEngine({ functions: [defineFunction('greet', { eval: () => 'hi' })] });
  assert.equal(render(engine, '${ greet() }'), 'hi');
});

test('SPEC §2.6 — a custom transformer is callable as receiver.name()', () => {
  const engine = realEngine({
    functions: [
      defineFunction('slugify', {
        receiver: 'string',
        eval: (s) => s.toLowerCase().replace(/\s+/g, '-'),
      }),
    ],
  });
  assert.equal(render(engine, "${ 'Hello World'.slugify() }"), 'hello-world');
});

test('SPEC §2.6 — builtin methods still win over a same-named custom transformer', () => {
  const engine = realEngine({
    functions: [defineFunction('upper', { receiver: 'string', eval: () => 'CUSTOM' })],
  });
  assert.equal(render(engine, "${ 'ab'.upper() }"), 'AB'); // builtin upper(), not the custom one
});

test('SPEC §2.6 — a custom library namespace is callable as ns.fn()', () => {
  const engine = realEngine({
    libraries: [defineLibrary('geo', { functions: { zip: { eval: () => '00100' } } })],
  });
  assert.equal(render(engine, '${ geo.zip() }'), '00100');
});

test('SPEC §2.6 — a custom function receives evaluated arguments as plain values', () => {
  const engine = realEngine({
    functions: [defineFunction('addone', { arity: { min: 1, max: 1 }, eval: (n) => n + 1 })],
  });
  assert.equal(render(engine, '${ addone(41) }'), '42');
});

test('SPEC §2.6 — wrong arity on a custom function is an ARITY_MISMATCH', () => {
  const engine = realEngine({
    functions: [defineFunction('addone', { arity: { min: 1, max: 1 }, eval: (n) => n + 1 })],
  });
  const state = engine.run(engine.start('${ addone() }'));
  assert.equal(state.status, Status.FAILED);
  assertHasCode(state.diagnostics ?? [], DiagnosticCode.ARITY_MISMATCH);
});

test('SPEC §2.6 — an unregistered library function is UNKNOWN_FUNCTION', () => {
  const engine = realEngine({ libraries: [defineLibrary('geo', { functions: {} })] });
  const state = engine.run(engine.start('${ geo.nope() }'));
  assert.equal(state.status, Status.FAILED);
  assertHasCode(state.diagnostics ?? [], DiagnosticCode.UNKNOWN_FUNCTION);
});

/* ----------------------------------------------------------------------------------- *
 * Name governance (createEngine fails fast) — SPEC §1.5/§2.6
 * ----------------------------------------------------------------------------------- */

test('SPEC §1.5 — a reserved name fails createEngine with RESERVED_NAME', () => {
  assert.throws(
    () => createEngine({ functions: [defineFunction('match', { eval: () => 1 })] }),
    (e) => /** @type {any} */ (e).code === DiagnosticCode.RESERVED_NAME
  );
});

test('SPEC §1.5 — a duplicate name fails createEngine with NAME_CONFLICT', () => {
  assert.throws(
    () =>
      createEngine({
        functions: [defineFunction('foo', { eval: () => 1 })],
        capabilities: { foo: () => 1 },
      }),
    (e) => /** @type {any} */ (e).code === DiagnosticCode.NAME_CONFLICT
  );
});

/* ----------------------------------------------------------------------------------- *
 * Trusted / untrusted capability policy — IMPL §13
 * ----------------------------------------------------------------------------------- */

const SECRETS_TEMPLATE = "${ require({ id:'k', type:string(), capability:'secrets' }) }";

test('IMPL §13 — allowFrom:trusted forbids the capability for an untrusted template', async () => {
  const engine = realEngine({
    capabilities: { secrets: () => 'S3CR3T' },
    policy: { capabilityRules: { secrets: { allowFrom: 'trusted' } } }, // trustLevel defaults to untrusted
  });
  const res = await engine.stebo({ template: SECRETS_TEMPLATE });
  assert.equal(res.status, Status.FAILED);
  assertHasCode(res.diagnostics ?? [], DiagnosticCode.CAPABILITY_FORBIDDEN);
});

test('IMPL §13 — a trusted template may use an allowFrom:trusted capability', async () => {
  const engine = realEngine({
    capabilities: { secrets: () => 'S3CR3T' },
    policy: { trustLevel: 'trusted', capabilityRules: { secrets: { allowFrom: 'trusted' } } },
  });
  const res = await engine.stebo({ template: SECRETS_TEMPLATE });
  assert.equal(res.status, Status.COMPLETED);
  assert.equal(res.output, 'S3CR3T');
});
