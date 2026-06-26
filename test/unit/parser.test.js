/**
 * @file Unit — parser (IMPL §3). The precedence table is a contract that can be checked
 * now; `parse` behavior is PENDING until implemented.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRECEDENCE, parse } from '../../src/parser/index.js';
import { realEngine, assertNotImplemented, PENDING } from '../helpers/index.js';

test('PRECEDENCE table matches SPEC §1.4 ordering (* tighter than +, ?: loosest)', () => {
  assert.ok(PRECEDENCE['*'].binding > PRECEDENCE['+'].binding);
  assert.ok(PRECEDENCE['+'].binding > PRECEDENCE['<'].binding);
  assert.ok(PRECEDENCE['<'].binding > PRECEDENCE['=='].binding);
  assert.ok(PRECEDENCE['=='].binding > PRECEDENCE['and'].binding);
  assert.ok(PRECEDENCE['and'].binding > PRECEDENCE['or'].binding);
  assert.ok(PRECEDENCE['or'].binding > PRECEDENCE['??'].binding);
  assert.ok(PRECEDENCE['??'].binding > PRECEDENCE['?:'].binding);
  assert.equal(PRECEDENCE['??'].assoc, 'right');
  assert.equal(PRECEDENCE['?:'].assoc, 'right');
});

test('parse is a placeholder in v1 (throws NotImplemented)', () => {
  assertNotImplemented(() => parse('${ 1 }'));
});

// IMPL §3 / SPEC §2.3 — parse builds a left-leaning tree per precedence.
//   Input: ${ 1 + 2 * 3 }
//   Expected expr: Binary(+, Lit 1, Binary(*, Lit 2, Lit 3))
test('IMPL §3 — parse respects precedence in the AST', PENDING, () => {
  const engine = realEngine();
  const doc = engine.parse('${ 1 + 2 * 3 }');
  const expr = /** @type {any} */ (doc.nodes[0]).expr;
  assert.equal(expr.kind, 'Binary');
  assert.equal(expr.op, '+');
  assert.equal(expr.right.kind, 'Binary');
  assert.equal(expr.right.op, '*');
});

// IMPL §3 — `match` is desugared into nested ternaries (no Match node downstream).
//   Input: ${ n match { 1 => 'a', * => 'b' } }  → Ternary at the root.
test('IMPL §3 — match desugars into ternaries', PENDING, () => {
  const engine = realEngine({ capabilities: { user: () => undefined } });
  const doc = engine.parse(
    "${ require({id:'n',type:int(),capability:'user'}) match { 1 => 'a', * => 'b' } }"
  );
  const expr = /** @type {any} */ (doc.nodes[0]).expr;
  assert.equal(expr.kind, 'Ternary');
});
