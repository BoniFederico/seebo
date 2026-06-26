/**
 * @file Conformance — tokenization (SPEC §1.2 slots/sigils/escaping, §2.3 `tokenize`).
 * Exercises the public `engine.tokenize`, which is error-tolerant and never throws
 * (SPEC §2.3). Each case documents the SPEC source, the input and the expected token
 * kinds (and, where relevant, the source slices).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realEngine } from '../helpers/index.js';

const engine = realEngine();
/** @param {string} input */
const kinds = (input) => engine.tokenize(input).map((t) => t.kind);

// SPEC §2.3 — the documented example: name vs method is decided by the dot.
test('SPEC §2.3 — tokenize("Hello ${ name.upper() }")', () => {
  assert.deepEqual(kinds('Hello ${ name.upper() }'), [
    'text',
    'slot-open',
    'name',
    'dot',
    'method',
    'paren',
    'paren',
    'slot-close',
  ]);
});

// SPEC §1.2 — the three slot families open with their sigil + brace.
test('SPEC §1.2 — dollar, hash and at slots', () => {
  assert.deepEqual(kinds('${ 1 }'), ['slot-open', 'number', 'slot-close']);
  assert.deepEqual(kinds('#{ note }'), ['slot-open', 'comment-body', 'slot-close']);
  assert.deepEqual(kinds('@{ REMOVE_LINE }'), ['slot-open', 'macro-name', 'slot-close']);
});

// SPEC §1.2 — escaping: \${ \#{ \@{ are literal text, not slots.
test('SPEC §1.2 — escaped sigils tokenize as text', () => {
  assert.deepEqual(kinds('price: \\${ 10 }'), ['text']);
});

// SPEC §1.2 — interleaved text and slots.
test('SPEC §1.2 — text/slot interleaving', () => {
  assert.deepEqual(kinds('Dear ${ name }, hello'), [
    'text',
    'slot-open',
    'name',
    'slot-close',
    'text',
  ]);
});

// SPEC §1.2 — balancing: braces/quotes inside a slot do not end it prematurely.
test('SPEC §1.2 — brace/quote balancing within a slot', () => {
  assert.deepEqual(kinds("${ '}' }"), ['slot-open', 'string', 'slot-close']);
  const toks = engine.tokenize('${ {a: 1} }');
  assert.equal(toks[toks.length - 1].kind, 'slot-close');
});

// SPEC §2.3 — tokenize is error-tolerant: malformed input never throws.
test('SPEC §2.3 — tokenize tolerates incomplete input', () => {
  assert.doesNotThrow(() => engine.tokenize('Hello ${ name.'));
  assert.ok(engine.tokenize('Hello ${ name.').length > 0);
});
