/**
 * @file Conformance — suspension & async driver (SPEC §1.6/§1.9, IMPL §5/§6/§7).
 * The pure run emits Needs; the async driver satisfies them via capabilities, with the
 * four normative outcomes (IMPL §7.1), `stopOn`, policy and limits.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realEngine } from '../helpers/index.js';
import { Status } from '../../src/run/run.js';

// IMPL §7 — the driver auto-resolves "data" capabilities and completes.
test('IMPL §7 — driver auto-resolves a capability', async () => {
  const engine = realEngine({ capabilities: { crm: () => 'A42' } });
  const res = await engine.stebo({
    template: "Order ${ crm({ id:'oid', type:string(), capability:'crm' }) }",
  });
  assert.equal(res.status, Status.COMPLETED);
  assert.equal(res.output, 'Order A42');
});

// IMPL §7.1 — `undefined` ⇒ Unresolved: with stopOn, the Need is returned to the caller.
test('IMPL §7.1 — Unresolved capability stops with pending (stopOn)', async () => {
  const engine = realEngine({ capabilities: { user: () => undefined } });
  const res = await engine.drive("Hi ${ user({ id:'name', type:string(), capability:'user' }) }", {
    stopOn: ['user'],
  });
  assert.equal(res.status, Status.WAITING);
  assert.deepEqual(
    res.pending.map((r) => r.id),
    ['name']
  );
});

// clarifications §10 — values pre-populate `resolved`, so satisfied Needs do not reappear.
test('clarifications §10 — provided values satisfy interactive Needs', async () => {
  const engine = realEngine({ capabilities: { user: () => undefined } });
  const res = await engine.stebo({
    template: "Hi ${ user({ id:'name', type:string(), capability:'user' }) }",
    values: { name: 'Ada' },
  });
  assert.equal(res.status, Status.COMPLETED);
  assert.equal(res.output, 'Hi Ada');
});

// IMPL §5/§6 — multi-phase: a requirement gated by a condition appears only once the
// condition is decided (lazy gating).
test('IMPL §5 — phased resolution through a gating condition', async () => {
  const engine = realEngine({ capabilities: { user: () => undefined } });
  const template =
    "${ paese == 'IT' ? require({ id:'citta', type:string(), capability:'user' }) : 'n/a' }";

  // paese = US → the gated requirement is never active.
  const us = engine.run(engine.start(template, { paese: 'US' }));
  assert.equal(us.status, Status.COMPLETED);
  assert.equal(us.output, 'n/a');

  // paese = IT → citta becomes active.
  const it = engine.run(engine.start(template, { paese: 'IT' }));
  assert.equal(it.status, Status.WAITING);
  assert.deepEqual(
    it.pending.map((r) => r.id),
    ['citta']
  );
});

// IMPL §7.1 — a provider that throws ⇒ ProviderError ⇒ status failed (default policy).
test('IMPL §7.1 — ProviderError fails with CAPABILITY_ERROR', async () => {
  const engine = realEngine({
    capabilities: {
      crm: () => {
        throw new Error('boom');
      },
    },
  });
  const res = await engine.stebo({
    template: "${ crm({ id:'x', type:string(), capability:'crm' }) }",
  });
  assert.equal(res.status, Status.FAILED);
  assert.equal(res.diagnostics?.[0]?.code, 'CAPABILITY_ERROR');
});

// IMPL §7.1 — a value violating the requirement constraints ⇒ InvalidValue.
test('IMPL §7.1 — InvalidValue fails with CAPABILITY_INVALID_VALUE', async () => {
  const engine = realEngine({
    capabilities: { user: () => 'ab' }, // too short for minLen 3
  });
  const res = await engine.stebo({
    template:
      "${ user({ id:'name', type:string().constraints({ minLen: 3 }), capability:'user' }) }",
  });
  assert.equal(res.status, Status.FAILED);
  assert.equal(res.diagnostics?.[0]?.code, 'CAPABILITY_INVALID_VALUE');
});

// IMPL §13 / clarifications §6 — policy allow-list forbids unlisted capabilities.
test('policy — allowedCapabilities forbids unlisted capability', async () => {
  const engine = realEngine({
    capabilities: { secrets: () => 'x' },
    policy: { allowedCapabilities: ['user'] },
  });
  const res = await engine.stebo({
    template: "${ secrets({ id:'k', type:string(), capability:'secrets' }) }",
  });
  assert.equal(res.status, Status.FAILED);
  assert.equal(res.diagnostics?.[0]?.code, 'CAPABILITY_FORBIDDEN');
});

// clarifications §6 — audit hook is invoked (without the secret value).
test('policy — audit hook records capability invocations', async () => {
  /** @type {any[]} */
  const events = [];
  const engine = realEngine({
    capabilities: { crm: () => 'A42' },
    policy: { audit: (e) => events.push(e) },
  });
  await engine.stebo({ template: "${ crm({ id:'x', type:string(), capability:'crm' }) }" });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { capability: 'crm', id: 'x', outcome: 'Resolved' });
  assert.equal('value' in events[0], false); // never leaks the value
});

// IMPL §6.3 — the conversation loop terminates; bounded by limits.maxPhases.
test('SPEC §2.4 — explicit run/satisfy loop terminates', async () => {
  const engine = realEngine({ capabilities: { user: () => undefined } });
  let state = engine.start(
    "${ user({ id:'a', type:string(), capability:'user' }) }-${ user({ id:'b', type:string(), capability:'user' }) }"
  );
  state = engine.run(state);
  assert.equal(state.status, Status.WAITING);
  // satisfy manually (as an external resolver would); raw values are wrapped by the engine
  const satisfied = Object.fromEntries(state.pending.map((r) => [r.id, r.id.toUpperCase()]));
  const resolved = /** @type {any} */ ({ ...state.resolved, ...satisfied });
  state = engine.run({ ...state, resolved });
  assert.equal(state.status, Status.COMPLETED);
  assert.equal(state.output, 'A-B');
});
