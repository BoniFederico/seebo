/**
 * @file Unit — parser (IMPL §3). Exercises `parse(tokens, options)` over single
 * constructs: literals, refs, calls, methods, members, namespaces, object/array literals,
 * unary/binary precedence, ternary, match desugaring, and document nodes. Structural
 * assertions ignore positions via {@link stripPositions}; dedicated tests check positions
 * and error reporting.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../../src/lexer/lexer.js';
import { parse, PRECEDENCE } from '../../src/parser/parser.js';
import { realEngine, stripPositions } from '../helpers/index.js';

/**
 * Parse a whole template into a Document (positions stripped).
 * @param {string} src
 * @param {Record<string, unknown>} [opts]
 */
const doc = (src, opts = {}) =>
  stripPositions(parse(tokenize(src, opts), { source: src, ...opts }));
/**
 * Parse the expression inside a single `${ … }` formula (positions stripped).
 * @param {string} src
 * @param {Record<string, unknown>} [opts]
 */
const expr = (src, opts = {}) => {
  const d = parse(tokenize(`\${ ${src} }`, opts), { source: `\${ ${src} }`, ...opts });
  return stripPositions(/** @type {any} */ (d.nodes[0]).expr);
};

test('PRECEDENCE matches SPEC §1.4 ordering (* > + > compare > == > and > or > ?? > ?:)', () => {
  assert.ok(PRECEDENCE['*'].binding > PRECEDENCE['+'].binding);
  assert.ok(PRECEDENCE['+'].binding > PRECEDENCE['<'].binding);
  assert.ok(PRECEDENCE['<'].binding > PRECEDENCE['=='].binding);
  assert.ok(PRECEDENCE['=='].binding > PRECEDENCE['and'].binding);
  assert.ok(PRECEDENCE['and'].binding > PRECEDENCE['or'].binding);
  assert.ok(PRECEDENCE['or'].binding > PRECEDENCE['??'].binding);
  assert.ok(PRECEDENCE['??'].binding > PRECEDENCE['?:'].binding);
});

/* ----------------------------------------------------------------------------------- *
 * Literals and references
 * ----------------------------------------------------------------------------------- */

test('literals: int / float / string / bool', () => {
  assert.deepEqual(expr('42'), { kind: 'Lit', type: 'int', value: 42 });
  assert.deepEqual(expr('3.14'), { kind: 'Lit', type: 'float', value: 3.14 });
  assert.deepEqual(expr("'hi'"), { kind: 'Lit', type: 'string', value: 'hi' });
  assert.deepEqual(expr('true'), { kind: 'Lit', type: 'bool', value: true });
  assert.deepEqual(expr('false'), { kind: 'Lit', type: 'bool', value: false });
});

test('string unescaping inside literals', () => {
  assert.deepEqual(expr("'a\\'b'"), { kind: 'Lit', type: 'string', value: "a'b" });
});

test('identifier reference', () => {
  assert.deepEqual(expr('nome'), { kind: 'Ref', name: 'nome' });
});

/* ----------------------------------------------------------------------------------- *
 * Calls, methods, members, namespaces
 * ----------------------------------------------------------------------------------- */

test('producer call with no args', () => {
  assert.deepEqual(expr('now()'), { kind: 'Call', callee: 'now', args: [] });
});

test('producer call with args', () => {
  assert.deepEqual(expr('duration(86400)'), {
    kind: 'Call',
    callee: 'duration',
    args: [{ kind: 'Lit', type: 'int', value: 86400 }],
  });
});

test('member access o.campo', () => {
  assert.deepEqual(expr('o.campo'), {
    kind: 'Member',
    receiver: { kind: 'Ref', name: 'o' },
    key: 'campo',
  });
});

test('method call x.name(args)', () => {
  assert.deepEqual(expr("s.replace('a', 'b')"), {
    kind: 'Method',
    receiver: { kind: 'Ref', name: 's' },
    name: 'replace',
    args: [
      { kind: 'Lit', type: 'string', value: 'a' },
      { kind: 'Lit', type: 'string', value: 'b' },
    ],
  });
});

test('chained member/method: crm({...}).id', () => {
  const e = expr("crm({ id: 'ordine' }).id", { capabilities: ['crm'] });
  // capability sugar normalizes crm(...) → need(..., capability:'crm')
  assert.equal(e.kind, 'Member');
  assert.equal(e.key, 'id');
  assert.equal(e.receiver.kind, 'Call');
  assert.equal(e.receiver.callee, 'need');
});

test('library namespace fake.email() when the library is registered', () => {
  assert.deepEqual(expr('fake.email()', { libraries: ['fake'] }), {
    kind: 'Namespace',
    ns: 'fake',
    name: 'email',
    args: [],
  });
  // without registration it is a plain method on a ref
  assert.deepEqual(expr('fake.email()'), {
    kind: 'Method',
    receiver: { kind: 'Ref', name: 'fake' },
    name: 'email',
    args: [],
  });
});

