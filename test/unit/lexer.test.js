/**
 * @file Unit — lexer (IMPL §2). Contract-level checks pass now; behavioral checks for
 * `tokenize`/`lex` are PENDING until the lexer is implemented.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenType } from '../../src/lexer/tokens.js';
import { tokenize } from '../../src/lexer/index.js';
import { realEngine, assertNotImplemented, PENDING } from '../helpers/index.js';

test('TokenType contract exposes the IMPL §2 kinds', () => {
  for (const kind of ['text', 'slot-open', 'slot-close', 'name', 'method', 'macro-name']) {
    assert.ok(Object.values(TokenType).includes(kind), `missing token kind: ${kind}`);
  }
});

test('tokenize is a placeholder in v1 (throws NotImplemented)', () => {
  assertNotImplemented(() => tokenize('Ciao ${ nome }'));
});

// IMPL §2 / SPEC §2.3 — tokenize is error-tolerant and tags name vs method by the dot.
//   Input: "Ciao ${ nome.upper() }"
//   Expected kinds (order): text, slot-open, name, dot, method, paren, paren, slot-close
test('IMPL §2 — tokenize emits the expected kind sequence', PENDING, () => {
  const engine = realEngine();
  const kinds = engine.tokenize('Ciao ${ nome.upper() }').map((t) => t.kind);
  assert.deepEqual(kinds, [
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

// IMPL §2 — every token carries normative offset positions (start/end).
test('IMPL §2 — tokens carry start/end offsets', PENDING, () => {
  const engine = realEngine();
  for (const tok of engine.tokenize('a ${ b }')) {
    assert.equal(typeof tok.start, 'number');
    assert.equal(typeof tok.end, 'number');
    assert.ok(tok.end >= tok.start);
  }
});
