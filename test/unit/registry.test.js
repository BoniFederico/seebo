/**
 * @file Unit — extension registry (SPEC §2.6, IMPL §3 name governance). Verifies name
 * validation (reserved words, uniqueness across the shared producer namespace and the macro
 * namespace) and the registry lookups consulted by the evaluator/driver.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../../src/runtime/registry.js';
import { defineFunction, defineLibrary, defineMacro, defineType } from '../../src/index.js';
import { EngineConfigError, DiagnosticCode } from '../../src/util/errors.js';

test('a clean config builds a registry with the expected lookups', () => {
  const reg = createRegistry({
    functions: [
      defineFunction('slugify', { receiver: 'string', eval: (s) => s }),
      defineFunction('greet', { eval: () => 'hi' }),
    ],
    libraries: [defineLibrary('geo', { functions: { zip: { eval: () => '00100' } } })],
    capabilities: { user: () => undefined },
  });
  assert.equal(typeof reg.getProducer('greet')?.eval, 'function');
  assert.equal(typeof reg.getTransformer('string', 'slugify')?.eval, 'function');
  assert.equal(reg.getProducer('slugify'), undefined); // a transformer is not a producer
  assert.equal(typeof reg.getLibraryFn('geo', 'zip')?.eval, 'function');
  assert.equal(reg.hasLibrary('geo'), true);
  assert.equal(reg.hasCapability('user'), true);
  assert.deepEqual(reg.libraryNames, ['geo']);
});

test('a reserved name is rejected with RESERVED_NAME', () => {
  assert.throws(
    () => createRegistry({ functions: [defineFunction('array', { eval: () => [] })] }),
    (e) =>
      e instanceof EngineConfigError && /** @type {any} */ (e).code === DiagnosticCode.RESERVED_NAME
  );
});

test('a duplicate producer name is rejected with NAME_CONFLICT', () => {
  assert.throws(
    () =>
      createRegistry({
        functions: [defineFunction('foo', { eval: () => 1 })],
        capabilities: { foo: () => 1 }, // collides with the producer in the shared namespace
      }),
    (e) =>
      e instanceof EngineConfigError && /** @type {any} */ (e).code === DiagnosticCode.NAME_CONFLICT
  );
});

test('a library name colliding with a type name is a NAME_CONFLICT', () => {
  assert.throws(
    () => createRegistry({ types: [defineType('geo')], libraries: [defineLibrary('geo')] }),
    (e) => /** @type {any} */ (e).code === DiagnosticCode.NAME_CONFLICT
  );
});

test('a custom macro shares neither namespace with producers; reserved macro names rejected', () => {
  const reg = createRegistry({ macros: [defineMacro('BANNER', { family: 'layout' })] });
  assert.equal(reg.macroFamilies.BANNER, 'layout');
  assert.throws(
    () => createRegistry({ macros: [defineMacro('ABSORB', { family: 'aggregator' })] }),
    (e) => /** @type {any} */ (e).code === DiagnosticCode.RESERVED_NAME
  );
});

test('the same method name on two different receiver types does not conflict', () => {
  const reg = createRegistry({
    functions: [
      defineFunction('shout', { receiver: 'string', eval: (s) => s }),
      defineFunction('shout', { receiver: 'int', eval: (n) => n }),
    ],
  });
  assert.ok(reg.getTransformer('string', 'shout'));
  assert.ok(reg.getTransformer('int', 'shout'));
});
