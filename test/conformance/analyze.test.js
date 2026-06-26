/**
 * @file Conformance — static analysis: `analyze` as a compiler (SPEC §2.3, IMPL §9).
 * Verifies requirements, requirement graph, execution plan, capabilities and metrics
 * are computed statically (no data, no capability queried). Real-engine cases are
 * `PENDING` until implemented.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realEngine, PENDING } from '../helpers/index.js';

// SPEC §2.3 — the documented analyze example: paese (phase 1) gates citta (phase 2).
//
// Input template:
//   ${ require({ id:'paese', capability:'user', label:'Paese',
//                type: array().constraints({ values:['IT','US'] }) }) }
//   ${ paese == 'IT'
//        ? require({ id:'citta', capability:'user', label:'Città', type: string() })
//        : '' }
//
// Expected (SPEC §2.3):
//   requirements: paese {options:['IT','US'], phase:1}, citta {phase:2}
//   requirementGraph.edges: [['paese','citta']]
//   executionPlan: [{phase:1,['paese']},{phase:2,['citta']}]
//   capabilitiesUsed: ['user']; deterministic: true; maxPhases: 2; worstCaseRequirements: 2
test('SPEC §2.3 — analyze computes phases, graph and plan', PENDING, () => {
  const engine = realEngine({ capabilities: { user: () => undefined } });
  const template = [
    "${ require({ id:'paese', capability:'user', label:'Paese', type: array().constraints({ values:['IT','US'] }) }) }",
    "${ paese == 'IT' ? require({ id:'citta', capability:'user', label:'Città', type: string() }) : '' }",
  ].join('\n');

  const a = engine.analyze(template);

  assert.equal(a.analysisVersion, 1);
  assert.deepEqual(
    a.requirements.map((r) => r.id),
    ['paese', 'citta']
  );
  const paese = a.requirements.find((r) => r.id === 'paese');
  const citta = a.requirements.find((r) => r.id === 'citta');
  assert.deepEqual(paese?.options, ['IT', 'US']);
  assert.equal(paese?.phase, 1);
  assert.equal(citta?.phase, 2);
  assert.deepEqual(a.requirementGraph.edges, [['paese', 'citta']]);
  assert.deepEqual(a.executionPlan, [
    { phase: 1, requirements: ['paese'] },
    { phase: 2, requirements: ['citta'] },
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
test('IMPL B.1 — nested-branch requirement phase', PENDING, () => {
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
test('SPEC §2.3 — staticValues holds cold-resolvable slots', PENDING, () => {
  const engine = realEngine();
  const a = engine.analyze('${ 1 + 1 }');
  assert.equal(a.deterministic, true);
  assert.ok(Object.keys(a.staticValues).length >= 1);
});
