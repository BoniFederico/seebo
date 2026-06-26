/**
 * @file Unit — lexer (IMPL §2). Full coverage of `tokenize`: token kinds, positions,
 * slots/sigils, escaping, strings/numbers/identifiers, operators, comments, macros,
 * optional line/column, and error-tolerant reporting.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../../src/lexer/lexer.js';
import { TokenType } from '../../src/lexer/tokens.js';
import { realEngine } from '../helpers/index.js';

/** @param {string} input @param {object} [opts] */
const kinds = (input, opts) => tokenize(input, opts).map((t) => t.kind);
/** @param {string} input @param {object} [opts] */
const collectErrors = (input, opts = {}) => {
  /** @type {import('../../src/util/errors.js').Diagnostic[]} */
  const diags = [];
  const tokens = tokenize(input, { ...opts, onError: (d) => diags.push(d) });
  return { tokens, diags };
};

test('TokenType contract exposes the IMPL §2 kinds', () => {
  for (const kind of [
    'text',
    'slot-open',
    'slot-close',
    'name',
    'method',
    'number',
    'string',
    'bool',
    'operator',
    'dot',
    'comma',
    'paren',
    'bracket',
    'brace',
    'arrow',
    'star',
    'comment-body',
    'macro-name',
  ]) {
    assert.ok(Object.values(TokenType).includes(kind), `missing token kind: ${kind}`);
  }
});

test('empty input yields no tokens', () => {
  assert.deepEqual(tokenize(''), []);
});

test('plain text is a single text token', () => {
  const toks = tokenize('just text, no slots');
  assert.deepEqual(
    toks.map((t) => t.kind),
    ['text']
  );
  assert.deepEqual(toks[0], { kind: 'text', start: 0, end: 'just text, no slots'.length });
});