/* ----------------------------------------------------------------------------------- *
 * Object / array literals
 * ----------------------------------------------------------------------------------- */

test('array literal', () => {
  assert.deepEqual(expr('[3, 1, 2]'), {
    kind: 'ArrayLit',
    elements: [
      { kind: 'Lit', type: 'int', value: 3 },
      { kind: 'Lit', type: 'int', value: 1 },
      { kind: 'Lit', type: 'int', value: 2 },
    ],
  });
});

test('object literal with expression values', () => {
  assert.deepEqual(expr("{ id: 'x', n: 1 + 2 }"), {
    kind: 'ObjectLit',
    entries: [
      { key: 'id', value: { kind: 'Lit', type: 'string', value: 'x' } },
      {
        key: 'n',
        value: {
          kind: 'Binary',
          op: '+',
          left: { kind: 'Lit', type: 'int', value: 1 },
          right: { kind: 'Lit', type: 'int', value: 2 },
        },
      },
    ],
  });
});

test('trailing commas are allowed in args/arrays/objects', () => {
  assert.equal(expr('array([1, 2,])').kind, 'Call');
  assert.equal(expr('[1, 2,]').elements.length, 2);
  assert.equal(expr('{ a: 1, }').entries.length, 1);
});

/* ----------------------------------------------------------------------------------- *
 * Operators: precedence, associativity, unary, ternary
 * ----------------------------------------------------------------------------------- */

test('precedence: 1 + 2 * 3 → +( 1, *(2,3) )', () => {
  assert.deepEqual(expr('1 + 2 * 3'), {
    kind: 'Binary',
    op: '+',
    left: { kind: 'Lit', type: 'int', value: 1 },
    right: {
      kind: 'Binary',
      op: '*',
      left: { kind: 'Lit', type: 'int', value: 2 },
      right: { kind: 'Lit', type: 'int', value: 3 },
    },
  });
});

test('left associativity: 1 - 2 - 3 → -( -(1,2), 3 )', () => {
  const e = expr('1 - 2 - 3');
  assert.equal(e.op, '-');
  assert.equal(e.left.kind, 'Binary');
  assert.equal(e.left.op, '-');
  assert.equal(e.right.value, 3);
});

test('parentheses override precedence: (1 + 2) * 3', () => {
  const e = expr('(1 + 2) * 3');
  assert.equal(e.op, '*');
  assert.equal(e.left.op, '+');
});

test('unary minus and not', () => {
  assert.deepEqual(expr('-x'), {
    kind: 'Unary',
    op: '-',
    arg: { kind: 'Ref', name: 'x' },
  });
  assert.deepEqual(expr('not flag'), {
    kind: 'Unary',
    op: 'not',
    arg: { kind: 'Ref', name: 'flag' },
  });
});

test('ternary is right-associative: a ? b : c ? d : e', () => {
  const e = expr('a ? b : c ? d : e');
  assert.equal(e.kind, 'Ternary');
  assert.equal(e.else.kind, 'Ternary'); // nests on the right
});

test('coalesce and logical operators parse', () => {
  assert.equal(expr("x ?? 'y'").kind, 'Binary');
  assert.equal(expr("x ?? 'y'").op, '??');
  assert.equal(expr('a and b or c').op, 'or'); // or is the loosest here → root
});

/* ----------------------------------------------------------------------------------- *
 * match desugaring (IMPL §3)
 * ----------------------------------------------------------------------------------- */

test('match desugars to nested ternaries with default', () => {
  const e = expr("n match { 1 => 'a', 2 => 'b', * => 'c' }");
  // (n == 1) ? 'a' : ((n == 2) ? 'b' : 'c')
  assert.equal(e.kind, 'Ternary');
  assert.deepEqual(e.cond, {
    kind: 'Binary',
    op: '==',
    left: { kind: 'Ref', name: 'n' },
    right: { kind: 'Lit', type: 'int', value: 1 },
  });
  assert.deepEqual(e.then, { kind: 'Lit', type: 'string', value: 'a' });
  assert.equal(e.else.kind, 'Ternary');
  assert.deepEqual(e.else.else, { kind: 'Lit', type: 'string', value: 'c' });
});

test('match without default falls back to empty string (validate flags non-exhaustive)', () => {
  const e = expr("n match { 1 => 'a' }");
  assert.equal(e.kind, 'Ternary');
  assert.deepEqual(e.else, { kind: 'Lit', type: 'string', value: '' });
});

/* ----------------------------------------------------------------------------------- *
 * Capability sugar (config-dependent, IMPL §3 / SPEC §1.6)
 * ----------------------------------------------------------------------------------- */

