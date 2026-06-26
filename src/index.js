/**
 * @file Seebo public API (SPEC Part 2). Single package entry point:
 * `createEngine`, `builtins`, the `define*` functions and the version constants.
 *
 * v1 (clarifications §3): pure, synchronous core; async only in `drive`/`stebo`; all
 * optimizations off; no streaming exposed. The engine methods are placeholders until
 * the individual modules are implemented.
 */

import { tokenize as _tokenize } from './lexer/index.js';
import { parse as _parse } from './parser/index.js';
import { validate as _validate } from './validate/index.js';
import { analyze as _analyze } from './analyze/index.js';
import { start as _start, run as _run } from './run/index.js';
import { expand as _expand, finalize as _finalize } from './macros/index.js';
import { drive as _drive, stebo as _stebo } from './driver/index.js';
import { createRegistry } from './runtime/registry.js';
import { EngineConfigError } from './util/errors.js';
import { DEFAULT_LIMITS } from './util/limits.js';
import { AST_VERSION, STATE_VERSION, ANALYSIS_VERSION, migrations } from './util/versions.js';

export { DEFAULT_LIMITS };

export { AST_VERSION, STATE_VERSION, ANALYSIS_VERSION };
export { DiagnosticCode, createDiagnostic, SeeboError, EngineConfigError } from './util/errors.js';

// Public contract enums/constants (re-exported for discoverability).
export { TokenType } from './lexer/tokens.js';
export { NodeKind, ExprKind } from './ast/nodes.js';
export { TypeName, PRECISION_ORDER, DURATION_UNITS } from './runtime/values.js';
export { ResultKind } from './eval/evaluator.js';
export { Status } from './run/run.js';
export { Streamability } from './analyze/analyze.js';
export { MacroFamily, BUILTIN_MACROS } from './macros/index.js';
export { ProviderOutcome } from './driver/async_driver.js';

/**
 * Language reserved words (SPEC §1.5). An identifier introduced by the application
 * cannot match any of these.
 * @type {ReadonlyArray<string>}
 */
export const RESERVED_WORDS = Object.freeze([
  // operators and forms
  'and',
  'or',
  'not',
  'in',
  'match',
  // literals
  'true',
  'false',
  // builtin types (also act as producers)
  'int',
  'float',
  'bool',
  'string',
  'datetime',
  'duration',
  'object',
  'array',
  // builtin producers
  'now',
  'date',
  'require',
  'var',
  // builtin macros
  'ABSORB',
  'MERGE',
  'COLLAPSE',
  'REMOVE_LINE',
  'REMOVE_LEFT',
  'REMOVE_RIGHT',
]);

/**
 * Default delimiters (SPEC §1.2 / §2.2).
 * @type {Readonly<Record<string, string>>}
 */
export const DEFAULT_DELIMITERS = Object.freeze({
  formula: '$',
  comment: '#',
  macro: '@',
  open: '{',
  close: '}',
});

/**
 * Optimizations: all **off by default** (clarifications §3). `astCache` is implemented as a
 * transparent in-memory parse/analysis cache (IMPL §11/§12.1) when enabled; `lazyParse`,
 * `stream` and `objectPool` are accepted but inert in v1. See `docs/PERFORMANCE.md`.
 * @type {Readonly<Record<string, boolean>>}
 */
export const DEFAULT_OPTIMIZATIONS = Object.freeze({
  lazyParse: false,
  astCache: false,
  stream: false,
  objectPool: false,
});

/**
 * Engine configuration (SPEC §2.2). Simplified shape for v1; non-normative fields are
 * still accepted but inert.
 * @typedef {Object} EngineConfig
 * @property {Array<string | TypeExtensionDef>} [types]  Application-defined types (from {@link defineType}).
 * @property {Array<FunctionExtensionDef>} [functions]  Application-defined producers/transformers (from {@link defineFunction}).
 * @property {Array<MacroExtensionDef>} [macros]  Application-defined macros (from {@link defineMacro}).
 * @property {Array<string | LibraryExtensionDef>} [libraries]  Library namespaces to enable (name or {@link defineLibrary} descriptor).
 * @property {Record<string, import('./eval/evaluator.js').CapabilityFn>} [capabilities]  Capability providers keyed by name.
 * @property {EnginePolicy} [policy]  Runtime policy (allowlists, audit, redact, retry).
 * @property {string} [locale]  BCP-47 locale for formatting. Default: `'en-US'`.
 * @property {() => Date} [clock]  Clock override for deterministic testing. Default: `() => new Date()`.
 * @property {number} [seed]  RNG seed for deterministic outputs (reserved, unused in v1).
 * @property {Record<string, number>} [limits]  Override default limits (see {@link DEFAULT_LIMITS}).
 * @property {Record<string, string>} [delimiters]  Override default delimiters (see {@link DEFAULT_DELIMITERS}).
 * @property {Record<string, boolean>} [optimizations]  Override default optimization flags (see {@link DEFAULT_OPTIMIZATIONS}).
 */

