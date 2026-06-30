/**
 * @file Unit — value bindings (`bind`) and lazy need/action declarations (`prepare`), SPEC §1.7.
 * `bind(name, type)` names a pure value; `prepare(need(...) | action(...))` declares a need/action
 * lazily for reuse by its own id. Both are read **plain** (`${ name }`) and never activate at the
 * declaration site. Covers value bindings, the bind value-only rule, prepare's lazy semantics, and
 * the `UNDECLARED_NAME` rule.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createEngine } from '../../src/index.js';
import { makeInt } from '../../src/runtime/values.js';

/** An engine with an inert `input` capability. */
function engineWithInput() {
  return createEngine({ capabilities: { input: () => undefined } });
}

/** Returns the action plan of a run state. @param {import('../../src/run/run.js').PublicState} s */
function actionsOf(s) {
  return s.actions ?? [];
}

/* --- bind: value bindings only --- */

test('bind a value and read it plain', () => {
  const engine = createEngine();
  const state = engine.run(engine.start(`\${ bind('vat', float().default(0.22)) }VAT=\${ vat }`));
  assert.equal(state.status, 'completed');
  assert.equal(state.output, 'VAT=0,22');
});

test('a value binding emits nothing at the bind site (declaration only)', () => {
  const engine = createEngine();
  const state = engine.run(engine.start(`[\${ bind('x', int().default(7)) }]`));
  assert.equal(state.output, '[]');
});

test('a value binding with a builder chain (.default/.constraints) is valid (no UNKNOWN_METHOD)', () => {
  const engine = createEngine();
  assert.equal(engine.validate(`\${ bind('x', int().default(1)) }\${ x }`).length, 0);
  assert.equal(
    engine.validate(`\${ bind('x', string().constraints({ maxLen: 5 })) }\${ x }`).length,
    0
  );
});

test('a value binding is type-checked at its references using the builder type', () => {
  const engine = createEngine();
  assert.equal(engine.validate(`\${ bind('n', int().default(1)) }\${ n + 1 }`).length, 0);
});

test('a value binding without a value or default fails at run', () => {
  const engine = createEngine();
  const state = engine.run(engine.start(`\${ bind('x', int()) }\${ x }`));
  assert.equal(state.status, 'failed');
});

test('a duplicate bind id keeps the first declaration (static scope, first wins)', () => {
  const engine = createEngine();
  const state = engine.run(
    engine.start(`\${ bind('x', int().default(1)) }\${ bind('x', int().default(2)) }\${ x }`)
  );
  assert.equal(state.status, 'completed');
  assert.equal(state.output, '1');
});

test('bind rejects a need(...) descriptor, pointing to prepare', () => {
  const engine = engineWithInput();
  const diags = engine.validate(`\${ bind('x', need('input')) }\${ x }`);
  const syntax = diags.find((d) => d.code === 'SYNTAX_ERROR');
  assert.ok(syntax);
  assert.match(syntax.message, /prepare\(need\(\.\.\.\)\)/);
});