test('capability sugar injects capability into the descriptor', () => {
  const e = expr("crm({ id: 'cliente' })", { capabilities: ['crm'] });
  assert.equal(e.kind, 'Call');
  assert.equal(e.callee, 'need');
  const obj = e.args[0];
  assert.equal(obj.kind, 'ObjectLit');
  assert.deepEqual(obj.entries.at(-1), {
    key: 'capability',
    value: { kind: 'Lit', type: 'string', value: 'crm' },
  });
});

test('explicit require is left untouched', () => {
  const e = expr("need({ id: 'x', capability: 'user' })", { capabilities: ['user'] });
  assert.equal(e.callee, 'need');
  assert.equal(e.args[0].entries.length, 2); // no duplicate capability injected
});

test('capability sugar wraps dynamic expressions with args.ref', () => {
  const e = expr("previous(textbox({ id: 'block' }))", { capabilities: ['previous'] });
  assert.equal(e.kind, 'Call');
  assert.equal(e.callee, 'need');
  const descriptor = e.args[0];
  assert.equal(descriptor.kind, 'ObjectLit');
  // Check args entry
  const argsEntry = descriptor.entries.find((/** @type {any} */ en) => en.key === 'args');
  assert.ok(argsEntry, 'descriptor should have args entry');
  assert.equal(argsEntry.value.kind, 'ObjectLit');
  const refEntry = argsEntry.value.entries.find((/** @type {any} */ en) => en.key === 'ref');
  assert.ok(refEntry, 'args should have ref entry');
  assert.equal(refEntry.value.kind, 'Call');
  assert.equal(refEntry.value.callee, 'textbox');
  // Check capability entry
  const capEntry = descriptor.entries.find((/** @type {any} */ en) => en.key === 'capability');
  assert.ok(capEntry, 'descriptor should have capability entry');
  assert.equal(capEntry.value.value, 'previous');
});

/* ----------------------------------------------------------------------------------- *
 * Document-level nodes
 * ----------------------------------------------------------------------------------- */

test('document: text, formula, comment and macro nodes', () => {
  const d = doc('Hi ${ 1 } #{ note } @{ REMOVE_LINE }');
  assert.deepEqual(
    d.nodes.map((/** @type {any} */ n) => n.kind),
    ['Text', 'Formula', 'Text', 'Comment', 'Text', 'Macro']
  );
});

test('macro node carries name, args and family', () => {
  const d = doc("@{ ABSORB('part') } @{ REMOVE_LEFT(2) }");
  const macros = d.nodes.filter((/** @type {any} */ n) => n.kind === 'Macro');
  assert.deepEqual(macros[0], {
    kind: 'Macro',
    name: 'ABSORB',
    args: [{ kind: 'Lit', type: 'string', value: 'part' }],
    family: 'aggregator',
  });
  assert.deepEqual(macros[1], {
    kind: 'Macro',
    name: 'REMOVE_LEFT',
    args: [{ kind: 'Lit', type: 'int', value: 2 }],
    family: 'layout',
  });
});

test('text escaping is resolved in Text nodes', () => {
  const d = doc('price \\${ x }');
  assert.deepEqual(d.nodes, [{ kind: 'Text', value: 'price ${ x }' }]);
});

/* ----------------------------------------------------------------------------------- *
 * Positions and errors
 * ----------------------------------------------------------------------------------- */

test('nodes carry offset positions', () => {
  const d = parse(tokenize('${ 1 }'), { source: '${ 1 }' });
  const formula = /** @type {any} */ (d.nodes[0]);
  assert.deepEqual(formula.position, { start: 0, end: 6 });
  assert.equal(typeof formula.expr.position.start, 'number');
});

test('parse throws SYNTAX_ERROR with position on malformed input', () => {
  assert.throws(
    () => parse(tokenize('${ 1 + }'), { source: '${ 1 + }' }),
    (/** @type {any} */ err) => {
      assert.equal(err.code, 'SYNTAX_ERROR');
      assert.ok(err.position && typeof err.position.start === 'number');
      return true;
    }
  );
});

test('parse throws on an unclosed slot', () => {
  assert.throws(() => parse(tokenize('${ 1 + 2'), { source: '${ 1 + 2' }), /SYNTAX_ERROR|expected/);
});

test('parse requires options.source', () => {
  assert.throws(() => parse(tokenize('${ 1 }'), /** @type {any} */ ({})), /source is required/);
});

test('engine.parse delegates to the token parser (barrel + config)', () => {
  const engine = realEngine();
  const d = engine.parse('${ 1 + 2 }');
  assert.equal(d.astVersion, 1);
  assert.equal(d.nodes[0].kind, 'Formula');
});
