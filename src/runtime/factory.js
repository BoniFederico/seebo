/**
 * @file Minimal value factory for the v1 vertical slice (SPEC §1.3, IMPL §4).
 *
 * SCOPE: only the value forms the slice evaluator needs — `int`, `float`, `string` — plus
 * a minimal `renderValue` (stringification at emission, SPEC §1.1 principle 1). This is a
 * deliberately small internal helper; the full dual-semantics builder/producer
 * (`makeTypeConstructor`) and the format/constraints/locale-aware `stringify` in
 * {@link ./index.js} remain placeholders until later milestones.
 */

import { SeeboError } from '../util/errors.js';

/**
 * @param {number} n
 * @returns {import('./values.js').Value}
 */
export function intValue(n) {
  return { type: 'int', value: n, format: {}, constraints: {} };
}

/**
 * @param {number} n
 * @returns {import('./values.js').Value}
 */
export function floatValue(n) {
  return { type: 'float', value: n, format: {}, constraints: {} };
}

/**
 * @param {string} s
 * @returns {import('./values.js').Value}
 */
export function stringValue(s) {
  return { type: 'string', value: s, format: {}, constraints: {} };
}

/** @param {import('./values.js').Value} v */
export function isNumeric(v) {
  return v.type === 'int' || v.type === 'float';
}

/**
 * Renders a slice value to text (SPEC §1.3 defaults):
 *  - int    → digits, no thousands separator;
 *  - float  → fixed to precision 2 with ',' as decimal separator (SPEC §1.3 float default);
 *  - string → itself.
 *
 * `locale` is accepted for forward-compatibility but unused in the slice (the float
 * default decimal separator is ',' per SPEC §1.3, independent of locale here).
 *
 * @param {import('./values.js').Value} v
 * @param {string} [locale]
 * @returns {string}
 */
export function renderValue(v, locale) {
  switch (v.type) {
    case 'int':
      return String(v.value);
    case 'float':
      return Number(v.value).toFixed(2).replace('.', ',');
    case 'string':
      return /** @type {string} */ (v.value);
    default:
      throw new SeeboError(`cannot stringify type '${v.type}' in v1 slice`);
  }
}
