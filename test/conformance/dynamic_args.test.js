/**
 * @file Conformance — dynamic capability `args` (SPEC §2.4, Phase C of the binding redesign). A
 * capability `args` value may reference another binding; the dependency becomes a static edge in
 * the requirement graph (so `analyze` orders the needs into phases), while the value stays runtime:
 * the dependency is resolved first and its value passed to the provider. Covers the edge/phase
 * analysis, the run-time gating, the computed args reaching the provider, member access, and cycle
 * detection on both `analyze` and `run`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createEngine } from '../../src/index.js';
import { makeString } from '../../src/runtime/values.js';
import { DiagnosticCode } from '../../src/util/errors.js';

/** An engine whose `geo` capability echoes the args it receives; `pick` stays interactive. */
function geoEngine() {
  return createEngine({
    capabilities: {
      pick: () => undefined, // interactive: never resolved by a provider
      geo: (need) => `geo(${JSON.stringify(/** @type {any} */ (need).args ?? {})})`,
    },
  });
}

const DEP_TPL =
  `\${ prepare(pick('region')) }` +
  `\${ prepare(need({ id:'city', capability:'geo', args:{ region: region } })) }\${ city }`;

test('analyze reports the data-dependency edge and orders needs into phases', () => {
  const analysis = geoEngine().analyze(DEP_TPL);
  assert.deepEqual(analysis.requirementGraph.edges, [['region', 'city']]);
  assert.deepEqual(analysis.executionPlan, [
    { phase: 1, requirements: ['region'] },
    { phase: 2, requirements: ['city'] },
  ]);
});

test('the dependent need is gated until its dependency resolves', () => {
  const engine = geoEngine();
  let state = engine.run(engine.start(DEP_TPL));
  // Only `region` is pending; `city` is blocked behind it.
  assert.deepEqual(
    state.pending.map((p) => p.id),
    ['region']
  );
  // Resolve the dependency → `city` becomes pending, carrying the computed args.
  state.resolved.region = makeString('EU');
  state = engine.run(state);
  assert.deepEqual(
    state.pending.map((p) => p.id),
    ['city']
  );
  const city = state.pending.find((p) => p.id === 'city');
  assert.deepEqual(city?.args, { region: 'EU' });
});

test('a pending descriptor with computed args is JSON-serializable (no AST leak)', () => {
  const engine = geoEngine();
  let state = engine.run(engine.start(DEP_TPL));
  state.resolved.region = makeString('EU');
  state = engine.run(state);
  const city = state.pending.find((p) => p.id === 'city');
  // The internal argsNode/argDeps must never reach the serialized public state.
  assert.equal('argsNode' in /** @type {any} */ (city), false);
  assert.equal('argDeps' in /** @type {any} */ (city), false);
  // The whole state round-trips through JSON unchanged (the contract of PublicState).
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(state)));
});

test('the resolved dependency value reaches the provider via need.args', async () => {
  const engine = geoEngine();
  const driven = await engine.drive(engine.start(DEP_TPL, { region: 'EU' }));
  assert.equal(driven.status, 'completed');
  assert.match(driven.output ?? '', /"region":"EU"/);
});

test('member access in args (region.code) creates the same dependency edge', () => {
  const tpl =
    `\${ prepare(pick('region')) }` +
    `\${ prepare(need({ id:'zone', capability:'geo', args:{ code: region } })) }\${ zone }`;
  const analysis = geoEngine().analyze(tpl);
  assert.deepEqual(analysis.requirementGraph.edges, [['region', 'zone']]);
});

test('static args (no refs) do not create a dependency and resolve immediately', () => {
  const engine = geoEngine();
  const tpl = `\${ prepare(need({ id:'c', capability:'geo', args:{ q: 'fixed' } })) }\${ c }`;
  const analysis = engine.analyze(tpl);
  assert.deepEqual(analysis.requirementGraph.edges, []);
  const state = engine.run(engine.start(tpl));
  const need = state.pending.find((p) => p.id === 'c');
  assert.deepEqual(need?.args, { q: 'fixed' });
});

test('a transitive chain a→b→c resolves in three phases', () => {
  const tpl =
    `\${ prepare(pick('a')) }` +
    `\${ prepare(need({ id:'b', capability:'geo', args:{ a: a } })) }` +
    `\${ prepare(need({ id:'c', capability:'geo', args:{ b: b } })) }\${ c }`;
  const analysis = geoEngine().analyze(tpl);
  assert.equal(analysis.maxPhases, 3);
});

test('an args dependency cycle is detected by analyze', () => {
  const tpl =
    `\${ prepare(need({ id:'a', capability:'geo', args:{ x: b } })) }` +
    `\${ prepare(need({ id:'b', capability:'geo', args:{ y: a } })) }\${ a }\${ b }`;
  const analysis = geoEngine().analyze(tpl);
  assert.ok(analysis.potentialCycles.length > 0);
});

test('an args dependency cycle fails the run with CYCLE_DETECTED (no infinite loop)', () => {
  const tpl =
    `\${ prepare(need({ id:'a', capability:'geo', args:{ x: b } })) }` +
    `\${ prepare(need({ id:'b', capability:'geo', args:{ y: a } })) }\${ a }\${ b }`;
  const state = geoEngine().run(geoEngine().start(tpl));
  assert.equal(state.status, 'failed');
  assert.ok((state.diagnostics ?? []).some((d) => d.code === DiagnosticCode.CYCLE_DETECTED));
});

test('args referencing an undeclared binding is UNDECLARED_NAME', () => {
  const diags = geoEngine().validate(
    `\${ prepare(need({ id:'c', capability:'geo', args:{ region: nope } })) }\${ c }`
  );
  assert.ok(diags.some((d) => d.code === DiagnosticCode.UNDECLARED_NAME));
});

test('args dependency on a pure value binding is resolved and forwarded', async () => {
  const engine = geoEngine();
  const tpl =
    `\${ bind('vat', string().default('22%')) }` +
    `\${ prepare(need({ id:'c', capability:'geo', args:{ rate: vat } })) }\${ c }`;
  const driven = await engine.drive(engine.start(tpl));
  assert.equal(driven.status, 'completed');
  assert.match(driven.output ?? '', /"rate":"22%"/);
});
