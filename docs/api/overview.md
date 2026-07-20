# API Reference

The public API of Seebo, summarized from the JSDoc contracts. Everything below is exported
from the package entry point (`import { … } from 'seebo'`). Section references like
`SPEC §x` / `IMPL §x` point to [`spec.md`](../reference/spec.md) and
[`impl.md`](../reference/impl.md).

The engine is **plain JavaScript + JSDoc**. The shapes below are documentation of the JSDoc
typedefs, not TypeScript declarations.

---

## `createEngine(config?) → Engine`

Builds a configured engine (SPEC §2.2). Binds the vocabulary, policy and environment once and
returns an object whose methods are pre-bound to the resolved config. **Fails fast** with an
`EngineConfigError` on an invalid/duplicate name (name governance runs first).

```js
import { createEngine, builtins } from 'seebo';
const engine = createEngine({ ...builtins.all, locale: 'it-IT' });
```

### `Engine` methods

Static & pure (synchronous; depend only on `template` + config):

| Method               | Returns          | Purpose                                                                   |
| -------------------- | ---------------- | ------------------------------------------------------------------------- |
| `tokenize(template)` | `Token[]`        | Flat, **error-tolerant** token stream (never throws).                     |
| `parse(template)`    | `Document` (AST) | Parse to AST; **throws** a `SYNTAX_ERROR`-coded error on malformed input. |
| `validate(template)` | `Diagnostic[]`   | Static diagnostics (empty = valid); **never throws**.                     |
| `analyze(template)`  | `Analysis`       | Compiler-style plan: requirements, graph, metrics.                        |

Execution — pure & synchronous (IMPL §6):

| Method                            | Returns       | Purpose                                                                   |
| --------------------------------- | ------------- | ------------------------------------------------------------------------- |
| `start(template, initialValues?)` | `PublicState` | Initial state (`status: 'running'`). Raw values are wrapped via `fromJs`. |
| `run(state)`                      | `PublicState` | One state-machine step; collects open `Need`s into `pending`.             |

Orchestration — async (the only async layer; IMPL §7):

| Method                             | Returns                | Purpose                                                 |
| ---------------------------------- | ---------------------- | ------------------------------------------------------- |
| `expand({ template, templates? })` | `Promise<string>`      | Pre-pass: inline `ABSORB`/`MERGE` aggregators.          |
| `finalize(text)`                   | `string`               | Post-pass: apply layout macros to resolved text (sync). |
| `drive(stateOrTemplate, opts?)`    | `Promise<PublicState>` | Drive a state/template to completion via capabilities.  |
| `stebo(args)`                      | `Promise<PublicState>` | Convenience orchestrator: `expand → drive → finalize`.  |

`engine.config` exposes the fully resolved `NormalizedConfig` (read-only intent).

- `DriveOptions` = `{ stopOn?: string[] }` — capabilities to **not** resolve (returned to the caller).
- `SteboArgs` = `{ template: string, templates?: Record<string,string>, values?: Record<string,unknown>, stopOn?: string[] }`.

---

## `builtins`

The standard vocabulary names the core implements directly, for explicit spreading into
`createEngine`. Spreading is a no-op (these are always available); the registry ignores plain
string entries.

```js
builtins.types; // ['int','float','bool','string','datetime','duration','object','array']
builtins.functions; // ['now','date']
builtins.macros; // ['ABSORB','MERGE','COLLAPSE','REMOVE_LINE','REMOVE_LEFT','REMOVE_RIGHT']
builtins.all; // { types, functions, macros }
```

---

## Extension factories (`define*`, SPEC §2.6)

Each returns a **frozen descriptor** to place in the matching `createEngine` config array.
Implementations are **trusted host code**: they receive plain JS values and their results are
re-wrapped via `fromJs` (no internal `Value`s leak; no `eval` of template text).

