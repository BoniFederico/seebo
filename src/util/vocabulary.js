/**
 * @file Single source of truth for the builtin language vocabulary (SPEC §1.3/§1.5/§1.8).
 * The names the core implements directly — base types, standard producers, syntactic forms
 * and macros — live here so the parser, evaluator, validator, registry and public API all
 * agree without duplicating literal lists. This module imports nothing, so it can be shared
 * freely (no import cycles).
 */

/**
 * Base type names (SPEC §1.3). Each is also usable as a producer/builder (`int(1)`).
 * @type {ReadonlyArray<string>}
 */
export const BUILTIN_TYPE_NAMES = Object.freeze([
  'int',
  'float',
  'bool',
  'string',
  'datetime',
  'duration',
  'object',
  'array',
]);

/**
 * Standard producer functions (SPEC §1.5) — the non-type, non-form callables.
 * @type {ReadonlyArray<string>}
 */
export const BUILTIN_PRODUCER_NAMES = Object.freeze(['now', 'date']);

/**
 * Special syntactic forms (SPEC §1.6/§1.7/§2.8): `need(...)`, `bind(...)`, `prepare(...)` and
 * `action(...)`. They occupy the producer namespace but are not ordinary functions:
 *  - `need({...})` declares missing external data resolved by a capability (the descriptor);
 *  - `bind(name, type)` names a **pure value** binding (a type-builder), referenced **plain**
 *    (`${ name }`) elsewhere;
 *  - `prepare(need(...) | action(...))` declares a need/action **lazily** for reuse by its own
 *    `id` (the descriptor carries the id); it emits nothing and is referenced plain by that id;
 *  - `action(...)` is an effect *declaration* prepared by the core and executed only via
 *    `seebo/actions`.
 * @type {ReadonlyArray<string>}
 */
export const BUILTIN_FORMS = Object.freeze(['need', 'bind', 'prepare', 'action']);

/**
 * Aggregator (pre-pass / EXPAND) macro names (SPEC §1.8).
 * @type {ReadonlyArray<string>}
 */
export const AGGREGATOR_MACRO_NAMES = Object.freeze(['ABSORB', 'MERGE']);

/**
 * Layout (post-pass / FINALIZE) macro names (SPEC §1.8).
 * @type {ReadonlyArray<string>}
 */
export const LAYOUT_MACRO_NAMES = Object.freeze([
  'COLLAPSE',
  'REMOVE_LINE',
  'REMOVE_LEFT',
  'REMOVE_RIGHT',
]);

/**
 * All builtin macro names (aggregators first, then layout).
 * @type {ReadonlyArray<string>}
 */
export const BUILTIN_MACRO_NAMES = Object.freeze([
  ...AGGREGATOR_MACRO_NAMES,
  ...LAYOUT_MACRO_NAMES,
]);

/**
 * Operator/form keywords (SPEC §1.4).
 * @type {ReadonlyArray<string>}
 */
export const OPERATOR_KEYWORDS = Object.freeze(['and', 'or', 'not', 'in', 'match']);

/**
 * Boolean literal keywords (SPEC §1.4).
 * @type {ReadonlyArray<string>}
 */
export const LITERAL_KEYWORDS = Object.freeze(['true', 'false']);

/**
 * Language reserved words (SPEC §1.5): the full set an application-defined identifier must
 * not match. Composed from every builtin namespace.
 * @type {ReadonlyArray<string>}
 */
export const RESERVED_WORDS = Object.freeze([
  ...OPERATOR_KEYWORDS,
  ...LITERAL_KEYWORDS,
  ...BUILTIN_TYPE_NAMES,
  ...BUILTIN_PRODUCER_NAMES,
  ...BUILTIN_FORMS,
  ...BUILTIN_MACRO_NAMES,
]);
