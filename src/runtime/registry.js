/**
 * @file Extension registry (SPEC §2.6, IMPL §3 enforcement). Single, immutable source of
 * truth for the application-defined vocabulary — custom types, functions (producers and
 * transformers), macros, libraries and capabilities — built once by `createEngine` and
 * consulted (read-only) by the parser, evaluator and driver.
 *
 * Name governance (SPEC §1.5): every introduced name is checked against the reserved words
 * ({@link DiagnosticCode.RESERVED_NAME}) and for uniqueness within its namespace
 * ({@link DiagnosticCode.NAME_CONFLICT}); producers, builtin types, libraries and
 * capabilities **share one namespace** (all invoked as `name(...)`), macros form another,
 * and transformers are keyed per receiver type. A violation fails engine construction.
 *
 * Security: extension implementations are **trusted host code** registered at construction;
 * they receive only plain JS values (never internal `Value`s) and their results are
 * re-wrapped/sanitized by the evaluator via {@link import('./values.js').fromJs}. No `eval`.
 */

import { EngineConfigError, DiagnosticCode } from '../util/errors.js';
import { RESERVED_WORDS } from '../index.js';

/** Builtin producer names that occupy the shared producer namespace (SPEC §1.5). */
const BUILTIN_PRODUCERS = ['now', 'date', 'require', 'var'];
/** Builtin type names (also producers) in the shared namespace (SPEC §1.3/§1.5). */
const BUILTIN_TYPES = ['int', 'float', 'bool', 'string', 'datetime', 'duration', 'object', 'array'];
/** Builtin macro names occupying the macro namespace (SPEC §1.8). */
const BUILTIN_MACRO_NAMES = [
  'ABSORB',
  'MERGE',
  'COLLAPSE',
  'REMOVE_LINE',
  'REMOVE_LEFT',
  'REMOVE_RIGHT',
];

/**
 * Implementation of a custom function (producer or transformer), SPEC §2.6.
 * `eval` operates on **plain JS values**: `(self, ...args)` for a transformer (with the
 * receiver first), `(...args)` for a producer; it returns a plain JS value that the
 * evaluator wraps via {@link import('./values.js').fromJs}.
 * @typedef {Object} FunctionDef
 * @property {string} name  Function/method name.
 * @property {string} [receiver]  Receiver type for a transformer; omitted for a producer.
 * @property {{ min: number, max: number }} [arity]  Allowed argument count (excludes `self`).
 * @property {(...args: any[]) => unknown} eval  Implementation over plain JS values.
 */

/**
 * Implementation of one library/namespace function (SPEC §2.6), e.g. `geo.zip()`.
 * @typedef {Object} LibraryFnDef
 * @property {{ min: number, max: number }} [arity]
 * @property {(...args: any[]) => unknown} eval
 */

/**
 * The frozen registry consulted by the parser/evaluator/driver.
 * @typedef {Object} Registry
 * @property {(name: string) => FunctionDef | undefined} getProducer  Custom producer by name.
 * @property {(type: string, name: string) => FunctionDef | undefined} getTransformer  Custom method by `(receiverType, name)`.
 * @property {(ns: string, name: string) => LibraryFnDef | undefined} getLibraryFn  Library function by `(namespace, name)`.
 * @property {(ns: string) => boolean} hasLibrary  Whether a library namespace is registered.
 * @property {(name: string) => boolean} hasCapability  Whether a capability is registered.
 * @property {(name: string) => import('../index.js').TypeExtensionDef | undefined} getType  Custom type descriptor by name.
 * @property {ReadonlyArray<string>} libraryNames  Registered library namespaces.
 * @property {Readonly<Record<string, 'aggregator'|'layout'>>} macroFamilies  Custom macro → family.
 */

/**
 * Builds the immutable {@link Registry} from an engine config (SPEC §2.6). Pure aside from
 * the throw on an invalid name.
 *
 * @param {import('../index.js').EngineConfig} [config]
 * @returns {Registry}
 * @throws {EngineConfigError}  `RESERVED_NAME` for a reserved name, `NAME_CONFLICT` for a duplicate.
 */
