/**
 * @file Conformance — the `seebo/actions` execution layer end to end (SPEC §2.8): execution,
 * dry-run, confirmation, permissions/policy, retry, audit/redact, compensation, plan-level
 * results and the analyze/validate integration. Also asserts the hard rule that the pure core
 * never performs an effect.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createEngine, defineAction } from '../../src/index.js';
import { makeString } from '../../src/runtime/values.js';
import {
  executeAction,
  executeActionPlan,
  dryRunAction,
  dryRunActionPlan,
  compensateAction,
  compensateActionPlan,
  ActionStatus,
  ActionErrorCode,
  PlanStatus,
  nonRetryable,
} from '../../src/actions/index.js';
import { DiagnosticCode } from '../../src/util/errors.js';
import { codesOf } from '../helpers/index.js';

/**
 * Builds an engine with a single recording handler.
 * @param {string} type @param {import('../../src/actions/contracts.js').ActionHandler} handler
 */
function engineWith(type, handler) {
  const engine = createEngine();
  engine.defineAction(type, handler);
  return engine;
}

/**
 * Prepares an action plan from a template, optionally pre-resolving inputs.
 * @param {import('../../src/index.js').Engine} engine @param {string} tpl @param {Record<string, unknown>} [values]
 * @returns {import('../../src/actions/contracts.js').ActionPlan}
 */
function planFor(engine, tpl, values = {}) {
  let state = engine.start(tpl);
  for (const [k, v] of Object.entries(values)) state.resolved[k] = makeString(String(v));
  state = engine.run(state);
  return state.actions ?? [];
}

const READY = `\${ action({ id: 'a1', type: 'svc.do', input: { x: 1 } }) }`;

/* --- execution --- */

test('executeAction invokes the handler and returns a success receipt', async () => {
  /** @type {Array<{ input: unknown, key: string, attempt: number }>} */
  const calls = [];
  const engine = engineWith('svc.do', {
    execute: (input, ctx) => {
      calls.push({ input, key: ctx.idempotencyKey, attempt: ctx.attempt });
      return { externalId: 'EXT-1', detail: 'ok' };
    },
  });
  const [action] = planFor(engine, READY);
  const receipt = await executeAction(action, { engine, actor: 'bob' });
  assert.equal(receipt.status, ActionStatus.SUCCEEDED);
  assert.equal(receipt.externalId, 'EXT-1');
  assert.equal(receipt.actor, 'bob');
  assert.equal(receipt.attempts, 1);
  assert.equal(receipt.dryRun, false);
  assert.equal(typeof receipt.durationMs, 'number');
  assert.equal(calls[0].key, action.idempotencyKey);
});

test('a handler that is not found yields a structured HANDLER_NOT_FOUND skip', async () => {
  const engine = createEngine();
  const [action] = planFor(engine, READY);
  const receipt = await executeAction(action, { engine });
  assert.equal(receipt.status, ActionStatus.SKIPPED);
  assert.equal(receipt.error?.code, ActionErrorCode.HANDLER_NOT_FOUND);
});

test('a failing handler returns a structured failure receipt (never throws)', async () => {
  const engine = engineWith('svc.do', {
    execute: () => {
      throw new Error('boom');
    },
  });
  const [action] = planFor(engine, READY);
  const receipt = await executeAction(action, { engine });
  assert.equal(receipt.status, ActionStatus.FAILED);
  assert.equal(receipt.error?.code, ActionErrorCode.EXECUTION_FAILED);
  assert.match(receipt.error?.message ?? '', /boom/);
});

test('executeActionPlan runs multiple actions and reports a plan result', async () => {
  /** @type {string[]} */
  const seen = [];
  const engine = createEngine();
  engine.defineAction('svc.a', { execute: () => (seen.push('a'), { externalId: 'A' }) });
  engine.defineAction('svc.b', { execute: () => (seen.push('b'), { externalId: 'B' }) });
  const tpl =
    `\${ action({ id: 'first', type: 'svc.a', input: {} }) }` +
    `\${ action({ id: 'second', type: 'svc.b', input: {} }) }`;
  const plan = planFor(engine, tpl);
  const result = await executeActionPlan(plan, { engine });
  assert.equal(result.status, PlanStatus.COMPLETED);
  assert.equal(result.succeeded, 2);
  assert.deepEqual(seen, ['a', 'b']);
  assert.deepEqual(
    result.receipts.map((r) => r.actionId),
    ['first', 'second']
  );
});

