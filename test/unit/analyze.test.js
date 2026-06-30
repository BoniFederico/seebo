/**
 * @file Unit — static analysis (IMPL §9). Covers the `Analysis` fields beyond the
 * conformance fixtures: capabilities, determinism, streamability and the shape contract.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realEngine } from '../helpers/index.js';
import { Streamability } from '../../src/analyze/analyze.js';

test('an empty/pure document has the well-formed Analysis shape', () => {
  const a = realEngine().analyze('Hello ${ 1 + 1 }');
  assert.equal(a.analysisVersion, 1);
  assert.deepEqual(a.requirements, []);
  assert.deepEqual(a.requirementGraph.edges, []);
  assert.deepEqual(a.executionPlan, []);
  assert.deepEqual(a.capabilitiesUsed, []);
  assert.equal(a.deterministic, true);
  assert.equal(a.streamability, Streamability.FULL);
  assert.equal(a.maxPhases, 0);
  assert.equal(a.worstCaseRequirements, 0);
});

test('capabilitiesUsed lists distinct capabilities in declaration order', () => {
  const engine = realEngine({ capabilities: { user: () => undefined, crm: () => undefined } });
  const a = engine.analyze(
    [
      "${ need({ id:'a', type:string(), capability:'user' }) }",
      "${ need({ id:'b', type:string(), capability:'crm' }) }",
      "${ need({ id:'c', type:string(), capability:'user' }) }",
    ].join('')
  );
  assert.deepEqual(a.capabilitiesUsed, ['user', 'crm']);
  assert.deepEqual(
    a.requirements.map((r) => r.id),
    ['a', 'b', 'c']
  );
  // All unconditional ⇒ phase 1.
  assert.deepEqual(a.executionPlan, [{ phase: 1, requirements: ['a', 'b', 'c'] }]);
  assert.equal(a.maxPhases, 1);
});

test('a free now() makes the document non-deterministic', () => {
  const a = realEngine().analyze('${ now() }');
  assert.equal(a.deterministic, false);
});

test('a layout macro forces buffered streamability', () => {
  const a = realEngine().analyze('${ x }@{ COLLAPSE }');
  assert.equal(a.streamability, Streamability.BUFFERED);
});

test('options are derived from a choice-list constraint', () => {
  const engine = realEngine({ capabilities: { user: () => undefined } });
  const a = engine.analyze(
    "${ need({ id:'country', type:array().constraints({ values:['IT','US'] }), capability:'user' }) }"
  );
  assert.deepEqual(a.requirements[0].options, ['IT', 'US']);
});
