/**
 * @file Unit — the pure `action()` core (SPEC §2.8). Covers descriptor preparation, the
 * blocked/ready/pendingConfirmation lifecycle the core emits, deterministic idempotency keys,
 * multi-action collection in document order, and the pure plan/policy helpers. None of these
 * tests execute an action — that is the execution layer's job (conformance suite).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createEngine } from '../../src/index.js';
import { makeString } from '../../src/runtime/values.js';
import {
  buildActionDescriptor,
  computeIdempotencyKey,
  normalizeActionInput,
  findDuplicateActionId,
} from '../../src/actions/plan.js';
import { decideAction, checkPermissions } from '../../src/actions/policy.js';
import { ActionStatus } from '../../src/actions/contracts.js';

const READY_TPL = `\${ action({ id: 'a1', type: 't.do', input: { x: 1 } }) }`;

/** Returns the action plan of a run state (always present after `run`). @param {import('../../src/run/run.js').PublicState} state */
function actionsOf(state) {
  return state.actions ?? [];
}

test('an action with no missing inputs becomes ready', () => {
  const engine = createEngine();
  const state = engine.run(engine.start(READY_TPL));
  assert.equal(state.status, 'completed');
  assert.equal(actionsOf(state).length, 1);
  assert.equal(actionsOf(state)[0].status, ActionStatus.READY);
  assert.equal(actionsOf(state)[0].id, 'a1');
  assert.equal(actionsOf(state)[0].type, 't.do');
  assert.deepEqual(actionsOf(state)[0].input, { x: 1 });
});

test('an action declaring confirm becomes pendingConfirmation', () => {
  const engine = createEngine();
  const tpl = `\${ action({ id: 'a1', type: 't.do', input: {}, confirm: true }) }`;
  const state = engine.run(engine.start(tpl));
  assert.equal(actionsOf(state)[0].status, ActionStatus.PENDING_CONFIRMATION);
  assert.equal(actionsOf(state)[0].requiresConfirmation, true);
});

test('an action with an unresolved requirement is blocked and still surfaces the Need', () => {
  const engine = createEngine();
  const tpl = `\${ action({ id: 'a1', type: 't.do', input: { s: require({ id: 'summary', type: string(), capability: 'input' }) } }) }`;
  let state = engine.run(engine.start(tpl));
  assert.equal(state.status, 'waiting');
  assert.deepEqual(
    state.pending.map((p) => p.id),
    ['summary']
  );
  assert.equal(actionsOf(state)[0].status, ActionStatus.BLOCKED);
  // The resolved-so-far input omits the unresolved field.
  assert.deepEqual(actionsOf(state)[0].input, {});
  assert.ok(Array.isArray(actionsOf(state)[0].diagnostics));

  // Resolving it transitions the action to ready on the next run.
  state.resolved.summary = makeString('Disk full');
  state = engine.run(state);
  assert.equal(state.status, 'completed');
  assert.equal(actionsOf(state)[0].status, ActionStatus.READY);
  assert.deepEqual(actionsOf(state)[0].input, { s: 'Disk full' });
});

test('an action emits the empty string into the output (it is not text)', () => {
  const engine = createEngine();
  const tpl = `before \${ action({ id: 'a1', type: 't.do', input: {} }) }after`;
  const state = engine.run(engine.start(tpl));
  assert.equal(state.output, 'before after');
});

test('multiple actions are collected in document order', () => {
  const engine = createEngine();
  const tpl =
    `\${ action({ id: 'first', type: 't.a', input: {} }) }` +
    `\${ action({ id: 'second', type: 't.b', input: {} }) }`;
  const state = engine.run(engine.start(tpl));
  assert.deepEqual(
    actionsOf(state).map((a) => a.id),
    ['first', 'second']
  );
});

test('an action gated behind a false ternary branch is not collected', () => {
  const engine = createEngine();
  const tpl = `\${ true ? '' : action({ id: 'a1', type: 't.do', input: {} }) }`;
  const state = engine.run(engine.start(tpl));
  assert.equal(actionsOf(state).length, 0);
});

test('an action gated behind a true ternary branch is collected', () => {
  const engine = createEngine();
  const tpl = `\${ false ? '' : action({ id: 'a1', type: 't.do', input: {} }) }`;
  const state = engine.run(engine.start(tpl));
  assert.equal(actionsOf(state).length, 1);
});