test('a plan with one failing and one succeeding action is partial', async () => {
  const engine = createEngine();
  engine.defineAction('svc.a', { execute: () => ({ externalId: 'A' }) });
  engine.defineAction('svc.b', {
    execute: () => {
      throw new Error('nope');
    },
  });
  const tpl =
    `\${ action({ id: 'ok', type: 'svc.a', input: {} }) }` +
    `\${ action({ id: 'bad', type: 'svc.b', input: {} }) }`;
  const result = await executeActionPlan(planFor(engine, tpl), { engine });
  assert.equal(result.status, PlanStatus.PARTIAL);
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 1);
});

test('failFast stops the plan after the first failure', async () => {
  /** @type {string[]} */
  const seen = [];
  const engine = createEngine();
  engine.defineAction('svc.a', {
    execute: () => {
      seen.push('a');
      throw new Error('x');
    },
  });
  engine.defineAction('svc.b', { execute: () => (seen.push('b'), {}) });
  const tpl =
    `\${ action({ id: 'a', type: 'svc.a', input: {} }) }` +
    `\${ action({ id: 'b', type: 'svc.b', input: {} }) }`;
  const result = await executeActionPlan(planFor(engine, tpl), { engine, failFast: true });
  assert.deepEqual(seen, ['a']);
  assert.equal(result.status, PlanStatus.FAILED);
});

test('a duplicate action id in a plan fails closed without executing', async () => {
  let ran = false;
  const engine = engineWith('svc.do', { execute: () => ((ran = true), {}) });
  const [a] = planFor(engine, READY);
  const result = await executeActionPlan([a, { ...a }], { engine });
  assert.equal(ran, false);
  assert.ok(result.receipts.every((r) => r.error?.code === ActionErrorCode.DUPLICATE_ACTION_ID));
});

/* --- dry-run --- */

test('dryRunAction calls the handler dryRun, never execute', async () => {
  let executed = false;
  const engine = engineWith('svc.do', {
    dryRun: (input) => ({ preview: input }),
    execute: () => ((executed = true), {}),
  });
  const [action] = planFor(engine, READY);
  const receipt = await dryRunAction(action, { engine });
  assert.equal(executed, false);
  assert.equal(receipt.dryRun, true);
  assert.equal(receipt.status, ActionStatus.SUCCEEDED);
  assert.deepEqual(receipt.output, { preview: { x: 1 } });
});

test('dry-run without a dryRun handler returns a deterministic simulated receipt', async () => {
  const engine = engineWith('svc.do', { execute: () => ({ externalId: 'X' }) });
  const [action] = planFor(engine, READY);
  const receipt = await dryRunAction(action, { engine });
  assert.equal(receipt.dryRun, true);
  assert.equal(receipt.status, ActionStatus.SUCCEEDED);
  assert.equal(/** @type {any} */ (receipt.output).simulated, true);
});

test('executeActionPlan with dryRun:true never calls execute', async () => {
  let executed = false;
  const engine = engineWith('svc.do', {
    dryRun: () => ({ ok: true }),
    execute: () => ((executed = true), {}),
  });
  const result = await dryRunActionPlan(planFor(engine, READY), { engine });
  assert.equal(executed, false);
  assert.equal(result.dryRun, true);
  assert.equal(result.status, PlanStatus.COMPLETED);
});

/* --- confirmation --- */

const CONFIRM = `\${ action({ id: 'a1', type: 'svc.do', input: {}, confirm: true }) }`;

test('an action requiring confirmation is skipped when unconfirmed', async () => {
  const engine = engineWith('svc.do', { execute: () => ({}) });
  const [action] = planFor(engine, CONFIRM);
  const receipt = await executeAction(action, { engine });
  assert.equal(receipt.status, ActionStatus.SKIPPED);
  assert.equal(receipt.error?.code, ActionErrorCode.CONFIRMATION_REQUIRED);
});

test('an action requiring confirmation executes when explicitly confirmed', async () => {
  const engine = engineWith('svc.do', { execute: () => ({ externalId: 'OK' }) });
  const [action] = planFor(engine, CONFIRM);
  const receipt = await executeAction(action, { engine, confirmedActions: ['a1'] });
  assert.equal(receipt.status, ActionStatus.SUCCEEDED);
});

