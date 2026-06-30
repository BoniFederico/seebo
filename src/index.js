/**
 * @file Seebo public API (SPEC Part 2). Single package entry point: `createEngine`,
 * `builtins`, the `define*` functions and the version constants.
 *
 * v1 (clarifications §3): pure, synchronous core; async confined to `drive`/`stebo`; all
 * optimizations off by default; no streaming exposed.
 */

import { tokenize as _tokenize } from './lexer/index.js';
import { parse as _parse } from './parser/index.js';
import { validate as _validate } from './validate/index.js';
import { analyze as _analyze } from './analyze/index.js';
import { start as _start, run as _run } from './run/index.js';
import { expand as _expand, finalize as _finalize } from './macros/index.js';
import { drive as _drive, stebo as _stebo } from './driver/index.js';
import { createRegistry } from './runtime/registry.js';
import { builder } from './runtime/values.js';
import { EngineConfigError, DiagnosticCode } from './util/errors.js';
import { DEFAULT_LIMITS } from './util/limits.js';
import { AST_VERSION, STATE_VERSION, ANALYSIS_VERSION, migrations } from './util/versions.js';
import {
  RESERVED_WORDS,
  BUILTIN_TYPE_NAMES,
  BUILTIN_PRODUCER_NAMES,
  BUILTIN_MACRO_NAMES,
} from './util/vocabulary.js';

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
export { ActionStatus, ActionErrorCode, ActionEventType, PlanStatus } from './actions/contracts.js';

/**
 * Language reserved words (SPEC §1.5). An identifier introduced by the application cannot
 * match any of these. Re-exported from the canonical {@link ./util/vocabulary.js}.
 * @type {ReadonlyArray<string>}
 */
export { RESERVED_WORDS };

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
 * @property {Array<string | TypeExtensionDef>} [types]  Application-defined types (from {@link defineType}); plain builtin names (from {@link builtins}) are accepted and ignored.
 * @property {Array<string | FunctionExtensionDef>} [functions]  Application-defined producers/transformers (from {@link defineFunction}); plain builtin names are accepted and ignored.
 * @property {Array<string | MacroExtensionDef>} [macros]  Application-defined macros (from {@link defineMacro}); plain builtin names are accepted and ignored.
 * @property {Array<string | LibraryExtensionDef>} [libraries]  Library namespaces to enable (name or {@link defineLibrary} descriptor).
 * @property {Record<string, import('./eval/evaluator.js').CapabilityFn | CapabilityExtensionDef>} [capabilities]  Capability providers keyed by name; a {@link defineCapability} descriptor also registers a contract.
 * @property {ActionExtensionDef[]} [actions]  Application-defined action handlers (from {@link defineAction}); executed only via `seebo/actions`.
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
 * @property {ActionPolicy} [action]  Action-control policy (SPEC §2.8): allow/deny, environment rules, confirmation. Enforced by `seebo/actions`.
 */

/**
 * Action-control policy (SPEC §2.8). Deterministic and fail-closed: when an allow-list is
 * present, anything not on it is denied. Enforced by the execution layer (`seebo/actions`) and
 * partially by `validate` (statically detectable cases). All fields optional.
 * @typedef {Object} ActionPolicy
 * @property {string[]} [allowedActions]  When present, only these action types may run.
 * @property {string[]} [deniedActions]  Action types that may never run (wins over allow).
 * @property {boolean} [requireConfirmation]  Force confirmation for every action.
 * @property {string[]} [requireConfirmationFor]  Force confirmation for these action types.
 * @property {string[]} [allowedEnvironments]  When present, only these environments are allowed.
 * @property {Record<string, string[]>} [actionEnvironmentRules]  Per-type environment allow-lists.
 * @property {boolean} [failFast]  Default `failFast` for plan execution. Default: `false`.
 * @property {string} [defaultEnvironment]  Environment assigned to an action that pins none. Default: `'test'`.
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
 * Custom data type descriptor (SPEC §2.6). Registered/validated by name and wired into the
 * evaluator: `name(arg)` constructs a value (running `validate` at construction), `stringify`
 * renders it at slot emission, and `defaultFormat` seeds its `format`.
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
 * A layout macro may carry an `apply(slot, doc)` invoked by FINALIZE on its emitted marker;
 * its return value replaces the marker span (see {@link import('./macros/finalize.js').finalize}).
 * @typedef {Object} MacroExtensionDef
 * @property {'macro'} kind
 * @property {string} name
 * @property {'aggregator'|'layout'} [family]
 * @property {'expand'|'finalize'} [phase]
 * @property {(slot: { name: string, args: string[], start: number, end: number }, doc: { text: string }) => unknown} [apply]
 */

