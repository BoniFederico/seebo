/**
 * @file Unit — macro EXPAND (IMPL §10.1) and FINALIZE (IMPL §10.2). Covers aggregator
 * inlining, glob MERGE, cycle/depth limits, and positional layout removal.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expand } from '../../src/macros/expand.js';
import { finalize } from '../../src/macros/finalize.js';
import { DiagnosticCode } from '../../src/util/errors.js';

/* ----------------------------------------------------------------------------------- *
 * EXPAND
 * ----------------------------------------------------------------------------------- */

test('expand: a template with no aggregators is returned unchanged', async () => {
  const out = await expand({ template: 'Hello ${ name } @{REMOVE_LINE}' });
  assert.equal(out, 'Hello ${ name } @{REMOVE_LINE}');
});

test('expand: ABSORB inlines a named template verbatim', async () => {
  const out = await expand({
    template: "before @{ABSORB('part')} after",
    templates: { part: 'INLINED' },
  });
  assert.equal(out, 'before INLINED after');
});

test('expand: ABSORB is recursive (an included template can include)', async () => {
  const out = await expand({
    template: "@{ABSORB('a')}",
    templates: { a: "a:@{ABSORB('b')}", b: 'b-leaf' },
  });
  assert.equal(out, 'a:b-leaf');
});

test('expand: a missing template inlines as empty', async () => {
  const out = await expand({ template: "x@{ABSORB('ghost')}y", templates: {} });
  assert.equal(out, 'xy');
});

test('expand: MERGE concatenates glob-matched templates in sorted order with a separator', async () => {
  const out = await expand({
    template: "@{MERGE('item_*', ',')}",
    templates: { item_b: 'B', item_a: 'A', other: 'X', item_c: 'C' },
  });
  assert.equal(out, 'A,B,C');
});

test('expand: MERGE without a separator concatenates directly', async () => {
  const out = await expand({
    template: "@{MERGE('p_*')}",
    templates: { p_1: '1', p_2: '2' },
  });
  assert.equal(out, '12');
});

test('expand: a cyclic inclusion throws INCLUSION_CYCLE', async () => {
  await assert.rejects(
    () =>
      expand({
        template: "@{ABSORB('a')}",
        templates: { a: "@{ABSORB('b')}", b: "@{ABSORB('a')}" },
      }),
    (e) => /** @type {any} */ (e).code === DiagnosticCode.INCLUSION_CYCLE
  );
});

test('expand: exceeding maxDepth throws DEPTH_EXCEEDED', async () => {
  await assert.rejects(
    () =>
      expand(
        { template: "@{ABSORB('a')}", templates: { a: "@{ABSORB('b')}", b: 'leaf' } },
        { limits: { maxDepth: 1 } }
      ),
    (e) => /** @type {any} */ (e).code === DiagnosticCode.DEPTH_EXCEEDED
  );
});

/* ----------------------------------------------------------------------------------- *
 * FINALIZE
 * ----------------------------------------------------------------------------------- */

test('finalize: text without markers is returned unchanged', () => {
  assert.equal(finalize('plain text\nsecond line'), 'plain text\nsecond line');
});

test('finalize: REMOVE_LINE deletes the whole line containing the marker', () => {
  assert.equal(finalize('a\n@{REMOVE_LINE}\nc'), 'a\nc');
});

test('finalize: REMOVE_RIGHT removes itself and n chars to the right', () => {
  assert.equal(finalize('V@{REMOVE_RIGHT(2)}AB'), 'V');
});

test('finalize: REMOVE_LEFT removes itself and n chars to the left', () => {
  assert.equal(finalize('XYZ@{REMOVE_LEFT(2)}!'), 'X!');
});

test('finalize: an unrecognized @{...} block is left untouched', () => {
  assert.equal(finalize('see @{not_a_macro} here'), 'see @{not_a_macro} here');
});

test('finalize: COLLAPSE removes itself and collapses multiple blank lines into one', () => {
  assert.equal(finalize('a\n\n\n\n@{COLLAPSE}b'), 'a\n\nb');
});

test('finalize: markers are applied left-to-right with recomputed offsets', () => {
  // REMOVE_RIGHT(1) eats 'X'; then the second marker's REMOVE_LEFT(1) eats 'Y'.
  assert.equal(finalize('@{REMOVE_RIGHT(1)}XY@{REMOVE_LEFT(1)}Z'), 'Z');
});