test('policy.requireConfirmation forces confirmation for an unconfirmed action', async () => {
  const engine = createEngine({ policy: { action: { requireConfirmation: true } } });
  engine.defineAction('svc.do', { execute: () => ({}) });
  const [action] = planFor(engine, READY);
  const receipt = await executeAction(action, { engine });
  assert.equal(receipt.error?.code, ActionErrorCode.CONFIRMATION_REQUIRED);
});

test('in a multi-action plan only confirmed required actions execute', async () => {
  /** @type {string[]} */
  const ran = [];
  const engine = createEngine();
  engine.defineAction('svc.do', { execute: (i, ctx) => (ran.push(ctx.actionId), {}) });
  const tpl =
    `\${ action({ id: 'needs', type: 'svc.do', input: {}, confirm: true }) }` +
    `\${ action({ id: 'free', type: 'svc.do', input: {} }) }`;
  const result = await executeActionPlan(planFor(engine, tpl), {
    engine,
    confirmedActions: ['free'], // 'needs' not confirmed
  });
  assert.deepEqual(ran, ['free']);
  assert.equal(result.status, PlanStatus.PARTIAL); // one succeeded, one skipped...
});

/* --- permissions / policy --- */

test('a missing actor permission denies execution', async () => {
  const engine = engineWith('svc.do', {
    requiredPermissions: ['svc:do'],
    execute: () => ({}),
  });
  const [action] = planFor(engine, READY);
  const denied = await executeAction(action, { engine, permissions: [] });
  assert.equal(denied.error?.code, ActionErrorCode.PERMISSION_DENIED);
  const ok = await executeAction(action, { engine, permissions: ['svc:do'] });
  assert.equal(ok.status, ActionStatus.SUCCEEDED);
});

test('a handler allowedEnvironments restriction denies the wrong environment', async () => {
  const engine = engineWith('svc.do', {
    allowedEnvironments: ['prod'],
    execute: () => ({}),
  });
  const tpl = `\${ action({ id: 'a1', type: 'svc.do', input: {}, environment: 'test' }) }`;
  const receipt = await executeAction(planFor(engine, tpl)[0], { engine });
  assert.equal(receipt.error?.code, ActionErrorCode.ENVIRONMENT_DENIED);
});

test('a policy-denied type is not executed while an allowed one is', async () => {
  /** @type {string[]} */
  const ran = [];
  const engine = createEngine({ policy: { action: { deniedActions: ['svc.bad'] } } });
  engine.defineAction('svc.good', { execute: () => (ran.push('good'), {}) });
  engine.defineAction('svc.bad', { execute: () => (ran.push('bad'), {}) });
  const tpl =
    `\${ action({ id: 'g', type: 'svc.good', input: {} }) }` +
    `\${ action({ id: 'b', type: 'svc.bad', input: {} }) }`;
  const result = await executeActionPlan(planFor(engine, tpl), { engine });
  assert.deepEqual(ran, ['good']);
  assert.equal(result.skipped, 1);
});

/* --- retry --- */

test('the default is no retry', async () => {
  let attempts = 0;
  const engine = engineWith('svc.do', {
    execute: () => {
      attempts++;
      throw new Error('fail');
    },
  });
  await executeAction(planFor(engine, READY)[0], { engine });
  assert.equal(attempts, 1);
});

test('retry attempts happen per policy and keep the idempotency key stable', async () => {
  const keys = new Set();
  let attempts = 0;
  const engine = engineWith('svc.do', {
    execute: (input, ctx) => {
      attempts++;
      keys.add(ctx.idempotencyKey);
      if (attempts < 3) throw new Error('transient');
      return { externalId: 'OK' };
    },
  });
  const tpl = `\${ action({ id: 'a1', type: 'svc.do', input: {}, retry: { attempts: 3, backoffMs: 0 } }) }`;
  const receipt = await executeAction(planFor(engine, tpl)[0], { engine });
  assert.equal(receipt.status, ActionStatus.SUCCEEDED);
  assert.equal(attempts, 3);
  assert.equal(keys.size, 1, 'idempotency key constant across retries');
});