export function createRegistry(config = {}) {
  const reserved = new Set(RESERVED_WORDS);
  const producerNamespace = new Set([...BUILTIN_PRODUCERS, ...BUILTIN_TYPES]);
  const macroNamespace = new Set(BUILTIN_MACRO_NAMES);

  /** @type {Map<string, FunctionDef>} */
  const producers = new Map();
  /** @type {Map<string, FunctionDef>} */
  const transformers = new Map();
  /** @type {Map<string, Map<string, LibraryFnDef>>} */
  const libraries = new Map();
  /** @type {Map<string, import('../index.js').TypeExtensionDef>} */
  const types = new Map();
  /** @type {Record<string, 'aggregator'|'layout'>} */
  const macroFamilies = {};

  /** Reserves a name in the shared producer namespace. @param {string} name @param {string} kind */
  const reserveProducer = (name, kind) => {
    requireName(name, kind);
    if (reserved.has(name)) throw reservedName(name);
    if (producerNamespace.has(name)) throw nameConflict(name, 'producer');
    producerNamespace.add(name);
  };

  // Custom types (share the producer namespace; SPEC §1.5).
  for (const t of asArray(config.types)) {
    if (!isDescriptor(t)) continue; // builtin string entries carry no descriptor
    reserveProducer(t.name, 'type');
    types.set(t.name, /** @type {any} */ (t));
  }

  // Custom functions: producers (no receiver) vs transformers (receiver type).
  for (const f of asArray(config.functions)) {
    if (!isDescriptor(f)) continue;
    const def = /** @type {FunctionDef} */ (/** @type {any} */ (f));
    requireName(def.name, 'function');
    if (reserved.has(def.name)) throw reservedName(def.name);
    if (def.receiver) {
      const key = transformerKey(def.receiver, def.name);
      if (transformers.has(key)) throw nameConflict(def.name, `method:${def.receiver}`);
      transformers.set(key, def);
    } else {
      reserveProducer(def.name, 'function');
      producers.set(def.name, def);
    }
  }

  // Libraries: a plain string enables the namespace; a descriptor also carries functions.
  for (const l of asArray(config.libraries)) {
    const name = typeof l === 'string' ? l : /** @type {any} */ (l)?.name;
    reserveProducer(name, 'library');
    /** @type {Map<string, LibraryFnDef>} */
    const fns = new Map();
    const fnDefs = typeof l === 'object' && l ? /** @type {any} */ (l).functions : undefined;
    for (const [fnName, def] of Object.entries(fnDefs ?? {}))
      fns.set(fnName, /** @type {any} */ (def));
    libraries.set(name, fns);
  }

  // Capabilities (the keys of the provider map) share the producer namespace.
  for (const name of Object.keys(config.capabilities ?? {})) reserveProducer(name, 'capability');

  // Custom macros (their own namespace).
  for (const m of asArray(config.macros)) {
    if (!isDescriptor(m)) continue;
    const def = /** @type {any} */ (m);
    requireName(def.name, 'macro');
    if (reserved.has(def.name)) throw reservedName(def.name);
    if (macroNamespace.has(def.name)) throw nameConflict(def.name, 'macro');
    macroNamespace.add(def.name);
    macroFamilies[def.name] = def.family ?? (def.phase === 'expand' ? 'aggregator' : 'layout');
  }

  const capabilityNames = new Set(Object.keys(config.capabilities ?? {}));

  return Object.freeze({
    getProducer: (name) => producers.get(name),
    getTransformer: (type, name) => transformers.get(transformerKey(type, name)),
    getLibraryFn: (ns, name) => libraries.get(ns)?.get(name),
    hasLibrary: (ns) => libraries.has(ns),
    hasCapability: (name) => capabilityNames.has(name),
    getType: (name) => types.get(name),
    libraryNames: Object.freeze([...libraries.keys()]),
    macroFamilies: Object.freeze({ ...macroFamilies }),
  });
}

/** @param {string} type @param {string} name @returns {string} */
function transformerKey(type, name) {
  return `${type}::${name}`;
}

/** @param {unknown} x @returns {x is { name: string }} */
function isDescriptor(x) {
  return typeof x === 'object' && x !== null && typeof (/** @type {any} */ (x).name) === 'string';
}

/** @param {unknown} x @returns {unknown[]} */
function asArray(x) {
  return Array.isArray(x) ? x : [];
}

/** @param {unknown} name @param {string} kind @throws {EngineConfigError} */
function requireName(name, kind) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new EngineConfigError(`a custom ${kind} requires a non-empty string name`);
  }
}

/** @param {string} name @returns {EngineConfigError} */
function reservedName(name) {
  return new EngineConfigError(`'${name}' is a reserved word and cannot be redefined`, {
    code: DiagnosticCode.RESERVED_NAME,
    data: { name },
  });
}

/** @param {string} name @param {string} namespace @returns {EngineConfigError} */
function nameConflict(name, namespace) {
  return new EngineConfigError(`'${name}' is already defined in namespace '${namespace}'`, {
    code: DiagnosticCode.NAME_CONFLICT,
    data: { name, namespace },
  });
}
