/**
 * @file Test harness: assertion utilities for comparing pipeline results, especially
 * diagnostics (IMPL Appendix A).
 */

import assert from 'node:assert/strict';

/**
 * Extracts the `code` of each diagnostic, in order.
 * @param {import('../../src/util/errors.js').Diagnostic[]} diagnostics
 * @returns {string[]}
 */
export function codesOf(diagnostics) {
  return diagnostics.map((d) => d.code);
}

/**
 * Asserts that a diagnostics list contains exactly the expected codes (order-insensitive).
 * @param {import('../../src/util/errors.js').Diagnostic[]} diagnostics
 * @param {string[]} expected
 */
export function assertCodes(diagnostics, expected) {
  assert.deepEqual([...codesOf(diagnostics)].sort(), [...expected].sort());
}

/**
 * Asserts that a diagnostics list contains at least one diagnostic with the given code.
 * @param {import('../../src/util/errors.js').Diagnostic[]} diagnostics
 * @param {string} code
 */
export function assertHasCode(diagnostics, code) {
  assert.ok(
    codesOf(diagnostics).includes(code),
    `expected a diagnostic with code ${code}, got [${codesOf(diagnostics).join(', ')}]`
  );
}

/**
 * Deep-clones an AST node/value with every `position` field removed, so structural
 * `deepEqual` comparisons stay readable and independent of offsets (positions are covered
 * by dedicated tests). Pure; does not mutate the input.
 * @template T
 * @param {T} node
 * @returns {T}
 */
export function stripPositions(node) {
  if (Array.isArray(node)) return /** @type {any} */ (node.map(stripPositions));
  if (node && typeof node === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === 'position') continue;
      out[k] = stripPositions(/** @type {any} */ (v));
    }
    return /** @type {any} */ (out);
  }
  return node;
}

/**
 * Normalizes text output for stable comparison: trims trailing whitespace per line and a
 * single trailing newline. Conformance outputs should already be exact; this guards
 * against incidental editor/OS newline noise.
 * @param {string} text
 * @returns {string}
 */
export function normalizeOutput(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
}