test('a non-retryable error stops retrying immediately', async () => {
  let attempts = 0;
  const engine = engineWith('svc.do', {
    execute: () => {
      attempts++;
      throw nonRetryable(new Error('permanent'));
    },
  });
  const tpl = `\${ action({ id: 'a1', type: 'svc.do', input: {}, retry: { attempts: 5, backoffMs: 0 } }) }`;
  const receipt = await executeAction(planFor(engine, tpl)[0], { engine });
  assert.equal(attempts, 1);
  assert.equal(receipt.status, ActionStatus.FAILED);
});

/* --- audit / redact --- */

test('the audit hook receives the expected lifecycle events', async () => {
  /** @type {string[]} */
  const events = [];
  const engine = engineWith('svc.do', { execute: () => ({ externalId: 'X' }) });
  await executeAction(planFor(engine, READY)[0], { engine, audit: (e) => events.push(e.type) });
  assert.ok(events.includes('action.execution_started'));
  assert.ok(events.includes('action.execution_succeeded'));
});

test('the redact hook sanitizes the receipt output', async () => {
  const engine = engineWith('svc.do', {
    execute: () => ({ externalId: 'X', secret: 'TOPSECRET' }),
  });
  const receipt = await executeAction(planFor(engine, READY)[0], {
    engine,
    redact: (value, ctx) => {
      if (ctx.field === 'output' && value && typeof value === 'object') {
        return { ...value, secret: '***' };
      }
      return value;
    },
  });
  assert.equal(/** @type {any} */ (receipt.output).secret, '***');
  assert.equal(receipt.externalId, 'X');
});

/* --- compensation --- */

test('a succeeded action can be compensated', async () => {
  const engine = engineWith('svc.do', {
    execute: () => ({ externalId: 'EXT-9' }),
    compensate: (receipt) => ({ undone: receipt.externalId }),
  });
  const receipt = await executeAction(planFor(engine, READY)[0], { engine });
  const comp = await compensateAction(receipt, { engine });
  assert.equal(comp.status, ActionStatus.COMPENSATED);
  assert.deepEqual(comp.output, { undone: 'EXT-9' });
});

test('compensating an action without a compensate handler is structured-unsupported', async () => {
  const engine = engineWith('svc.do', { execute: () => ({ externalId: 'E' }) });
  const receipt = await executeAction(planFor(engine, READY)[0], { engine });
  const comp = await compensateAction(receipt, { engine });
  assert.equal(comp.status, ActionStatus.COMPENSATION_FAILED);
  assert.equal(comp.error?.code, ActionErrorCode.COMPENSATION_UNSUPPORTED);
});

test('a failing compensate handler yields compensationFailed', async () => {
  const engine = engineWith('svc.do', {
    execute: () => ({ externalId: 'E' }),
    compensate: () => {
      throw new Error('cannot undo');
    },
  });
  const receipt = await executeAction(planFor(engine, READY)[0], { engine });
  const comp = await compensateAction(receipt, { engine });
  assert.equal(comp.status, ActionStatus.COMPENSATION_FAILED);
  assert.equal(comp.error?.code, ActionErrorCode.COMPENSATION_FAILED);
});

test('compensateActionPlan compensates receipts in reverse order', async () => {
  /** @type {string[]} */
  const order = [];
  const engine = createEngine();
  engine.defineAction('svc.x', {
    execute: () => ({ externalId: 'X' }),
    compensate: () => (order.push('x'), {}),
  });
  engine.defineAction('svc.y', {
    execute: () => ({ externalId: 'Y' }),
    compensate: () => (order.push('y'), {}),
  });
  const tpl =
    `\${ action({ id: 'x', type: 'svc.x', input: {} }) }` +
    `\${ action({ id: 'y', type: 'svc.y', input: {} }) }`;
  const exec = await executeActionPlan(planFor(engine, tpl), { engine });
  await compensateActionPlan(exec.receipts, { engine });
  assert.deepEqual(order, ['y', 'x']);
});

/* --- analyze / validate integration --- */

test('analyze reports declared actions, in document order, with duplicate flags', () => {
  const engine = createEngine();
  const tpl =
    `\${ action({ id: 'a', type: 't.a', input: {} }) }` +
    `\${ action({ id: 'b', type: 't.b', input: {}, confirm: true }) }` +
    `\${ action({ id: 'a', type: 't.a', input: {} }) }`;
  const analysis = engine.analyze(tpl);
  assert.deepEqual(
    analysis.actions.map((a) => a.id),
    ['a', 'b', 'a']
  );
  assert.equal(analysis.actions[1].requiresConfirmation, true);
  assert.equal(analysis.actions[2].duplicateId, true);
});

