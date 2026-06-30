/**
 * @file Conformance — security hardening (SPEC §1.11, IMPL §13). Each configurable limit,
 * when exceeded, fails with a specific diagnostic code; prototype-pollution attempts via
 * requirement ids never reach `Object.prototype`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realEngine, assertHasCode } from '../helpers/index.js';
import { DiagnosticCode } from '../../src/util/errors.js';
import { Status } from '../../src/run/run.js';

/** Asserts that `engine.parse(t)` throws with the given diagnostic code. @param {any} engine @param {string} t @param {string} code */
function throwsCode(engine, t, code) {
  assert.throws(
    () => engine.parse(t),
    (e) => /** @type {any} */ (e).code === code,
    `expected parse to throw ${code}`
  );
}

/* ----------------------------------------------------------------------------------- *
 * Parse-time limits (input length, tokens, nodes, nesting) — IMPL §13
 * ----------------------------------------------------------------------------------- */

test('IMPL §13 — input length over maxInputBytes ⇒ INPUT_LIMIT_EXCEEDED', () => {
  const engine = realEngine({ limits: { maxInputBytes: 4 } });
  throwsCode(engine, '${ 1 }', DiagnosticCode.INPUT_LIMIT_EXCEEDED);
  // The same limit surfaces as a failed state through run().
  const state = engine.run(engine.start('${ 1 }'));
  assert.equal(state.status, Status.FAILED);
  assertHasCode(state.diagnostics ?? [], DiagnosticCode.INPUT_LIMIT_EXCEEDED);
});

test('IMPL §13 — token count over maxTokens ⇒ TOKEN_LIMIT_EXCEEDED', () => {
  const engine = realEngine({ limits: { maxTokens: 2 } });
  throwsCode(engine, '${ 1 + 2 }', DiagnosticCode.TOKEN_LIMIT_EXCEEDED);
});

test('IMPL §13 — AST node count over maxNodes ⇒ NODE_LIMIT_EXCEEDED', () => {
  const engine = realEngine({ limits: { maxNodes: 2 } });
  throwsCode(engine, '${ 1 + 2 + 3 + 4 }', DiagnosticCode.NODE_LIMIT_EXCEEDED);
});

test('IMPL §13 — nesting depth over maxNestingDepth ⇒ NESTING_LIMIT_EXCEEDED', () => {
  const engine = realEngine({ limits: { maxNestingDepth: 3 } });
  throwsCode(engine, '${ ((((1)))) }', DiagnosticCode.NESTING_LIMIT_EXCEEDED);
});

test('limits are off the hot path: normal templates parse under the defaults', () => {
  const engine = realEngine();
  assert.equal(engine.run(engine.start('${ 1 + 2 * 3 }')).output, '7');
});

/* ----------------------------------------------------------------------------------- *
 * Run-time limit (evaluator steps) — IMPL §13
 * ----------------------------------------------------------------------------------- */

test('IMPL §13 — evaluator steps over maxSteps ⇒ STEP_LIMIT_EXCEEDED', () => {
  const engine = realEngine({ limits: { maxSteps: 2 } });
  const state = engine.run(engine.start('${ 1 + 2 + 3 + 4 }'));
  assert.equal(state.status, Status.FAILED);
  assertHasCode(state.diagnostics ?? [], DiagnosticCode.STEP_LIMIT_EXCEEDED);
});

/* ----------------------------------------------------------------------------------- *
 * Output size (emission) — SPEC §1.11 / IMPL §13
 * ----------------------------------------------------------------------------------- */

test('IMPL §13 — output over maxOutputBytes ⇒ OUTPUT_LIMIT_EXCEEDED', () => {
  const engine = realEngine({ limits: { maxOutputBytes: 4 } });
  const state = engine.run(engine.start('Hello, world')); // 12 bytes > 4
  assert.equal(state.status, Status.FAILED);
  assertHasCode(state.diagnostics ?? [], DiagnosticCode.OUTPUT_LIMIT_EXCEEDED);
});

test('output within maxOutputBytes completes normally (UTF-8 measured)', () => {
  const engine = realEngine({ limits: { maxOutputBytes: 4 } });
  // "€" is 3 UTF-8 bytes, under the limit.
  const state = engine.run(engine.start('€'));
  assert.equal(state.status, Status.COMPLETED);
  assert.equal(state.output, '€');
});

/* ----------------------------------------------------------------------------------- *
 * State versioning (IMPL §14) — reject a state from a newer engine
 * ----------------------------------------------------------------------------------- */

test('IMPL §14 — a future stateVersion is rejected with UNSUPPORTED_STATE_VERSION', () => {
  const engine = realEngine();
  const fromTheFuture = { ...engine.start('${ 1 }'), stateVersion: 999 };
  const state = engine.run(fromTheFuture);
  assert.equal(state.status, Status.FAILED);
  assertHasCode(state.diagnostics ?? [], DiagnosticCode.UNSUPPORTED_STATE_VERSION);
  const d = (state.diagnostics ?? []).find(
    (x) => x.code === DiagnosticCode.UNSUPPORTED_STATE_VERSION
  );
  assert.deepEqual(d?.data, { found: 999, supported: 1 });
});

test('IMPL §14 — a current-version state runs normally', () => {
  const engine = realEngine();
  const state = engine.run(engine.start('${ 1 + 1 }'));
  assert.equal(state.status, Status.COMPLETED);
  assert.equal(state.output, '2');
});

/* ----------------------------------------------------------------------------------- *
 * Macro recursion (EXPAND) — IMPL §10.1/§13
 * ----------------------------------------------------------------------------------- */

test('IMPL §13 — inclusion depth over maxDepth ⇒ DEPTH_EXCEEDED (failed state)', async () => {
  const engine = realEngine({ limits: { maxDepth: 1 } });
  const res = await engine.stebo({
    template: "@{ABSORB('a')}",
    templates: { a: "@{ABSORB('b')}", b: 'leaf' },
  });
  assert.equal(res.status, Status.FAILED);
  assertHasCode(res.diagnostics ?? [], DiagnosticCode.DEPTH_EXCEEDED);
});

/* ----------------------------------------------------------------------------------- *
 * Prototype-pollution protection — IMPL §13
 * ----------------------------------------------------------------------------------- */

test('a __proto__ initial value never pollutes Object.prototype', () => {
  const engine = realEngine();
  engine.run(engine.start('${ 1 }', { __proto__: { polluted: true } }));
  assert.equal(/** @type {any} */ ({}).polluted, undefined);
});

test('a requirement declared as __proto__ never pollutes Object.prototype', async () => {
  const engine = realEngine({ capabilities: { user: () => ({ polluted: true }) } });
  await engine.stebo({
    template: "${ need({ id:'__proto__', type:object(), capability:'user' }) }",
  });
  assert.equal(/** @type {any} */ ({}).polluted, undefined);
});

test('a __proto__ key inside an object literal is dropped (no pollution)', () => {
  const engine = realEngine();
  // The object has two written keys but `__proto__` is dropped, so only `a` remains.
  const state = engine.run(
    engine.start('${ { __proto__: { polluted: true }, a: 1 }.keys().len() }')
  );
  assert.equal(state.status, Status.COMPLETED);
  assert.equal(state.output, '1');
  assert.equal(/** @type {any} */ ({}).polluted, undefined);
});
