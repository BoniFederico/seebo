/**
 * @file Conformance — static analysis: `analyze` as a compiler (SPEC §2.3, IMPL §9).
 * Verifies requirements, requirement graph, execution plan, capabilities and metrics
 * are computed statically (no data, no capability queried). Real-engine cases are
 * `PENDING` until implemented.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realEngine } from '../helpers/index.js';

// SPEC §2.3 — the documented analyze example: country (phase 1) gates city (phase 2).
//
// Input template:
//   ${ require({ id:'country', capability:'user', label:'Country',
//                type: array().constraints({ values:['IT','US'] }) }) }
//   ${ country == 'IT'
//        ? require({ id:'city', capability:'user', label:'City', type: string() })
//        : '' }
//
// Expected (SPEC §2.3):
//   requirements: country {options:['IT','US'], phase:1}, city {phase:2}
//   requirementGraph.edges: [['country','city']]
//   executionPlan: [{phase:1,['country']},{phase:2,['city']}]
//   capabilitiesUsed: ['user']; deterministic: true; maxPhases: 2; worstCaseRequirements: 2
test('SPEC §2.3 — analyze computes phases, graph and plan', () => {
  const engine = realEngine({ capabilities: { user: () => undefined } });
  const template = [
    "${ require({ id:'country', capability:'user', label:'Country', type: array().constraints({ values:['IT','US'] }) }) }",
    "${ country == 'IT' ? require({ id:'city', capability:'user', label:'City', type: string() }) : '' }",
  ].join('\n');

  const a = engine.analyze(template);

  assert.equal(a.analysisVersion, 1);
  assert.deepEqual(
    a.requirements.map((r) => r.id),
    ['country', 'city']
  );
  const country = a.requirements.find((r) => r.id === 'country');
  const city = a.requirements.find((r) => r.id === 'city');
  assert.deepEqual(country?.options, ['IT', 'US']);
  assert.equal(country?.phase, 1);
  assert.equal(city?.phase, 2);
  assert.deepEqual(a.requirementGraph.edges, [['country', 'city']]);
  assert.deepEqual(a.executionPlan, [
    { phase: 1, requirements: ['country'] },
    { phase: 2, requirements: ['city'] },
  ]);
  assert.deepEqual(a.capabilitiesUsed, ['user']);
  assert.equal(a.deterministic, true);
  assert.deepEqual(a.potentialCycles, []);
  assert.equal(a.maxPhases, 2);
  assert.equal(a.worstCaseRequirements, 2);
});

// IMPL Appendix B.1 — requirement in nested branches: phase(c) = 1 + max(phase(a),phase(b)).
//   Input: ${ a == 'x' ? (b == 'y' ? require({id:'c',type:string(),capability:'user'}) : '') : '' }
//   Expected: edges a→c and b→c; phase(c) = 2 (a,b unconditional); maxPhases ≥ 2.
test('IMPL B.1 — nested-branch requirement phase', () => {
  const engine = realEngine({ capabilities: { user: () => undefined } });
  const template =
    "${ a == 'x' ? (b == 'y' ? require({id:'c', type:string(), capability:'user'}) : '') : '' }";
  const a = engine.analyze(template);
  const edges = a.requirementGraph.edges.map((e) => e.join('→')).sort();
  assert.deepEqual(edges, ['a→c', 'b→c']);
  assert.equal(a.requirements.find((r) => r.id === 'c')?.phase, 2);
  assert.ok(a.maxPhases >= 2);
});

// SPEC §2.3 — staticValues: a fully pure formula is resolvable cold.
//   Input: ${ 1 + 1 }   Expected: deterministic true; staticValues non-empty.
test('SPEC §2.3 — staticValues holds cold-resolvable slots', () => {
  const engine = realEngine();
  const a = engine.analyze('${ 1 + 1 }');
  assert.equal(a.deterministic, true);
  assert.ok(Object.keys(a.staticValues).length >= 1);
});
