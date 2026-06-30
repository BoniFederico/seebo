/**
 * @file Conformance — parsing SPEC examples to AST (SPEC §2.3 parse, §1.4 expressions,
 * §1.5/§1.6 producers & capability sugar). Uses the public `engine.parse` end-to-end
 * (lexer → parser) and compares the AST (positions stripped) with `deepEqual`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realEngine, stripPositions } from '../helpers/index.js';

// SPEC §2.3 — the documented parse example: ${ 1 + 2 * 3 }.
// (The spec shows a shorthand AST; this asserts the real node shapes.)
test('SPEC §2.3 — parse("${ 1 + 2 * 3 }") AST', () => {
  const engine = realEngine();
  const ast = stripPositions(engine.parse('${ 1 + 2 * 3 }'));
  assert.deepEqual(ast, {
    astVersion: 1,
    nodes: [
      {
        kind: 'Formula',
        expr: {
          kind: 'Binary',
          op: '+',
          left: { kind: 'Lit', type: 'int', value: 1 },
          right: {
            kind: 'Binary',
            op: '*',
            left: { kind: 'Lit', type: 'int', value: 2 },
            right: { kind: 'Lit', type: 'int', value: 3 },
          },
        },
      },
    ],
  });
});

// SPEC §1.2 — interleaving of text, comment and formula nodes.
test('SPEC §1.2 — text/comment/formula document', () => {
  const engine = realEngine();
  const ast = stripPositions(engine.parse('Da: ${ x } #{ note }'));
  assert.deepEqual(ast, {
    astVersion: 1,
    nodes: [
      { kind: 'Text', value: 'Da: ' },
      { kind: 'Formula', expr: { kind: 'Ref', name: 'x' } },
      { kind: 'Text', value: ' ' },
      { kind: 'Comment' },
    ],
  });
});

// SPEC §1.6 — capability sugar: a registered capability used as a producer is normalized
// to need(..., capability:'<name>') at parse time.
test('SPEC §1.6 — capability producer is normalized to need', () => {
  const engine = realEngine({ capabilities: { secrets: () => undefined } });
  const ast = stripPositions(engine.parse("${ secrets({ id: 'mittente', type: string() }) }"));
  const expr = /** @type {any} */ (ast.nodes[0]).expr;
  assert.equal(expr.kind, 'Call');
  assert.equal(expr.callee, 'need');
  assert.deepEqual(
    expr.args[0].entries.map((/** @type {any} */ e) => e.key),
    ['id', 'type', 'capability']
  );
  assert.deepEqual(expr.args[0].entries.at(-1).value, {
    kind: 'Lit',
    type: 'string',
    value: 'secrets',
  });
});

// SPEC §1.5/§1.7 — array literal with constraints as a choice list.
test('SPEC §1.7 — array().constraints({ values: [...] }) choice list', () => {
  const engine = realEngine();
  const expr = /** @type {any} */ (
    stripPositions(engine.parse("${ array().constraints({ values: ['IT', 'US'] }) }")).nodes[0]
  ).expr;
  assert.equal(expr.kind, 'Method');
  assert.equal(expr.name, 'constraints');
  assert.equal(expr.receiver.kind, 'Call');
  assert.equal(expr.receiver.callee, 'array');
  const values = expr.args[0].entries[0].value;
  assert.equal(values.kind, 'ArrayLit');
  assert.deepEqual(
    values.elements.map((/** @type {any} */ el) => el.value),
    ['IT', 'US']
  );
});

// SPEC §1.4 — pipeline of methods reads left-to-right.
test('SPEC §1.5 — method pipeline array([3,1,2]).min()', () => {
  const engine = realEngine();
  const expr = /** @type {any} */ (
    stripPositions(engine.parse('${ array([3, 1, 2]).min() }')).nodes[0]
  ).expr;
  assert.deepEqual(expr, {
    kind: 'Method',
    name: 'min',
    args: [],
    receiver: {
      kind: 'Call',
      callee: 'array',
      args: [
        {
          kind: 'ArrayLit',
          elements: [
            { kind: 'Lit', type: 'int', value: 3 },
            { kind: 'Lit', type: 'int', value: 1 },
            { kind: 'Lit', type: 'int', value: 2 },
          ],
        },
      ],
    },
  });
});

// SPEC §2.3 — parse throws (does not tolerate) malformed syntax, unlike tokenize.
test('SPEC §2.3 — parse throws on malformed syntax', () => {
  const engine = realEngine();
  assert.throws(() => engine.parse('${ 1 + }'));
});
