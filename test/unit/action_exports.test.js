/**
 * @file Unit — public package exports for the action system (SPEC §2.8, §19). Verifies that
 * `seebo/actions` resolves through the package `exports` map (Node self-reference) and exposes
 * the documented execution API, that the main `seebo` entry still works unchanged, and that the
 * action contract enums are re-exported from the root.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as root from '../../src/index.js';
import * as actions from '../../src/actions/index.js';

test("'seebo/actions' self-resolves through the package exports map", async () => {
  // Node resolves a package's own name when `exports` is declared (self-reference). This is the
  // exact path a host uses: `import { executeActionPlan } from 'seebo/actions'`.
  const subpath = await import('seebo/actions');
  assert.equal(typeof subpath.executeActionPlan, 'function');
  const main = await import('seebo');
  assert.equal(typeof main.createEngine, 'function');
});

test('seebo/actions exposes the generic execution layer', () => {
  for (const name of [
    'executeAction',
    'executeActionPlan',
    'dryRunAction',
    'dryRunActionPlan',
    'compensateAction',
    'compensateActionPlan',
  ]) {
    assert.equal(
      typeof (/** @type {Record<string, unknown>} */ (actions)[name]),
      'function',
      `missing ${name}`
    );
  }
});

test('seebo/actions re-exports the public action contracts and pure helpers', () => {
  for (const name of [
    'ActionStatus',
    'ActionErrorCode',
    'ActionEventType',
    'PlanStatus',
    'nonRetryable',
    'isFailureStatus',
    'computeIdempotencyKey',
    'normalizeActionInput',
    'findDuplicateActionId',
    'decideAction',
    'checkPermissions',
    'checkHandlerEnvironment',
  ]) {
    assert.ok(name in actions, `missing export: ${name}`);
  }
});

test('the root seebo entry adds defineAction and the action enums (additive)', () => {
  assert.equal(typeof root.defineAction, 'function');
  for (const name of ['ActionStatus', 'ActionErrorCode', 'ActionEventType', 'PlanStatus']) {
    assert.ok(name in root, `missing root re-export: ${name}`);
  }
});

test('createEngine exposes engine.defineAction', () => {
  const engine = root.createEngine();
  assert.equal(typeof engine.defineAction, 'function');
});
