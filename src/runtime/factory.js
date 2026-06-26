/**
 * @file Compatibility shim for the evaluator/run slice helpers. The real value system
 * lives in {@link ./values.js} and {@link ./stringify.js}; this module just re-exports the
 * names the slice evaluator was written against (`intValue`/`floatValue`/`stringValue`/
 * `isNumeric`/`renderValue`).
 */

export { makeInt as intValue, makeFloat as floatValue, makeString as stringValue, isNumeric } from './values.js';
export { toText as renderValue } from './stringify.js';