| Factory                       | Descriptor `kind` | Place in config                              | Notes                                                                                                          |
| ----------------------------- | ----------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `defineType(name, def?)`      | `'type'`          | `types`                                      | `category?`, `defaultFormat?`, `validate?(v,c)`, `stringify?(v,f)`.                                            |
| `defineFunction(name, def)`   | `'function'`      | `functions`                                  | Producer (no `receiver`) or transformer (`receiver` type); `arity?`, `eval`.                                   |
| `defineMacro(name, def?)`     | `'macro'`         | `macros`                                     | `family?`/`phase?`; a `'finalize'` macro may carry `apply(slot, doc)`.                                         |
| `defineCapability(name, def)` | `'capability'`    | place the descriptor at `capabilities[name]` | `resolve(req)` (sync or `Promise`); optional contract `type`/`label`/`description` inherited by `need('cap')`. |
| `defineLibrary(name, def?)`   | `'library'`       | `libraries`                                  | `functions: { fn: { arity?, eval } }`, invoked as `name.fn()`.                                                 |
| `defineAction(type, handler)` | `'action'`        | `actions` _or_ `engine.defineAction(...)`    | Effect handler (`execute`, `dryRun?`, `compensate?`); runs only via `seebo/actions`.                           |

See the [usage guide](../guide/usage.md) for worked examples of each.

---

## Actions (`seebo/actions`, SPEC §2.8)

`action(...)` is a declarative **effect declaration** — the engine prepares an action plan
(`run(state).actions` / `analyze(template).actions`) but **never** executes it. Execution is
explicit, through the `seebo/actions` subpath:

```js
import { createEngine } from 'seebo';
import { executeActionPlan } from 'seebo/actions';
```

| Function (`seebo/actions`)            | Returns                          | Purpose                               |
| ------------------------------------- | -------------------------------- | ------------------------------------- |
| `executeAction(action, ctx)`          | `Promise<ActionReceipt>`         | Run one prepared action.              |
| `executeActionPlan(plan, ctx)`        | `Promise<ActionExecutionResult>` | Run a plan in document order.         |
| `dryRunAction(action, ctx)`           | `Promise<ActionReceipt>`         | Dry-run one action (never `execute`). |
| `dryRunActionPlan(plan, ctx)`         | `Promise<ActionExecutionResult>` | Dry-run a plan.                       |
| `compensateAction(receipt, ctx)`      | `Promise<ActionReceipt>`         | Roll back one succeeded action.       |
| `compensateActionPlan(receipts, ctx)` | `Promise<ActionExecutionResult>` | Roll back receipts in reverse order.  |

`engine.defineAction(type, handler)` registers a handler on a live engine. The action contract
enums (`ActionStatus`, `ActionErrorCode`, `ActionEventType`, `PlanStatus`) are re-exported from
both `seebo` and `seebo/actions`. The execution APIs never throw — failures are structured
`ActionReceipt`s carrying an `ActionError`. See [Actions](../guide/actions.md) for the full model:
lifecycle, confirmation, dry-run, idempotency, retry, permissions/policy, audit/redaction and
compensation.

---

## Configuration

### `EngineConfig` (all fields optional)

| Field           | Type                                    | Default                 | Notes                                                                                                                                  |
| --------------- | --------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `types`         | `Array<string \| TypeExtensionDef>`     | `[]`                    | Custom types (+ builtin names, ignored).                                                                                               |
| `functions`     | `Array<string \| FunctionExtensionDef>` | `[]`                    | Producers/transformers.                                                                                                                |
| `macros`        | `Array<string \| MacroExtensionDef>`    | `[]`                    | Aggregator/layout macros.                                                                                                              |
| `libraries`     | `Array<string \| LibraryExtensionDef>`  | `[]`                    | A string only **enables** a namespace.                                                                                                 |
| `capabilities`  | `Record<string, fn \| CapabilityDef>`   | `{}`                    | The whole capability set; an entry may be a resolver fn or a `defineCapability` descriptor (with a contract). No builtins (SPEC §1.6). |
| `actions`       | `ActionExtensionDef[]`                  | `[]`                    | Action handlers (`defineAction`); executed only via `seebo/actions`.                                                                   |
| `policy`        | `EnginePolicy`                          | see below               | Allow-lists, trust, audit, redact, retry, action controls.                                                                             |
| `locale`        | `string`                                | `'en-US'`               | Formatting locale (BCP-47).                                                                                                            |
| `clock`         | `() => Date`                            | `() => new Date()`      | Injected clock for `now()` (determinism).                                                                                              |
| `seed`          | `number`                                | —                       | Reserved (unused in v1).                                                                                                               |
| `limits`        | `Record<string, number>`                | `DEFAULT_LIMITS`        | Per-phase resource bounds (see README/SECURITY).                                                                                       |
| `delimiters`    | `Record<string, string>`                | `DEFAULT_DELIMITERS`    | `{ formula:'$', comment:'#', macro:'@', open:'{', close:'}' }`.                                                                        |
| `optimizations` | `Record<string, boolean>`               | `DEFAULT_OPTIMIZATIONS` | Only `astCache` is implemented (opt-in).                                                                                               |