/**
 * Policy (clarifications §6): simple and deterministic. `audit`/`redact` are hooks
 * (defaults: noop and identity respectively); `retry` performs no automatic retry in v1.
 * @typedef {Object} EnginePolicy
 * @property {string[]} [allowedTypes]  Restrict which types the template may use.
 * @property {string[]} [allowedFunctions]  Restrict which functions the template may call.
 * @property {string[]} [allowedCapabilities]  Restrict which capabilities the template may require.
 * @property {'trusted'|'untrusted'} [trustLevel]  Trust level of the template. Default: `'untrusted'`.
 * @property {Record<string, CapabilityRule>} [capabilityRules]  Per-capability authorization rules.
 * @property {string[]} [redact]  Requirement ids whose resolved values are redacted from diagnostics.
 * @property {(event: Record<string, unknown>) => void} [audit]  Audit hook called for each capability resolution. Default: noop.
 * @property {{ attempts: number, backoffMs: number }} [retry]  Retry policy. Default: `{ attempts: 0, backoffMs: 0 }` (no retry).
 */

/**
 * Per-capability authorization rule (SPEC §2.2, IMPL §13). Applied **before** the provider
 * is invoked, so a forbidden capability never runs.
 * @typedef {Object} CapabilityRule
 * @property {'trusted'|'untrusted'} [allowFrom]  Minimum template `trustLevel` allowed to use it.
 * @property {boolean} [audit]  When `true`, audit every invocation of this capability.
 */

/* ----------------------------------------------------------------------------------- *
 * Extension descriptors (SPEC §2.6). Produced by the `define*` factories and passed to
 * `createEngine`; the registry validates and indexes them.
 * ----------------------------------------------------------------------------------- */

/**
 * Custom data type descriptor (SPEC §2.6). Registered/validated by name; full runtime
 * construction wiring is a future extension (v1 reserves the name in the producer namespace).
 * @typedef {Object} TypeExtensionDef
 * @property {'type'} kind
 * @property {string} name
 * @property {string} [category]
 * @property {Record<string, unknown>} [defaultFormat]
 * @property {(value: unknown, constraints: Record<string, unknown>) => boolean} [validate]
 * @property {(value: unknown, format: Record<string, unknown>) => string} [stringify]
 */

/**
 * Custom function descriptor (SPEC §2.6): a producer (no `receiver`) or a transformer
 * (method on `receiver` type). See {@link import('./runtime/registry.js').FunctionDef}.
 * @typedef {Object} FunctionExtensionDef
 * @property {'function'} kind
 * @property {string} name
 * @property {string} [receiver]
 * @property {{ min: number, max: number }} [arity]
 * @property {(...args: any[]) => unknown} eval
 */

/**
 * Custom macro descriptor (SPEC §2.6): an aggregator (pre-pass) or layout (post-pass) macro.
 * @typedef {Object} MacroExtensionDef
 * @property {'macro'} kind
 * @property {string} name
 * @property {'aggregator'|'layout'} [family]
 * @property {'expand'|'finalize'} [phase]
 */

/**
 * Custom capability descriptor (SPEC §2.6). Register its `resolve` under the matching key
 * of {@link EngineConfig} `capabilities` (the map is the wiring point used by the driver).
 * @typedef {Object} CapabilityExtensionDef
 * @property {'capability'} kind
 * @property {string} name
 * @property {(req: import('./eval/evaluator.js').RequirementDescriptor) => unknown | Promise<unknown>} resolve
 */

/**
 * Custom library/namespace descriptor (SPEC §2.6), e.g. `geo.*`.
 * @typedef {Object} LibraryExtensionDef
 * @property {'library'} kind
 * @property {string} name
 * @property {Record<string, import('./runtime/registry.js').LibraryFnDef>} [functions]
 */

/**
 * Fully resolved config produced by {@link normalizeConfig}. All optional fields from
 * {@link EngineConfig} that have defaults are guaranteed to be present.
 * @typedef {EngineConfig & { locale: string, clock: () => Date, capabilities: Record<string, import('./eval/evaluator.js').CapabilityFn>, delimiters: Record<string, string>, limits: Record<string, number>, optimizations: Record<string, boolean>, registry: import('./runtime/registry.js').Registry, policy: EnginePolicy & { trustLevel: 'trusted'|'untrusted', capabilityRules: Record<string, CapabilityRule>, audit: (event: Record<string, unknown>) => void, retry: { attempts: number, backoffMs: number } } }} NormalizedConfig
 */

