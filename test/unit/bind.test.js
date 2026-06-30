/**
 * @file Unit — the unified declarative binding `bind(name, descriptor)` (SPEC §1.7). A binding
 * names a value, a `need(...)` or an `action(...)`, referenced **plain** (`${ name }`) elsewhere.
 * Covers the three natures, the bind-injected id, plain reads, and the `UNDECLARED_NAME` rule.
 * The `need(...)` constructor (the former `require`) is covered by the eval/validate suites.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createEngine } from '../../src/index.js';
import { makeInt } from '../../src/runtime/values.js';

/** An engine with an inert `input` capability (so `need('input')` is registered). */
function engineWithInput() {
  return createEngine({ capabilities: { input: () => undefined } });
}

/** Returns the action plan of a run state. @param {import('../../src/run/run.js').PublicState} s */
function actionsOf(s) {
  return s.actions ?? [];
}

test('bind a value binding and read it plain', () => {
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

test('bind a need: blocked until resolved, then read plain', () => {
  const engine = engineWithInput();
  const tpl = `\${ bind('amount', need({ capability:'input', type:int() })) }Amount: \${ amount }`;
  let state = engine.run(engine.start(tpl));
  assert.equal(state.status, 'waiting');
  assert.deepEqual(
    state.pending.map((p) => p.id),
    ['amount']
  );
  state.resolved.amount = makeInt(42);
  state = engine.run(state);
  assert.equal(state.status, 'completed');
  assert.equal(state.output, 'Amount: 42');
});

test("the bind name supplies the need's id (not repeated in the descriptor)", () => {
  const engine = engineWithInput();
  const state = engine.run(
    engine.start(`\${ bind('email', need({ capability:'input', type:string() })) }\${ email }`)
  );
  assert.deepEqual(
    state.pending.map((p) => p.id),
    ['email']
  );
});

test('an unreferenced need binding emits no Need (reachability)', () => {
  const engine = engineWithInput();
  // Declared but never referenced ⇒ no pending requirement.
  const state = engine.run(
    engine.start(`\${ bind('unused', need({ capability:'input', type:string() })) }done`)
  );
  assert.equal(state.status, 'completed');
  assert.equal(state.pending.length, 0);
});

test('bind an action: activated by name, emits empty string', () => {
  const engine = createEngine();
  engine.defineAction('svc.do', { execute: () => ({ externalId: 'X' }) });
  const tpl = `\${ bind('ticket', action({ type:'svc.do', input:{ x:1 } })) }before \${ ticket }after`;
  const state = engine.run(engine.start(tpl));
  assert.equal(state.output, 'before after');
  assert.equal(actionsOf(state).length, 1);
  assert.equal(actionsOf(state)[0].id, 'ticket');
  assert.equal(actionsOf(state)[0].status, 'ready');
  assert.deepEqual(actionsOf(state)[0].input, { x: 1 });
});

test('an action binding is NOT activated until its name is referenced', () => {
  const engine = createEngine();
  engine.defineAction('svc.do', { execute: () => ({}) });
  const state = engine.run(
    engine.start(`\${ bind('ghost', action({ type:'svc.do', input:{} })) }no ref`)
  );
  assert.equal(actionsOf(state).length, 0);
});

test('an action binding referenced twice is collected once', () => {
  const engine = createEngine();
  engine.defineAction('svc.do', { execute: () => ({}) });
  const state = engine.run(
    engine.start(`\${ bind('t', action({ type:'svc.do', input:{} })) }\${ t }\${ t }`)
  );
  assert.equal(actionsOf(state).length, 1);
});

test('an action binding gated behind a false branch is not activated', () => {
  const engine = createEngine();
  engine.defineAction('svc.do', { execute: () => ({}) });
  const state = engine.run(
    engine.start(`\${ bind('t', action({ type:'svc.do', input:{} })) }\${ true ? '' : t }`)
  );
  assert.equal(actionsOf(state).length, 0);
});

test('a reference to an undeclared name is UNDECLARED_NAME (no implicit binding)', () => {
  const engine = createEngine();
  const diags = engine.validate(`\${ unknownName }`);
  assert.ok(diags.some((d) => d.code === 'UNDECLARED_NAME'));
});

test('bind without a descriptor is a structured error', () => {
  const engine = createEngine();
  const diags = engine.validate(`\${ bind('x') }`);
  assert.ok(diags.some((d) => d.code === 'SYNTAX_ERROR'));
});

test('a value binding without a value or default fails at run', () => {
  const engine = createEngine();
  // bind('x', int()) has no default and no provided value ⇒ reading it is a constraint violation.
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
  // `n` is int, so `n + 1` is valid; a string op on it would be a TYPE_ERROR.
  assert.equal(engine.validate(`\${ bind('n', int().default(1)) }\${ n + 1 }`).length, 0);
});

test('a bind descriptor that is a bare literal is reported as a SYNTAX_ERROR', () => {
  const engine = createEngine();
  const diags = engine.validate(`\${ bind('x', 5) }\${ x }`);
  assert.ok(diags.some((d) => d.code === 'SYNTAX_ERROR'));
});

test('a bound action whose input has an unresolved need is blocked and surfaces the Need', () => {
  const engine = engineWithInput();
  engine.defineAction('svc.do', { execute: () => ({}) });
  const tpl =
    `\${ bind('t', action({ type:'svc.do', input:{ s: need({ id:'x', capability:'input', type:string() }) } })) }` +
    `\${ t }`;
  const state = engine.run(engine.start(tpl));
  assert.equal(state.status, 'waiting');
  assert.deepEqual(
    state.pending.map((p) => p.id),
    ['x']
  );
  assert.equal(actionsOf(state)[0].status, 'blocked');
});