### `EnginePolicy`

| Field                 | Type                             | Effect                                                                                                     |
| --------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `allowedTypes`        | `string[]`                       | Static allow-list; a forbidden type constructor → `POLICY_FORBIDDEN`.                                      |
| `allowedFunctions`    | `string[]`                       | Static allow-list for producers/library fns/custom transformers.                                           |
| `allowedCapabilities` | `string[]`                       | Hard allow-list; checked in `validate` and the driver.                                                     |
| `trustLevel`          | `'trusted' \| 'untrusted'`       | Template trust level (default `'untrusted'`).                                                              |
| `capabilityRules`     | `Record<string, CapabilityRule>` | Per-capability rules, checked **before** the provider runs.                                                |
| `redact`              | `string[]`                       | Capability ids whose values are masked in diagnostics/audit.                                               |
| `audit`               | `(event) => void`                | Hook per capability resolution (no value in clear). Default: noop.                                         |
| `retry`               | `{ attempts, backoffMs }`        | Provider retry policy. Default: no retry.                                                                  |
| `action`              | `ActionPolicy`                   | Action controls (allow/deny types, environments, forced confirmation). See [Actions](../guide/actions.md). |

`CapabilityRule` = `{ allowFrom?: 'trusted'|'untrusted', audit?: boolean }`. `allowFrom: 'trusted'`
forbids the capability for an untrusted template (`CAPABILITY_FORBIDDEN`); `audit: false` opts
the capability out of the audit hook.

`normalizeConfig(config?)` is exported and applies these documented defaults (pure).

---

## Core types

### `PublicState` (SPEC §2.4 / IMPL §6.1) — the only serializable snapshot

```
{
  stateVersion: number,        // see STATE_VERSION
  template: string,
  resolved: Record<string, Value>,
  pending: RequirementDescriptor[],
  phase: number,               // monotonically increasing step counter
  status: 'running'|'waiting'|'completed'|'failed',  // see Status
  output?: string,             // present when status === 'completed'
  diagnostics?: Diagnostic[],  // present when status === 'failed'
}
```

`Status` = `{ RUNNING:'running', WAITING:'waiting', COMPLETED:'completed', FAILED:'failed' }`.

### `RequirementDescriptor` (SPEC §1.6)

`{ id, type, capability, label?, description?, optional?, priority?, group?, args? }`, plus the
analyze-derived `phase?` and `options?` (extracted from `type.constraints.values`). `args` is data
forwarded opaquely to the capability provider; its value may reference another binding (SPEC §2.4),
in which case the dependency is resolved first (the analyze graph orders them into phases).

Declared inline with `need({ id, capability })` (or the sugar `cap('id')`), or **lazily** for reuse
with `prepare(need(...))`. A capability may declare a contract (`type`/`constraints`/`label`) that
the sugar `cap('id')` inherits (template overrides win). Note: `bind(name, type)` names a **pure
value**, not a need.

### `Diagnostic` (IMPL Appendix A)

```
{ code: string, severity: 'error'|'warning'|'info',
  phase: 'createEngine'|'tokenize'|'parse'|'validate'|'analyze'|'run'|'driver',
  recoverable: boolean, message: string,
  position?: { start: number, end: number }, data?: Record<string, unknown> }
```

