/**
 * @file Test harness: assertion utilities for comparing pipeline results, especially
 * diagnostics (IMPL Appendix A) and placeholder behavior.
 */

import assert from 'node:assert/strict';
import { NotImplementedError } from '../../src/util/errors.js';

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
 * Asserts that calling `fn` throws a `NotImplementedError`. Useful to document, in a
 * passing test, that a v1 placeholder is still pending.
 * @param {() => unknown} fn
 */
export function assertNotImplemented(fn) {
  assert.throws(fn, NotImplementedError);
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
