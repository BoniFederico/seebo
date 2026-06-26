/**
 * @file Unit — suspendable evaluator (IMPL §5/§6.4): three-way results, lazy gating,
 * requirement suspension, and the `createEvaluator` step/resume handle.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResultKind, evaluate, evaluateDocument, createEvaluator } from '../../src/eval/evaluator.js';
import { realEngine } from '../helpers/index.js';

/** @param {string} type @param {unknown} value */
const lit = (type, value) => ({ kind: 'Lit', position: { start: 0, end: 1 }, type, value });
/** Minimal evaluation context (no declarations). @param {Record<string, unknown>} [resolved] */
const ctx = (resolved = {}) => ({
  resolved,
  symbols: new Map(),
  needs: new Map(),
  config: {},
  clock: () => new Date(0),
});

const engine = realEngine({ capabilities: { user: () => undefined } });

test('ResultKind is the three-way Ok|Susp|Err (IMPL §5)', () => {
  assert.deepEqual(ResultKind, { OK: 'Ok', SUSP: 'Susp', ERR: 'Err' });
});

test('IMPL §5 — a literal evaluates to Ok(value)', () => {
  const res = evaluate(/** @type {any} */ (lit('int', 1)), ctx());
  assert.equal(res.kind, ResultKind.OK);
  assert.equal(/** @type {any} */ (res).value.value, 1);
});

test('IMPL §5 — a type mismatch yields Err(TYPE_ERROR_RUNTIME)', () => {
  const expr = {
    kind: 'Binary',
    position: { start: 0, end: 1 },
    op: '+',
    left: lit('string', 'a'),
    right: lit('int', 1),
  };
  const res = evaluate(/** @type {any} */ (expr), ctx());
  assert.equal(res.kind, ResultKind.ERR);
  assert.equal(/** @type {any} */ (res).diagnostic.code, 'TYPE_ERROR_RUNTIME');
});

test('IMPL §5 — an unsatisfied required requirement yields Susp(Need)', () => {
  const c = ctx();
  const req = engine.parse("${ require({ id:'x', type:string(), capability:'user' }) }").nodes[0];
  const res = evaluate(/** @type {any} */ (req).expr, c);
  assert.equal(res.kind, ResultKind.SUSP);
  assert.equal(/** @type {any} */ (res).need.id, 'x');
  assert.ok(c.needs.has('x')); // recorded for batch resolution
});

test('IMPL §5 — a resolved requirement evaluates to its value', () => {
  const req = engine.parse("${ require({ id:'x', type:string(), capability:'user' }) }").nodes[0];
  const res = evaluate(/** @type {any} */ (req).expr, ctx({ x: 'hi' }));
  assert.equal(res.kind, ResultKind.OK);
  assert.equal(/** @type {any} */ (res).value.value, 'hi');
});

test('IMPL §5 — optional requirement resolves to the empty value', () => {
  const req = engine.parse(
    "${ require({ id:'x', type:string(), capability:'user', optional:true }) }"
  ).nodes[0];
  const res = evaluate(/** @type {any} */ (req).expr, ctx());
  assert.equal(res.kind, ResultKind.OK);
  assert.equal(/** @type {any} */ (res).value.value, '');
});

test('IMPL §5 — default takes precedence over Need', () => {
  const req = engine.parse(
    "${ require({ id:'x', type:string().default('N/D'), capability:'user' }) }"
  ).nodes[0];
  const res = evaluate(/** @type {any} */ (req).expr, ctx());
  assert.equal(res.kind, ResultKind.OK);
  assert.equal(/** @type {any} */ (res).value.value, 'N/D');
});

test('IMPL §5 — lazy ternary gates the Need in the non-taken branch', () => {
  const ast = engine.parse(
    "${ flag ? require({id:'x', type:string(), capability:'user'}) : 'ok' }"
  );
  // flag=false → else branch → no Need emitted
  const off = evaluateDocument(ast, { flag: false }, {});
  assert.equal(off.status, 'completed');
  assert.equal(off.output, 'ok');
  // flag=true → then branch → Need 'x'
  const on = evaluateDocument(ast, { flag: true }, {});
  assert.equal(on.status, 'waiting');
  assert.deepEqual(on.pending.map((/** @type {any} */ p) => p.id), ['x']);
});

test('IMPL §5 — independent Needs are collected in one pass (batch)', () => {
  const ast = engine.parse(
    "${ require({id:'a', type:string(), capability:'user'}) }${ require({id:'b', type:string(), capability:'user'}) }"
  );
  const r = evaluateDocument(ast, {}, {});
  assert.equal(r.status, 'waiting');
  assert.deepEqual(
    r.pending.map((/** @type {any} */ p) => p.id).sort(),
    ['a', 'b']
  );
});

/* ----------------------------------------------------------------------------------- *
 * createEvaluator: step / resume
 * ----------------------------------------------------------------------------------- */

test('createEvaluator: step suspends, resume completes', () => {
  const ast = engine.parse("Hello ${ require({id:'who', type:string(), capability:'user'}) }!");
  const ev = createEvaluator(ast, { config: engine.config });

  const s1 = ev.step();
  assert.equal(s1.status, 'waiting');
  assert.deepEqual(s1.pending.map((/** @type {any} */ p) => p.id), ['who']);
  assert.equal(s1.phase, 1);

  const s2 = ev.resume({ who: 'World' });
  assert.equal(s2.status, 'completed');
  assert.equal(s2.output, 'Hello World!');
  assert.equal(s2.phase, 2);
});

test('createEvaluator: run() drives via the provided async driver', async () => {
  const ast = engine.parse("Hi ${ require({id:'name', type:string(), capability:'user'}) }");
  const ev = createEvaluator(ast, { config: engine.config }, async (pending) => {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const need of pending) out[need.id] = 'Ada';
    return out;
  });
  const snap = await ev.run();
  assert.equal(snap.status, 'completed');
  assert.equal(snap.output, 'Hi Ada');
});

test('createEvaluator: run() stops when the driver makes no progress', async () => {
  const ast = engine.parse("Hi ${ require({id:'name', type:string(), capability:'user'}) }");
  const ev = createEvaluator(ast, { config: engine.config }, async () => ({}));
  const snap = await ev.run();
  assert.equal(snap.status, 'waiting');
});