/**
 * Custom capability descriptor (SPEC §2.6). Place the whole descriptor under the matching key of
 * {@link EngineConfig} `capabilities` to also register its **contract** (`type`/`constraints`/…),
 * which a `need('cap')` inherits (SPEC §1.6); a bare resolver function is still accepted (no
 * contract). The map is the wiring point used by the driver (`resolve`) and the static passes
 * (the contract).
 * @typedef {Object} CapabilityExtensionDef
 * @property {'capability'} kind
 * @property {string} name
 * @property {(req: import('./eval/evaluator.js').RequirementDescriptor) => unknown | Promise<unknown>} resolve
 * @property {import('./runtime/values.js').TypeBuilder | import('./runtime/values.js').TypeDescriptor | string} [type]  Default value type (with its `constraints`/`format`) for needs of this capability.
 * @property {string} [label]  Default human label for the need.
 * @property {string} [description]  Default description for the need.
 */

/**
 * Static contract a capability declares (SPEC §1.6). Inherited by a `need('cap')` and overridable
 * per-need by the template (template wins). Derived from a {@link CapabilityExtensionDef} by
 * {@link normalizeConfig}; `type` is a resolved {@link import('./runtime/values.js').TypeDescriptor}
 * carrying its own `constraints`/`format`.
 * @typedef {Object} CapabilityContract
 * @property {import('./runtime/values.js').TypeDescriptor} [type]
 * @property {string} [label]
 * @property {string} [description]
 */

/**
 * Custom library/namespace descriptor (SPEC §2.6), e.g. `geo.*`.
 * @typedef {Object} LibraryExtensionDef
 * @property {'library'} kind
 * @property {string} name
 * @property {Record<string, import('./runtime/registry.js').LibraryFnDef>} [functions]
 */

/**
 * Action-handler descriptor (SPEC §2.8), produced by {@link defineAction}. Registers the host's
 * concrete effect implementation for an action `type`. The pure core never runs the handler —
 * only `seebo/actions` does. Semantically separate from capabilities.
 * @typedef {Object} ActionExtensionDef
 * @property {'action'} kind
 * @property {string} type  The action type name (e.g. `'jira.createIssue'`); dotted names allowed.
 * @property {import('./actions/contracts.js').ActionHandler} handler  The `execute`/`dryRun?`/`compensate?` implementation.
 */

/**
 * Fully resolved config produced by {@link normalizeConfig}. All optional fields from
 * {@link EngineConfig} that have defaults are guaranteed to be present.
 * @typedef {EngineConfig & { locale: string, clock: () => Date, capabilities: Record<string, import('./eval/evaluator.js').CapabilityFn>, capabilityContracts: Record<string, CapabilityContract>, delimiters: Record<string, string>, limits: Record<string, number>, optimizations: Record<string, boolean>, registry: import('./runtime/registry.js').Registry, policy: EnginePolicy & { trustLevel: 'trusted'|'untrusted', capabilityRules: Record<string, CapabilityRule>, audit: (event: Record<string, unknown>) => void, retry: { attempts: number, backoffMs: number } } }} NormalizedConfig
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
  const { providers, contracts } = splitCapabilities(config.capabilities);
  return {
    ...config,
    locale: config.locale ?? 'en-US',
    clock: config.clock ?? (() => new Date()),
    capabilities: providers,
    capabilityContracts: contracts,
    actions: config.actions ?? [],
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
      action: policy.action ?? {},
    },
  };
}

/**
 * Splits the `capabilities` map into the provider functions consumed by the driver and the
 * (optional) per-capability **contracts** consumed by the static passes (SPEC §1.6). Each entry
 * may be a bare resolver function (no contract) or a {@link CapabilityExtensionDef} descriptor
 * (from {@link defineCapability}, carrying `resolve` plus `type`/`constraints`/`format`/`label`/
 * `description`). Pure; the descriptor's contract is what `need('cap')` inherits.
 *
 * @param {Record<string, import('./eval/evaluator.js').CapabilityFn | CapabilityExtensionDef>} [capabilities]
 * @returns {{ providers: Record<string, import('./eval/evaluator.js').CapabilityFn>, contracts: Record<string, CapabilityContract> }}
 */
function splitCapabilities(capabilities) {
  /** @type {Record<string, import('./eval/evaluator.js').CapabilityFn>} */
  const providers = {};
  /** @type {Record<string, CapabilityContract>} */
  const contracts = {};
  for (const [name, entry] of Object.entries(capabilities ?? {})) {
    if (typeof entry === 'function') {
      providers[name] = entry;
      continue;
    }
    if (entry && typeof entry === 'object' && typeof entry.resolve === 'function') {
      providers[name] = entry.resolve;
      const contract = capabilityContractOf(entry);
      if (contract) contracts[name] = contract;
      continue;
    }
    throw new EngineConfigError(
      `capability '${name}' must be a resolver function or a defineCapability() descriptor`
    );
  }
  return { providers, contracts };
}

/**
 * Extracts the static contract (`type`, `label`, `description`) from a capability descriptor, or
 * `undefined` when it declares none. The `type` builder/descriptor (carrying its own
 * `constraints`/`format`) is normalized to a {@link import('./runtime/values.js').TypeDescriptor}.
 * @param {CapabilityExtensionDef} def
 * @returns {CapabilityContract | undefined}
 */