/**
 * Normalizes the config by applying the documented defaults. Pure and deterministic; name
 * governance (reserved words, uniqueness) is enforced separately by {@link createRegistry}.
 *
 * @param {EngineConfig} [config]
 * @returns {Omit<NormalizedConfig, 'registry'>}
 */
export function normalizeConfig(config = {}) {
  const policy = config.policy ?? {};
  return {
    ...config,
    locale: config.locale ?? 'en-US',
    clock: config.clock ?? (() => new Date()),
    capabilities: config.capabilities ?? {},
    delimiters: { ...DEFAULT_DELIMITERS, ...(config.delimiters ?? {}) },
    limits: { ...DEFAULT_LIMITS, ...(config.limits ?? {}) },
    optimizations: { ...DEFAULT_OPTIMIZATIONS, ...(config.optimizations ?? {}) },
    policy: {
      allowedTypes: policy.allowedTypes,
      allowedFunctions: policy.allowedFunctions,
      allowedCapabilities: policy.allowedCapabilities,
      trustLevel: policy.trustLevel ?? 'untrusted',
      capabilityRules: policy.capabilityRules ?? {},
      redact: policy.redact,
      audit: policy.audit ?? (() => {}),
      retry: policy.retry ?? { attempts: 0, backoffMs: 0 },
    },
  };
}

/**
 * Configured engine instance returned by {@link createEngine}.
 * All methods delegate to the underlying modules and are pre-bound to the resolved config.
 * @typedef {Object} Engine
 * @property {NormalizedConfig} config  The fully resolved configuration.
 * @property {(template: string) => import('./lexer/tokens.js').Token[]} tokenize  Tokenizes a template.
 * @property {(template: string) => import('./ast/nodes.js').Document} parse  Parses a template into an AST.
 * @property {(template: string) => import('./util/errors.js').Diagnostic[]} validate  Validates a template statically.
 * @property {(template: string) => import('./analyze/analyze.js').Analysis} analyze  Analyzes a template (compiler pass).
 * @property {(template: string, initialValues?: Record<string, unknown>) => import('./run/run.js').PublicState} start  Creates initial execution state.
 * @property {(state: import('./run/run.js').PublicState) => import('./run/run.js').PublicState} run  Runs one state-machine step.
 * @property {(args: { template: string, templates?: Record<string, string> }) => Promise<string>} expand  Pre-pass: expands macro aggregators.
 * @property {(text: string) => string} finalize  Post-pass: applies layout macros.
 * @property {(stateOrTemplate: import('./run/run.js').PublicState | string, opts?: import('./driver/async_driver.js').DriveOptions) => Promise<import('./run/run.js').PublicState>} drive  Drives state to completion asynchronously.
 * @property {(args: import('./driver/async_driver.js').SteboArgs) => Promise<import('./run/run.js').PublicState>} stebo  Convenience orchestrator: expand → drive → finalize.
 */

/**
 * Builds a configured engine (SPEC §2.2). Returns an object with the public API methods,
 * already "aware" of the config. The methods delegate to the modules (placeholders in v1).
 *
 * @param {EngineConfig} [config]
 * @returns {Engine}
 */
export function createEngine(config = {}) {
  // Name governance runs first (SPEC §1.5/§2.6): a reserved/duplicate name fails here.
  const registry = createRegistry(config);
  /** @type {NormalizedConfig} */
  const cfg = { ...normalizeConfig(config), registry };

  /** @type {Engine} */
  const engine = {
    config: cfg,
    tokenize: (template) => _tokenize(template, cfg),
    parse: (template) => _parse(template, cfg),
    validate: (template) => _validate(template, cfg),
    analyze: (template) => _analyze(template, cfg),
    start: (template, initialValues) => _start(template, initialValues, cfg),
    run: (state) => _run(state, cfg),
    expand: (args) => _expand(args, cfg),
    finalize: (text) => _finalize(text, cfg),
    drive: (stateOrTemplate, opts) => _drive(stateOrTemplate, opts, cfg),
    stebo: (args) => _stebo(args, cfg),
  };

  return engine;
}

/**
 * Builtin vocabulary ready to spread into `createEngine` (SPEC §2.2). v1 placeholder:
 * the sets are wired but empty until types/functions/macros are implemented.
 *
 * @type {{ types: string[], functions: unknown[], macros: unknown[], all: { types: string[], functions: unknown[], macros: unknown[] } }}
 */
