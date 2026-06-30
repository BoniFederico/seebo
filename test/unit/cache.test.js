/**
 * @file Unit — the opt-in AST/analysis cache (IMPL §11/§12.1) must be transparent: enabling
 * `optimizations.astCache` may not change any observable result, only avoid recomputation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../../src/index.js';
import { stripPositions } from '../helpers/index.js';

const TEMPLATE = "Hi ${ name.upper() }, ${ count + 1 } (${ count > 0 ? 'y' : 'n' })";
const values = { name: 'ada', count: 2 };

test('astCache is off by default; parse returns a fresh AST each call', () => {
  const engine = createEngine();
  const a = engine.parse(TEMPLATE);
  const b = engine.parse(TEMPLATE);
  assert.notEqual(a, b); // distinct objects
  assert.deepEqual(stripPositions(a), stripPositions(b)); // but structurally identical
});

test('with astCache, repeated parse returns the very same cached AST', () => {
  const engine = createEngine({ optimizations: { astCache: true } });
  const a = engine.parse(TEMPLATE);
  const b = engine.parse(TEMPLATE);
  assert.equal(a, b); // identical reference (cache hit)
});

test('the cache distinguishes different templates', () => {
  const engine = createEngine({ optimizations: { astCache: true } });
  const a = engine.parse('${ 1 }');
  const b = engine.parse('${ 2 }');
  assert.notEqual(a, b);
  assert.equal(/** @type {any} */ (a.nodes[0]).expr.value, 1);
  assert.equal(/** @type {any} */ (b.nodes[0]).expr.value, 2);
});

test('render output is identical with and without astCache', () => {
  const plain = createEngine();
  const cached = createEngine({ optimizations: { astCache: true } });
  const r1 = plain.run(plain.start(TEMPLATE, values));
  const r2 = cached.run(cached.start(TEMPLATE, values));
  const r3 = cached.run(cached.start(TEMPLATE, values)); // second pass hits the cache
  assert.equal(r1.output, 'Hi ADA, 3 (y)');
  assert.equal(r2.output, r1.output);
  assert.equal(r3.output, r1.output);
});

test('analyze result is identical with and without astCache', () => {
  const t = "${ need({ id:'x', type:string(), capability:'user' }) }";
  const plain = createEngine({ capabilities: { user: () => undefined } });
  const cached = createEngine({
    capabilities: { user: () => undefined },
    optimizations: { astCache: true },
  });
  const a1 = plain.analyze(t);
  const a2 = cached.analyze(t);
  const a3 = cached.analyze(t); // cache hit
  assert.equal(a2, a3); // same cached Analysis object
  assert.deepEqual(stripPositions(a1.requirements), stripPositions(a2.requirements));
  assert.deepEqual(a1.capabilitiesUsed, a2.capabilitiesUsed);
});