function capabilityContractOf(def) {
  /** @type {CapabilityContract} */
  const contract = {};
  let has = false;
  if (def.type !== undefined) {
    contract.type = toTypeDescriptor(def.type);
    has = true;
  }
  if (typeof def.label === 'string') {
    contract.label = def.label;
    has = true;
  }
  if (typeof def.description === 'string') {
    contract.description = def.description;
    has = true;
  }
  return has ? contract : undefined;
}

/**
 * Normalizes a capability's declared `type` to a {@link import('./runtime/values.js').TypeDescriptor}.
 * Accepts a {@link import('./runtime/values.js').TypeBuilder} (`object()`), an already-built
 * descriptor, or a base type name string.
 * @param {unknown} type
 * @returns {import('./runtime/values.js').TypeDescriptor}
 */
function toTypeDescriptor(type) {
  if (typeof type === 'string') return builder(type).toDescriptor();
  const t = /** @type {any} */ (type);
  if (t && typeof t.toDescriptor === 'function') return t.toDescriptor();
  return /** @type {import('./runtime/values.js').TypeDescriptor} */ (t);
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
 * @property {(type: string, handler: import('./actions/contracts.js').ActionHandler) => Engine} defineAction  Registers a concrete action handler for `type` (SPEC §2.8); returns the engine for chaining. Handlers run only via `seebo/actions`.
 */

/**
 * Builds a configured engine (SPEC §2.2). Returns an object with the public API methods,
 * already "aware" of the config; each method delegates to its module with the config bound.
 *
 * @param {EngineConfig} [config]
 * @returns {Engine}
 */
export function createEngine(config = {}) {
  // Name governance runs first (SPEC §1.5/§2.6): a reserved/duplicate name fails here. This
  // also validates any statically-configured `config.actions` handlers.
  const registry = createRegistry(config);

  // Live action-handler map for post-construction `engine.defineAction` (SPEC §2.8). It is
  // layered on top of the frozen registry: a dynamically-registered handler shadows none of
  // the language vocabulary (actions have their own namespace) and is looked up first.
  /** @type {Map<string, import('./actions/contracts.js').ActionHandler>} */
  const dynamicActions = new Map();
  const composedRegistry = Object.freeze({
    ...registry,
    getAction: (/** @type {string} */ type) => dynamicActions.get(type) ?? registry.getAction(type),
    hasAction: (/** @type {string} */ type) => dynamicActions.has(type) || registry.hasAction(type),
    get actionNames() {
      return Object.freeze([...new Set([...registry.actionNames, ...dynamicActions.keys()])]);
    },
  });

  /** @type {NormalizedConfig} */
  const cfg = { ...normalizeConfig(config), registry: composedRegistry };

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
    defineAction: (type, handler) => {
      const def = defineAction(type, handler);
      if (composedRegistry.hasAction(def.type)) {
        throw new EngineConfigError(`action '${def.type}' is already defined`, {
          code: DiagnosticCode.NAME_CONFLICT,
          data: { type: def.type },
        });
      }
      dynamicActions.set(def.type, def.handler);
      return engine;
    },
  };

  return engine;
}

/**
 * Builtin vocabulary ready to spread into `createEngine` (SPEC §2.2): the standard names the
 * core implements directly (base types, standard producers, macros). These are always
 * available — the engine has them built in — and are exposed here as **names** so an
 * application can spread `...builtins.all` to be explicit about the language surface.
 * Spreading them is a no-op (they are reserved/handled regardless; the registry ignores plain
 * string entries); custom `define*` descriptors are added on top. Sourced from the canonical
 * {@link ./util/vocabulary.js}.
 *
 * @type {{ types: string[], functions: string[], macros: string[], all: { types: string[], functions: string[], macros: string[] } }}
 */
export const builtins = Object.freeze({
  types: [...BUILTIN_TYPE_NAMES],
  functions: [...BUILTIN_PRODUCER_NAMES],
  macros: [...BUILTIN_MACRO_NAMES],
  all: {
    types: [...BUILTIN_TYPE_NAMES],
    functions: [...BUILTIN_PRODUCER_NAMES],
    macros: [...BUILTIN_MACRO_NAMES],
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
 * Defines a concrete action handler (SPEC §2.8). Returns a frozen {@link ActionExtensionDef} to
 * place in `config.actions`, or pass to `engine.defineAction(type, handler)`. The handler is the
 * host's effect implementation; it runs **only** through the `seebo/actions` execution layer,
 * never during parse/validate/analyze/run. Semantically separate from capabilities.
 * @param {string} type  The action type name (e.g. `'jira.createIssue'`); dotted names allowed.
 * @param {import('./actions/contracts.js').ActionHandler} handler  Must carry an `execute` function.
 * @returns {ActionExtensionDef}
 * @throws {EngineConfigError}  If `type` is not a non-empty string or `handler.execute` is missing.
 */
export function defineAction(type, handler) {
  if (typeof type !== 'string' || type.length === 0) {
    throw new EngineConfigError('defineAction requires a non-empty string type');
  }
  if (!handler || typeof handler.execute !== 'function') {
    throw new EngineConfigError(`defineAction('${type}') requires an 'execute' function`);
  }
  return Object.freeze({ kind: 'action', type, handler: Object.freeze({ ...handler }) });
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