test('bind rejects an action(...) descriptor, pointing to prepare', () => {
  const engine = createEngine();
  const diags = engine.validate(`\${ bind('x', action({ type:'t', input:{} })) }\${ x }`);
  assert.ok(diags.some((d) => d.code === 'SYNTAX_ERROR' && /prepare\(action/.test(d.message)));
});

test('a bind descriptor that is a bare literal is reported as a SYNTAX_ERROR', () => {
  const engine = createEngine();
  const diags = engine.validate(`\${ bind('x', 5) }\${ x }`);
  assert.ok(diags.some((d) => d.code === 'SYNTAX_ERROR'));
});

test('bind without a descriptor is a structured error', () => {
  const engine = createEngine();
  const diags = engine.validate(`\${ bind('x') }`);
  assert.ok(diags.some((d) => d.code === 'SYNTAX_ERROR'));
});

/* --- prepare: lazy need declarations --- */

test('prepare(need) is lazy: an unreferenced need emits no Need', () => {
  const engine = engineWithInput();
  const state = engine.run(
    engine.start(`\${ prepare(need({ id:'amount', capability:'input', type:int() })) }done`)
  );
  assert.equal(state.status, 'completed');
  assert.equal(state.pending.length, 0);
});

test('prepare(need) referenced in an untaken branch emits no Need', () => {
  const engine = engineWithInput();
  const tpl =
    `\${ prepare(need({ id:'amount', capability:'input', type:int() })) }` +
    `\${ 1 == 2 ? amount : 'ciao' }`;
  const state = engine.run(engine.start(tpl));
  assert.equal(state.status, 'completed');
  assert.equal(state.output, 'ciao');
  assert.equal(state.pending.length, 0);
});

test('prepare(need) referenced in a taken branch surfaces the Need, then resolves', () => {
  const engine = engineWithInput();
  const tpl =
    `\${ prepare(need({ id:'amount', capability:'input', type:int() })) }` + `Amount: \${ amount }`;
  let state = engine.run(engine.start(tpl));
  assert.equal(state.status, 'waiting');
  assert.deepEqual(
    state.pending.map((p) => p.id),
    ['amount']
  );
  state.resolved.amount = makeInt(42);
  state = engine.run(state);
  assert.equal(state.output, 'Amount: 42');
});

test("prepare(cap('id')) sugar declares the need by id", () => {
  const engine = engineWithInput();
  const state = engine.run(engine.start(`\${ prepare(input('amount')) }\${ amount }`));
  assert.equal(state.status, 'waiting');
  assert.deepEqual(
    state.pending.map((p) => p.id),
    ['amount']
  );
});

test('prepare(...) with a non-need/action argument is a SYNTAX_ERROR', () => {
  const engine = createEngine();
  assert.ok(engine.validate(`\${ prepare(int()) }`).some((d) => d.code === 'SYNTAX_ERROR'));
});

/* --- prepare: lazy action declarations --- */

test('prepare(action) is activated by its id, emits empty string', () => {
  const engine = createEngine();
  engine.defineAction('svc.do', { execute: () => ({ externalId: 'X' }) });
  const tpl = `\${ prepare(action({ id:'ticket', type:'svc.do', input:{ x:1 } })) }before \${ ticket }after`;
  const state = engine.run(engine.start(tpl));
  assert.equal(state.output, 'before after');
  assert.equal(actionsOf(state).length, 1);
  assert.equal(actionsOf(state)[0].id, 'ticket');
  assert.equal(actionsOf(state)[0].status, 'ready');
  assert.deepEqual(actionsOf(state)[0].input, { x: 1 });
});

test('a prepared action is NOT activated until its id is referenced', () => {
  const engine = createEngine();
  engine.defineAction('svc.do', { execute: () => ({}) });
  const state = engine.run(
    engine.start(`\${ prepare(action({ id:'ghost', type:'svc.do', input:{} })) }no ref`)
  );
  assert.equal(actionsOf(state).length, 0);
});

test('a prepared action referenced twice is collected once', () => {
  const engine = createEngine();
  engine.defineAction('svc.do', { execute: () => ({}) });
  const state = engine.run(
    engine.start(`\${ prepare(action({ id:'t', type:'svc.do', input:{} })) }\${ t }\${ t }`)
  );
  assert.equal(actionsOf(state).length, 1);
});

test('a prepared action gated behind a false branch is not activated', () => {
  const engine = createEngine();
  engine.defineAction('svc.do', { execute: () => ({}) });
  const state = engine.run(
    engine.start(`\${ prepare(action({ id:'t', type:'svc.do', input:{} })) }\${ true ? '' : t }`)
  );
  assert.equal(actionsOf(state).length, 0);
});

test('prepare(action) requires a string id in the descriptor', () => {
  const engine = createEngine();
  // No id ⇒ the action is not registered, so `${ x }` is undeclared (and the prepare itself errors).
  const diags = engine.validate(`\${ prepare(action({ type:'svc.do', input:{} })) }`);
  assert.ok(diags.some((d) => d.code === 'INVALID_ACTION' || d.code === 'SYNTAX_ERROR'));
});

test('a prepared action whose input has an unresolved need is blocked and surfaces the Need', () => {
  const engine = engineWithInput();
  engine.defineAction('svc.do', { execute: () => ({}) });
  const tpl =
    `\${ prepare(action({ id:'t', type:'svc.do', input:{ s: need({ id:'x', capability:'input', type:string() }) } })) }` +
    `\${ t }`;
  const state = engine.run(engine.start(tpl));
  assert.equal(state.status, 'waiting');
  assert.deepEqual(
    state.pending.map((p) => p.id),
    ['x']
  );
  assert.equal(actionsOf(state)[0].status, 'blocked');
});

test('a prepared action whose id collides with a value binding is flagged (not silently dropped)', () => {
  const engine = createEngine();
  engine.defineAction('svc.do', { execute: () => ({}) });
  // The symbol table is first-wins, so the value binding 'x' would shadow the action and drop it
  // from the plan; validate must surface the collision instead of letting the effect vanish.
  const tpl =
    `\${ bind('x', int().default(5)) }` +
    `\${ prepare(action({ id:'x', type:'svc.do', input:{} })) }\${ x }`;
  assert.ok(engine.validate(tpl).some((d) => d.code === 'DUPLICATE_ACTION_ID'));
});

test("repeated cap('id') for the same requirement is NOT a duplicate", () => {
  const engine = engineWithInput();
  // The same need referenced twice via the sugar is one requirement, not a collision.
  assert.equal(engine.validate(`\${ input('amount') } / \${ input('amount') }`).length, 0);
});

/* --- references --- */

test('a reference to an undeclared name is UNDECLARED_NAME (no implicit binding)', () => {
  const engine = createEngine();
  assert.ok(engine.validate(`\${ unknownName }`).some((d) => d.code === 'UNDECLARED_NAME'));
});