`createDiagnostic(code, opts?)` builds one. `DiagnosticCode` is the **frozen, stable** enum of
codes (never renamed; adding new ones is non-breaking). Notable codes: `SYNTAX_ERROR`,
`UNDECLARED_NAME`, `UNKNOWN_FUNCTION`, `UNKNOWN_METHOD`, `ARITY_MISMATCH`, `TYPE_ERROR`,
`NON_EXHAUSTIVE_MATCH`, `UNKNOWN_CAPABILITY`, `POLICY_FORBIDDEN`, `RESERVED_NAME`,
`NAME_CONFLICT`, `TYPE_ERROR_RUNTIME`, `CONSTRAINT_VIOLATION`, `DIVISION_BY_ZERO`,
`INCLUSION_CYCLE`, `DEPTH_EXCEEDED`, `MAX_PHASES_EXCEEDED`, `OUTPUT_LIMIT_EXCEEDED`, `TIMEOUT`,
the parse/run limit codes (`INPUT/TOKEN/NODE/NESTING/STEP_LIMIT_EXCEEDED`), the driver codes
(`CAPABILITY_FORBIDDEN`/`_ERROR`/`_INVALID_VALUE`), and `UNSUPPORTED_STATE_VERSION`.

### `Analysis` (IMPL §9) — returned by `analyze`

```
{ analysisVersion: number, ast: Document,
  requirements: RequirementDescriptor[],
  requirementGraph, executionPlan,
  capabilitiesUsed: string[],
  staticValues: Record<string, Value>,
  deterministic: boolean,
  streamability: 'full'|'partial'|'buffered',   // see Streamability
  potentialCycles, maxPhases: number, worstCaseRequirements: number }
```

### `Value` (IMPL §4) — immutable typed record

`{ type, value, format, constraints }`, frozen; always produced by the engine. `TypeName` is
the enum of base types; `PRECISION_ORDER` and `DURATION_UNITS` are the related constants.

### `ProviderOutcome` (IMPL §7.1)

`{ RESOLVED:'Resolved', UNRESOLVED:'Unresolved', PROVIDER_ERROR:'ProviderError', INVALID_VALUE:'InvalidValue' }`
— the driver's classification of a capability result.

---

## Constants & versions

| Export                              | Meaning                                                              |
| ----------------------------------- | -------------------------------------------------------------------- |
| `RESERVED_WORDS`                    | Names an extension cannot use (operators, types, producers, macros). |
| `DEFAULT_DELIMITERS`                | `{ formula, comment, macro, open, close }`.                          |
| `DEFAULT_LIMITS`                    | Default resource limits (see README/SECURITY).                       |
| `DEFAULT_OPTIMIZATIONS`             | `{ lazyParse, astCache, stream, objectPool }` — all `false`.         |
| `AST_VERSION`                       | Version of the AST shape (`1`).                                      |
| `STATE_VERSION`                     | Version of `PublicState` (`1`).                                      |
| `ANALYSIS_VERSION`                  | Version of `Analysis` (`1`).                                         |
| `migrations`                        | Registered state migrators (empty in v1; IMPL §15).                  |
| `TokenType`, `NodeKind`, `ExprKind` | Lexer/AST discriminators.                                            |
| `ResultKind`                        | Evaluator outcome tags (`Ok`/`Susp`/`Err`).                          |
| `MacroFamily`, `BUILTIN_MACROS`     | Macro family enum and the builtin macro names.                       |

---

## Error classes

- `SeeboError extends Error` — base for engine exceptions; carries `code?` and `position?`.
  Use `instanceof SeeboError` to distinguish engine failures. Thrown only where the SPEC
  mandates (e.g. `parse` on malformed syntax); everywhere else failures are diagnostics.
- `EngineConfigError extends SeeboError` — invalid configuration at `createEngine` (e.g.
  `RESERVED_NAME`, `NAME_CONFLICT`); carries `data?`.
