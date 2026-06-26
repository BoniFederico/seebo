/**
 * @file Runtime barrel: the public value/type API (IMPL §4). Re-exports the contract
 * constants and the factory / conversion / comparison / validation / serialization /
 * builder functions from {@link ./values.js}, plus stringification from
 * {@link ./stringify.js}.
 */

export {
  // constants
  TypeName,
  PRECISION_ORDER,
  DURATION_UNITS,
  DEFAULT_FORMATS,
  DEFAULT_CONSTRAINTS,
  VALUE_LIMITS,
  // factories
  makeInt,
  makeFloat,
  makeBool,
  makeString,
  makeDatetime,
  makeDuration,
  makeObject,
  makeArray,
  // inference / guards
  fromJs,
  isValue,
  isNumeric,
  // equality / comparison / validation
  equals,
  compare,
  validate,
  // access
  objectGet,
  arrayGet,
  // serialization
  serialize,
  deserialize,
  // builders
  builder,
  makeTypeConstructor,
} from './values.js';

export { toText, toText as stringify } from './stringify.js';