export const builtins = Object.freeze({
  types: /** @type {string[]} */ ([]),
  functions: /** @type {unknown[]} */ ([]),
  macros: /** @type {unknown[]} */ ([]),
  all: {
    types: /** @type {string[]} */ ([]),
    functions: /** @type {unknown[]} */ ([]),
    macros: /** @type {unknown[]} */ ([]),
  },
});

/** Migrators structure (empty in v1, IMPL §15). */
export { migrations };

/**
 * Defines a new data type (SPEC §2.6). Returns a frozen descriptor to place in
 * `config.types`; the name is validated/reserved by {@link createEngine}.
 * @param {string} name  Unique type name; must not clash with {@link RESERVED_WORDS}.
 * @param {Omit<TypeExtensionDef, 'kind'|'name'>} [def]  Type behaviour (format/validate/stringify).
 * @returns {TypeExtensionDef}
 * @throws {EngineConfigError}  If `name` is not a non-empty string.
 */
export function defineType(name, def = {}) {
  requireName(name, 'type');
  return Object.freeze({ kind: 'type', name, ...def });
}

/**
 * Defines a new function — a producer (no `receiver`) or a transformer/method (on a
 * `receiver` type), SPEC §2.6. Returns a frozen descriptor for `config.functions`. The
 * `eval` implementation receives plain JS values and returns a plain JS value.
 * @param {string} name  Unique function name; must not clash with {@link RESERVED_WORDS}.
 * @param {Omit<FunctionExtensionDef, 'kind'|'name'>} [def]  Function behaviour (`receiver?`, `arity?`, `eval`).
 * @returns {FunctionExtensionDef}
 * @throws {EngineConfigError}  If `name`/`eval` are missing or invalid.
 */
export function defineFunction(name, def) {
  requireName(name, 'function');
  if (!def || typeof def.eval !== 'function') {
    throw new EngineConfigError(`defineFunction('${name}') requires an 'eval' function`);
  }
  return Object.freeze({ kind: 'function', name, ...def });
}

/**
 * Defines a new macro — an aggregator (pre-pass) or layout (post-pass), SPEC §2.6. Returns
 * a frozen descriptor for `config.macros`.
 * @param {string} name  Unique macro name; must not clash with {@link RESERVED_WORDS}.
 * @param {Omit<MacroExtensionDef, 'kind'|'name'>} [def]  `family`/`phase` of the macro.
 * @returns {MacroExtensionDef}
 * @throws {EngineConfigError}  If `name` is not a non-empty string.
 */
export function defineMacro(name, def = {}) {
  requireName(name, 'macro');
  return Object.freeze({ kind: 'macro', name, ...def });
}

/**
 * Defines a new capability (SPEC §2.6). Returns a frozen descriptor; register its `resolve`
 * under the matching key of `config.capabilities` (the driver's wiring point).
 * @param {string} name  Unique capability name; must not clash with {@link RESERVED_WORDS}.
 * @param {Omit<CapabilityExtensionDef, 'kind'|'name'>} [def]  Must carry a `resolve` provider.
 * @returns {CapabilityExtensionDef}
 * @throws {EngineConfigError}  If `name`/`resolve` are missing or invalid.
 */
export function defineCapability(name, def) {
  requireName(name, 'capability');
  if (!def || typeof def.resolve !== 'function') {
    throw new EngineConfigError(`defineCapability('${name}') requires a 'resolve' function`);
  }
  return Object.freeze({ kind: 'capability', name, ...def });
}

/**
 * Defines a library/namespace (SPEC §2.6), e.g. `geo.*`. Returns a frozen descriptor for
 * `config.libraries`; each `functions[fn].eval` receives/returns plain JS values.
 * @param {string} name  Unique library/namespace name; must not clash with {@link RESERVED_WORDS}.
 * @param {Omit<LibraryExtensionDef, 'kind'|'name'>} [def]  The namespace's `functions`.
 * @returns {LibraryExtensionDef}
 * @throws {EngineConfigError}  If `name` is not a non-empty string.
 */
export function defineLibrary(name, def = {}) {
  requireName(name, 'library');
  return Object.freeze({ kind: 'library', name, ...def });
}

/** Validates an extension name eagerly at definition time. @param {unknown} name @param {string} kind */
function requireName(name, kind) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new EngineConfigError(
      `define${kind[0].toUpperCase()}${kind.slice(1)} requires a non-empty string name`
    );
  }
}