test('the idempotency key is deterministic and stable across runs', () => {
  const engine = createEngine();
  const a = actionsOf(engine.run(engine.start(READY_TPL)))[0];
  const b = actionsOf(engine.run(engine.start(READY_TPL)))[0];
  assert.equal(a.idempotencyKey, b.idempotencyKey);
  assert.match(a.idempotencyKey, /^[0-9a-f]{32}$/);
});

test('an explicit idempotencyKey is honored', () => {
  const engine = createEngine();
  const tpl = `\${ action({ id: 'a1', type: 't.do', input: {}, idempotencyKey: 'fixed-key' }) }`;
  const state = engine.run(engine.start(tpl));
  assert.equal(actionsOf(state)[0].idempotencyKey, 'fixed-key');
});

test('action() does not execute during validate or analyze', () => {
  let executed = false;
  const engine = createEngine({
    actions: [
      {
        kind: 'action',
        type: 't.do',
        handler: {
          execute: () => {
            executed = true;
            return {};
          },
        },
      },
    ],
  });
  engine.validate(READY_TPL);
  engine.analyze(READY_TPL);
  engine.run(engine.start(READY_TPL));
  assert.equal(executed, false, 'no handler may run in the pure core');
});

/* --- pure plan helpers --- */

test('buildActionDescriptor requires id and type', () => {
  assert.throws(() => buildActionDescriptor({ type: 't' }), /'id'/);
  assert.throws(() => buildActionDescriptor({ id: 'a' }), /'type'/);
});

test('buildActionDescriptor folds unknown fields and metadata into metadata', () => {
  const d = buildActionDescriptor({ id: 'a', type: 't', custom: 7, metadata: { tag: 'x' } });
  assert.deepEqual(d.metadata, { tag: 'x', custom: 7 });
});

test('normalizeActionInput drops __proto__ and rejects non-objects', () => {
  const cleaned = normalizeActionInput(JSON.parse('{"__proto__":{"polluted":true},"ok":1}'));
  assert.deepEqual(cleaned, { ok: 1 });
  assert.equal(/** @type {any} */ ({}).polluted, undefined);
  assert.throws(() => normalizeActionInput('nope'), /object/);
});

test('computeIdempotencyKey is order-independent over input keys', () => {
  const k1 = computeIdempotencyKey({
    id: 'a',
    type: 't',
    environment: 'test',
    input: { x: 1, y: 2 },
  });
  const k2 = computeIdempotencyKey({
    id: 'a',
    type: 't',
    environment: 'test',
    input: { y: 2, x: 1 },
  });
  assert.equal(k1, k2);
  const k3 = computeIdempotencyKey({
    id: 'a',
    type: 't',
    environment: 'prod',
    input: { x: 1, y: 2 },
  });
  assert.notEqual(k1, k3, 'environment changes the key');
});

test('findDuplicateActionId returns the first repeated id', () => {
  assert.equal(findDuplicateActionId([{ id: 'a' }, { id: 'b' }, { id: 'a' }]), 'a');
  assert.equal(findDuplicateActionId([{ id: 'a' }, { id: 'b' }]), undefined);
});

/* --- pure policy helpers --- */

const DESC = buildActionDescriptor({ id: 'a', type: 't.do', input: {} });

test('decideAction denies a type not in allowedActions (fail closed)', () => {
  assert.equal(decideAction(DESC, { allowedActions: ['other'] }).effect, 'deny');
  assert.equal(decideAction(DESC, { allowedActions: ['t.do'] }).effect, 'allow');
});

test('decideAction denies a denied type even if allowed', () => {
  const d = decideAction(DESC, { allowedActions: ['t.do'], deniedActions: ['t.do'] });
  assert.equal(d.effect, 'deny');
});

test('decideAction requires confirmation when policy forces it', () => {
  assert.equal(decideAction(DESC, { requireConfirmation: true }).effect, 'confirm');
  assert.equal(
    decideAction(DESC, { requireConfirmation: true }, { confirmedActions: ['a'] }).effect,
    'allow'
  );
});

test('decideAction denies an environment outside allowedEnvironments', () => {
  const prod = buildActionDescriptor({ id: 'a', type: 't.do', input: {}, environment: 'prod' });
  assert.equal(decideAction(prod, { allowedEnvironments: ['test'] }).effect, 'deny');
});

test('checkPermissions reports the missing permissions', () => {
  const withPerms = buildActionDescriptor({
    id: 'a',
    type: 't.do',
    input: {},
    permissions: ['p:1'],
  });
  assert.equal(checkPermissions(withPerms, ['p:2'], ['p:1']).effect, 'deny');
  assert.equal(checkPermissions(withPerms, ['p:2'], ['p:1', 'p:2']).effect, 'allow');
});