// SPEC §2.3 — the documented tokenize example.
test('SPEC §2.3 — "Ciao ${ nome.upper() }" kind sequence', () => {
  assert.deepEqual(kinds('Ciao ${ nome.upper() }'), [
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

test('token positions reconstruct the source slice', () => {
  const input = 'Hi ${ x }';
  const toks = tokenize(input);
  assert.deepEqual(
    toks.map((t) => t.kind),
    ['text', 'slot-open', 'name', 'slot-close']
  );
  assert.equal(input.slice(toks[0].start, toks[0].end), 'Hi ');
  assert.equal(input.slice(toks[1].start, toks[1].end), '${');
  assert.equal(input.slice(toks[2].start, toks[2].end), 'x');
  assert.equal(input.slice(toks[3].start, toks[3].end), '}');
});

test('numbers: int and float are both `number`', () => {
  const toks = tokenize('${ 42 }');
  assert.equal(toks[1].kind, 'number');
  assert.equal('${ 42 }'.slice(toks[1].start, toks[1].end), '42');

  const f = tokenize('${ 3.14 }');
  assert.equal(f[1].kind, 'number');
  assert.equal('${ 3.14 }'.slice(f[1].start, f[1].end), '3.14');

  // A trailing dot is not part of the number (no digit after it).
  assert.deepEqual(kinds('${ 3.x }'), ['slot-open', 'number', 'dot', 'method', 'slot-close']);
});

test('strings: single token, with escaped quote', () => {
  assert.deepEqual(kinds("${ 'hello' }"), ['slot-open', 'string', 'slot-close']);
  const toks = tokenize("${ 'a\\'b' }");
  assert.equal(toks[1].kind, 'string');
  assert.equal("${ 'a\\'b' }".slice(toks[1].start, toks[1].end), "'a\\'b'");
});

test('a closing brace inside a string does not close the slot', () => {
  assert.deepEqual(kinds("${ '}' }"), ['slot-open', 'string', 'slot-close']);
});

test('bool and word-operators are classified, not `name`', () => {
  assert.deepEqual(kinds('${ true }'), ['slot-open', 'bool', 'slot-close']);
  assert.deepEqual(kinds('${ false }'), ['slot-open', 'bool', 'slot-close']);
  // a and b or not c in d  → and/or/not/in are operators; a/b/c/d are names
  assert.deepEqual(kinds('${ a and b or not c in d }'), [
    'slot-open',
    'name', // a
    'operator', // and
    'name', // b
    'operator', // or
    'operator', // not
    'name', // c
    'operator', // in
    'name', // d
    'slot-close',
  ]);
});

test('name vs method is decided by a preceding dot', () => {
  assert.deepEqual(kinds('${ a.b.c }'), [
    'slot-open',
    'name',
    'dot',
    'method',
    'dot',
    'method',
    'slot-close',
  ]);
});

test('two-character operators and the arrow', () => {
  assert.deepEqual(kinds('${ a == b }'), ['slot-open', 'name', 'operator', 'name', 'slot-close']);
  assert.deepEqual(kinds('${ a ?? b }'), ['slot-open', 'name', 'operator', 'name', 'slot-close']);
  const arrow = tokenize("${ 1 => 'x' }");
  assert.ok(arrow.some((t) => t.kind === 'arrow'));
});

test('`*` is `operator` in arithmetic but `star` as a match default', () => {
  assert.deepEqual(kinds('${ 2 * 3 }'), [
    'slot-open',
    'number',
    'operator',
    'number',
    'slot-close',
  ]);
  const m = tokenize("${ x match { 1 => 'a', * => 'b' } }");
  assert.ok(
    m.some((t) => t.kind === 'star'),
    'expected a `star` token for the match default'
  );
  assert.equal(m.filter((t) => t.kind === 'arrow').length, 2);
});

test('nested object braces are balanced; the top-level brace closes the slot', () => {
  const toks = tokenize('${ {a: 1} }');
  assert.equal(toks[0].kind, 'slot-open');
  assert.equal(toks[toks.length - 1].kind, 'slot-close');
  assert.equal(toks.filter((t) => t.kind === 'brace').length, 2); // the inner { and }
});

test('comment slot yields slot-open, comment-body, slot-close', () => {
  assert.deepEqual(kinds('#{ a comment }'), ['slot-open', 'comment-body', 'slot-close']);
  // nested braces inside the comment are balanced
  assert.deepEqual(kinds('#{ a {b} c }'), ['slot-open', 'comment-body', 'slot-close']);
});

test('macro slot tags its first identifier as macro-name', () => {
  assert.deepEqual(kinds('@{REMOVE_LINE}'), ['slot-open', 'macro-name', 'slot-close']);
  assert.deepEqual(kinds("@{ ABSORB('a') }"), [
    'slot-open',
    'macro-name',
    'paren',
    'string',
    'paren',
    'slot-close',
  ]);
});

test('escaped sigils are plain text (no slot opens)', () => {
  const toks = tokenize('\\${ a } \\#{ b } \\@{ c }');
  assert.deepEqual(
    toks.map((t) => t.kind),
    ['text']
  );
});

test('text adjacent to a slot is its own token', () => {
  assert.deepEqual(kinds('a${ 1 }b'), ['text', 'slot-open', 'number', 'slot-close', 'text']);
});

test('custom delimiters via options', () => {
  const opts = { delimiters: { formula: '%', open: '[', close: ']' } };
  assert.deepEqual(kinds('x %[ 1 ]', opts), ['text', 'slot-open', 'number', 'slot-close']);
});

/* ----------------------------------------------------------------------------------- *
 * Optional line/column (non-normative, opt-in)
 * ----------------------------------------------------------------------------------- */

test('locations: line/column are attached only when requested', () => {
  const plain = tokenize('a\n${ x }');
  assert.equal(plain[0].position, undefined);

  const toks = tokenize('a\n${ x }', { locations: true });
  const slotOpen = toks.find((t) => t.kind === 'slot-open');
  const name = toks.find((t) => t.kind === 'name');
  assert.deepEqual(
    { line: slotOpen?.position?.line, column: slotOpen?.position?.column },
    {
      line: 2,
      column: 1,
    }
  );
  assert.deepEqual(
    { line: name?.position?.line, column: name?.position?.column },
    {
      line: 2,
      column: 4,
    }
  );
  // offsets remain present and normative inside position too
  assert.equal(name?.position?.start, name?.start);
});

test('locations: column counts within the first line', () => {
  const toks = tokenize('${ x }', { locations: true });
  assert.equal(toks[0].position?.line, 1);
  assert.equal(toks[0].position?.column, 1);
});

/* ----------------------------------------------------------------------------------- *
 * Error tolerance (never throws; reports via onError with position + code)
 * ----------------------------------------------------------------------------------- */

test('tolerant: unterminated string is reported, not thrown', () => {
  // The unterminated string runs to EOF, which also leaves the slot unterminated:
  // both are reported (the string first), and scanning never throws.
  const { tokens, diags } = collectErrors("${ 'oops }");
  assert.ok(tokens.length > 0);
  assert.ok(diags.length >= 1);
  assert.equal(diags[0].code, 'SYNTAX_ERROR');
  assert.equal(diags[0].phase, 'tokenize');
  assert.equal(diags[0].recoverable, true);
  assert.match(diags[0].message, /string/);
  assert.ok(diags[0].position);
});

test('tolerant: unterminated slot is reported, not thrown', () => {
  const { diags } = collectErrors('Hi ${ 1 + 2');
  assert.equal(diags.length, 1);
  assert.equal(diags[0].code, 'SYNTAX_ERROR');
  assert.ok(diags[0].position?.start !== undefined);
});

test('tolerant: unterminated comment is reported', () => {
  const { diags } = collectErrors('#{ never closed');
  assert.equal(diags.length, 1);
  assert.equal(diags[0].code, 'SYNTAX_ERROR');
});

test('tolerant: unexpected character inside a slot is reported and skipped', () => {
  const { tokens, diags } = collectErrors('${ 1 § 2 }'); // § is not a valid slot char
  assert.equal(diags.length, 1);
  assert.equal(diags[0].code, 'SYNTAX_ERROR');
  // scanning recovers and still finds the closing brace
  assert.equal(tokens[tokens.length - 1].kind, 'slot-close');
});

test('tokenize without onError never throws on malformed input', () => {
  assert.doesNotThrow(() => tokenize("${ 'oops"));
  assert.doesNotThrow(() => tokenize('${ 1 +'));
});

test('engine.tokenize delegates to the lexer (barrel + config)', () => {
  const engine = realEngine();
  assert.deepEqual(
    engine.tokenize('${ 1 }').map((t) => t.kind),
    ['slot-open', 'number', 'slot-close']
  );
});
