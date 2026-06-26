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
import { NotImplementedError } from './util/errors.js';
import { AST_VERSION, STATE_VERSION, ANALYSIS_VERSION, migrations } from './util/versions.js';

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
 * Default limits (SPEC §2.2).
 * @type {Readonly<Record<string, number>>}
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxDepth: 20,
  maxPhases: 10,
  maxOutputBytes: 1_000_000,
  timeoutMs: 2000,
});

/**
 * Optimizations: all off in v1 (clarifications §3). They remain accepted in the config.
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
 * @property {string[]} [types]  Application-defined type names.
 * @property {Array<unknown>} [functions]  Application-defined functions/producers/transformers. // TODO(doc): narrow once function registration API is stable
 * @property {Array<unknown>} [macros]  Application-defined macros. // TODO(doc): narrow once macro registration API is stable
 * @property {string[]} [libraries]  Library/namespace names to enable (e.g. `'fake'`).
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
 * @property {string[]} [redact]  Requirement ids whose resolved values are redacted from diagnostics.
 * @property {(event: Record<string, unknown>) => void} [audit]  Audit hook called for each capability resolution. Default: noop.
 * @property {{ attempts: number, backoffMs: number }} [retry]  Retry policy. Default: `{ attempts: 0, backoffMs: 0 }` (no retry).
 */

/**
 * Fully resolved config produced by {@link normalizeConfig}. All optional fields from
 * {@link EngineConfig} that have defaults are guaranteed to be present.
 * @typedef {EngineConfig & { locale: string, clock: () => Date, capabilities: Record<string, import('./eval/evaluator.js').CapabilityFn>, delimiters: Record<string, string>, limits: Record<string, number>, optimizations: Record<string, boolean>, policy: EnginePolicy & { audit: (event: Record<string, unknown>) => void, retry: { attempts: number, backoffMs: number } } }} NormalizedConfig
 */

/**
 * Normalizes the config by applying the documented defaults. Pure, deterministic; does
 * not yet validate names/reserved words (that will be part of the language implementation).
 *
 * @param {EngineConfig} [config]
 * @returns {NormalizedConfig}
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
  const cfg = normalizeConfig(config);

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
  all: { types: /** @type {string[]} */ ([]), functions: /** @type {unknown[]} */ ([]), macros: /** @type {unknown[]} */ ([]) },
});

/** Migrators structure (empty in v1, IMPL §15). */
export { migrations };

/**
 * Defines a new data type (SPEC §2.6). v1 placeholder — always throws.
 * @param {string} _name  Unique type name; must not clash with {@link RESERVED_WORDS}.
 * @param {Record<string, unknown>} _def  Type definition descriptor.
 * @returns {never}
 * @throws {import('./util/errors.js').NotImplementedError}  Always in v1.
 */
export function defineType(_name, _def) {
  throw new NotImplementedError('defineType');
}

/**
 * Defines a new function, producer or transformer (SPEC §2.6). v1 placeholder — always throws.
 * @param {string} _name  Unique function name; must not clash with {@link RESERVED_WORDS}.
 * @param {Record<string, unknown>} _def  Function definition descriptor.
 * @returns {never}
 * @throws {import('./util/errors.js').NotImplementedError}  Always in v1.
 */
export function defineFunction(_name, _def) {
  throw new NotImplementedError('defineFunction');
}

/**
 * Defines a new macro, aggregator or layout (SPEC §2.6). v1 placeholder — always throws.
 * @param {string} _name  Unique macro name; must not clash with {@link RESERVED_WORDS}.
 * @param {Record<string, unknown>} _def  Macro definition descriptor.
 * @returns {never}
 * @throws {import('./util/errors.js').NotImplementedError}  Always in v1.
 */
export function defineMacro(_name, _def) {
  throw new NotImplementedError('defineMacro');
}

/**
 * Defines a new capability (SPEC §2.6). v1 placeholder — always throws.
 * @param {string} _name  Unique capability name.
 * @param {Record<string, unknown>} _def  Capability definition descriptor.
 * @returns {never}
 * @throws {import('./util/errors.js').NotImplementedError}  Always in v1.
 */
export function defineCapability(_name, _def) {
  throw new NotImplementedError('defineCapability');
}

/**
 * Defines a library/namespace (SPEC §2.6), e.g. `fake.*` (clarifications §4).
 * v1 placeholder — always throws.
 * @param {string} _name  Unique library/namespace name.
 * @param {Record<string, unknown>} _def  Library definition descriptor.
 * @returns {never}
 * @throws {import('./util/errors.js').NotImplementedError}  Always in v1.
 */
export function defineLibrary(_name, _def) {
  throw new NotImplementedError('defineLibrary');
}
