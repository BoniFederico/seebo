/**
 * @file Runtime barrel: re-exports the value contract ({@link ./values.js}) and the
 * type-construction / stringification function signatures (IMPL §4). v1 placeholders.
 */

import { NotImplementedError } from '../util/errors.js';

export { TypeName, PRECISION_ORDER, DURATION_UNITS } from './values.js';

/**
 * Generic dual-semantics constructor (clarifications §8): with no argument it returns an
 * immutable builder, with an argument it produces a {@link import('./values.js').Value}.
 * v1 placeholder.
 *
 * @param {string} _typeName One of {@link import('./values.js').TypeName}.
 * @param {unknown} [_value] If present ⇒ producer; if absent ⇒ builder.
 * @returns {never}
 */
export function makeTypeConstructor(_typeName, _value) {
  throw new NotImplementedError('runtime.makeTypeConstructor');
}

/**
 * Stringifies a {@link import('./values.js').Value} using its `format` and the `locale`
 * (IMPL §4). Happens only at slot emission (SPEC §1.1, principle 1). v1 placeholder.
 *
 * @param {import('./values.js').Value} _value
 * @param {string} [_locale]
 * @returns {never}
 */
export function stringify(_value, _locale) {
  throw new NotImplementedError('runtime.stringify');
}