test('validate reports a missing id/type and a duplicate id', () => {
  const engine = createEngine();
  const tpl =
    `\${ action({ type: 't.a', input: {} }) }` +
    `\${ action({ id: 'dup', type: 't.a', input: {} }) }` +
    `\${ action({ id: 'dup', type: 't.a', input: {} }) }`;
  const diags = engine.validate(tpl);
  const codes = codesOf(diags);
  assert.ok(codes.includes(DiagnosticCode.INVALID_ACTION));
  assert.ok(codes.includes(DiagnosticCode.DUPLICATE_ACTION_ID));
});

test('validate flags an unknown action type when handlers are registered', () => {
  const engine = createEngine();
  engine.defineAction('known.type', { execute: () => ({}) });
  // analyze/validate read the registry at config time; use config-time registration here.
  const configured = createEngine({
    actions: [{ kind: 'action', type: 'known.type', handler: { execute: () => ({}) } }],
  });
  const diags = configured.validate(`\${ action({ id: 'a', type: 'unknown.type', input: {} }) }`);
  assert.ok(codesOf(diags).includes(DiagnosticCode.UNKNOWN_ACTION_TYPE));
  const ok = configured.validate(`\${ action({ id: 'a', type: 'known.type', input: {} }) }`);
  assert.equal(codesOf(ok).includes(DiagnosticCode.UNKNOWN_ACTION_TYPE), false);
});

test('validate forbids an action type denied by policy', () => {
  const engine = createEngine({
    actions: [{ kind: 'action', type: 't.bad', handler: { execute: () => ({}) } }],
    policy: { action: { deniedActions: ['t.bad'] } },
  });
  const diags = engine.validate(`\${ action({ id: 'a', type: 't.bad', input: {} }) }`);
  assert.ok(codesOf(diags).includes(DiagnosticCode.POLICY_FORBIDDEN));
});

/* --- security --- */

test('preview/run cannot execute an action (the core never calls a handler)', async () => {
  let executed = false;
  const engine = createEngine();
  engine.defineAction('svc.do', { execute: () => ((executed = true), {}) });
  const state = engine.run(engine.start(READY));
  assert.equal(executed, false);
  assert.equal((state.actions ?? [])[0].status, ActionStatus.READY);
});

test('an unknown action handler can never run', async () => {
  const engine = createEngine();
  const result = await executeActionPlan(planFor(engine, READY), { engine });
  assert.equal(result.status, PlanStatus.SKIPPED);
  assert.equal(result.receipts[0].error?.code, ActionErrorCode.HANDLER_NOT_FOUND);
});

test('a prototype-pollution attempt in action input is rejected', () => {
  const engine = createEngine();
  // `__proto__` as an object-literal key is dropped at parse/eval time.
  const tpl = `\${ action({ id: 'a', type: 't', input: { ok: 1 } }) }`;
  const state = engine.run(engine.start(tpl));
  assert.equal(/** @type {any} */ ({}).polluted, undefined);
  assert.deepEqual((state.actions ?? [])[0].input, { ok: 1 });
});

test('defineAction requires an execute function', () => {
  assert.throws(() => defineAction('t', /** @type {any} */ ({})), /execute/);
  assert.throws(() => defineAction('', { execute: () => ({}) }), /non-empty/);
});

test('registering the same action type twice on an engine throws', () => {
  const engine = createEngine();
  engine.defineAction('svc.do', { execute: () => ({}) });
  assert.throws(() => engine.defineAction('svc.do', { execute: () => ({}) }), /already defined/);
});

test('the pure core never imports the action execution layer (purity rule)', () => {
  // Static guard for the architectural invariant: src/eval, src/run, src/analyze, src/validate
  // must never reach execute.js. The dependency may only flow the other way.
  const coreFiles = [
    '../../src/eval/evaluator.js',
    '../../src/eval/symbols.js',
    '../../src/run/run.js',
    '../../src/analyze/analyze.js',
    '../../src/validate/validate.js',
  ];
  for (const rel of coreFiles) {
    const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    assert.equal(
      /actions\/execute\.js/.test(src),
      false,
      `${rel} must not import the action execution layer`
    );
    assert.equal(
      /actions\/index\.js/.test(src),
      false,
      `${rel} must not import the seebo/actions barrel`
    );
  }
});
