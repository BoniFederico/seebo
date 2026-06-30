/**
 * @file Unit — capability contracts (SPEC §1.6). A capability registered via
 * `defineCapability({ type, label, ... })` declares a contract that a need inherits (via the
 * `cap('id')` sugar or `need({ id, capability })`); the template still wins on any field it
 * overrides. A bare resolver function carries no contract (backward-compatible). Covers the sugar,
 * inheritance, override precedence, and that `analyze`/`validate` see the inherited type.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createEngine, defineCapability } from '../../src/index.js';
import { builder, makeInt } from '../../src/runtime/values.js';

/** Type-builder helpers (the JS-side equivalents of the template `int()` / `string()`). */
const int = () => builder('int');
const str = () => builder('string');

/** An engine whose `input` capability declares an int contract with bounds and a label. */
function engineWithContract() {
  return createEngine({
    capabilities: {
      input: defineCapability('input', {
        type: int().constraints({ min: 0, max: 100 }),
        label: 'A bounded integer',
        resolve: (need) => /** @type {any} */ (need).args?.value,
      }),
      plain: () => 'hi', // bare function: no contract
    },
  });
}

test("need('cap') inherits type and label from the capability contract", () => {
  const engine = engineWithContract();
  const state = engine.run(engine.start(`\${ input('n') }`));
  assert.equal(state.status, 'waiting');
  const need = state.pending[0];
  assert.equal(need.id, 'n');
  assert.equal(need.type?.type, 'int');
  assert.equal(need.type?.constraints?.min, 0);
  assert.equal(need.label, 'A bounded integer');
});

test('analyze reports the inherited type and constraints', () => {
  const engine = engineWithContract();
  const analysis = engine.analyze(`\${ input('n') }`);
  const req = analysis.requirements.find((r) => r.id === 'n');
  assert.ok(req);
  assert.equal(req.type?.type, 'int');
  assert.equal(req.type?.constraints?.max, 100);
});

test('validate type-checks references using the inherited type', () => {
  const engine = engineWithContract();
  // `n` is int by contract, so `n + 1` is valid (no TYPE_ERROR).
  const diags = engine.validate(`\${ prepare(input('n')) }\${ n + 1 }`);
  assert.equal(diags.length, 0);
});

test('the template overrides the contract (template wins)', () => {
  const engine = engineWithContract();
  const analysis = engine.analyze(`\${ need({ id:'n', capability:'input', type:string() }) }`);
  assert.equal(analysis.requirements.find((r) => r.id === 'n')?.type?.type, 'string');
});

test('a bare resolver function carries no contract (string default, backward compatible)', () => {
  const engine = engineWithContract();
  const state = engine.run(engine.start(`\${ plain('p') }`));
  assert.equal(state.pending[0].type?.type, 'string');
});

test('the inline need({ capability }) form also inherits the contract', () => {
  const engine = engineWithContract();
  const state = engine.run(engine.start(`\${ need({ id:'n', capability:'input' }) }`));
  assert.equal(state.pending[0].type?.type, 'int');
});

test("capability sugar cap('id') sets the id and inherits the contract", () => {
  const engine = engineWithContract();
  const state = engine.run(engine.start(`\${ input('amount') }`));
  assert.equal(state.status, 'waiting');
  const need = state.pending[0];
  assert.equal(need.id, 'amount'); // the bare string is the id
  assert.equal(need.capability, 'input');
  assert.equal(need.type?.type, 'int'); // inherited from the contract
  assert.equal(need.label, 'A bounded integer');
});

test("capability sugar cap('id') renders end-to-end once resolved", () => {
  const engine = engineWithContract();
  let state = engine.run(engine.start(`Value: \${ input('amount') }`));
  state.resolved.amount = makeInt(7);
  state = engine.run(state);
  assert.equal(state.output, 'Value: 7');
});

test("prepare(cap('id')) declares the need lazily and inherits the contract", () => {
  const engine = engineWithContract();
  const state = engine.run(engine.start(`\${ prepare(input('amount')) }\${ amount }`));
  assert.equal(state.status, 'waiting');
  const need = state.pending[0];
  assert.equal(need.id, 'amount');
  assert.equal(need.type?.type, 'int'); // inherited from the contract
});

test('a contract default flows through as the resolved value', () => {
  const engine = createEngine({
    capabilities: {
      vat: defineCapability('vat', { type: str().default('22%'), resolve: () => undefined }),
    },
  });
  const state = engine.run(engine.start(`\${ vat('v') }`));
  assert.equal(state.status, 'completed');
  assert.equal(state.output, '22%');
});

test('a capability entry that is neither a function nor a descriptor is rejected', () => {
  assert.throws(
    () => createEngine({ capabilities: { bad: /** @type {any} */ (42) } }),
    /resolver function or a defineCapability/
  );
});

test('normalizeConfig splits providers and contracts', async () => {
  const { normalizeConfig } = await import('../../src/index.js');
  const cfg = normalizeConfig({
    capabilities: {
      a: defineCapability('a', { type: int(), resolve: () => 1 }),
      b: () => 2,
    },
  });
  assert.equal(typeof cfg.capabilities.a, 'function'); // provider extracted
  assert.equal(typeof cfg.capabilities.b, 'function');
  assert.equal(cfg.capabilityContracts.a?.type?.type, 'int');
  assert.equal(cfg.capabilityContracts.b, undefined); // bare fn → no contract
});
