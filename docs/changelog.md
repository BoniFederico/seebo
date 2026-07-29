# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **BREAKING: `bind` is now value-only; need/action are declared lazily with `prepare(...)`.** `bind(name, type)` names a **pure value** binding; `bind('x', need(...))` and
  `bind('x', action(...))` are **removed**. A need/action is declared for reuse with
  `prepare(need(...))` / `prepare(action(...))`, carrying its own `id`. Both are read **plain**
  (`${ id }`) and are **lazy** — the need is requested, and the action activated, only where its id
  is referenced. Migration: `bind('id', need('cap'))` → `prepare(cap('id'))` (or
  `prepare(need({ id, capability })))`); `bind('id', action({...}))` → `prepare(action({ id, ... }))`.

### Added

- **Computed member access `receiver[key]`.** Bracket access on objects and arrays,
  alongside static `receiver.key`: `o['strange key!']` reads an object property whose
  name isn't a valid identifier or is computed at runtime (`o[k]`), and `a[i]` indexes
  an array by an int expression. Sugar over the existing `o.get(key)` / `a.get(i)`
  methods — same runtime semantics (prototype-pollution guards, bounds checks), just
  without needing to route through a method call.
- **Capability sugar string shorthand `cap('id')`.** A registered capability used with a bare
  string is the requirement **id**: `input('amount')` ≡ `need({ id:'amount', capability:'input' })`
  (inheriting the capability contract). Fixes the previous `cap('x')` error ("need descriptor needs
  a string 'id'").

## [0.3.0] — 2026-06-30

### Changed

- **Binding redesign.** Unified the declarative surface under
  `bind(name, descriptor)` and `need({...})`. A name is declared once and read **plain** by name
  afterwards (`${ name }`); a reference to an undeclared name is `UNDECLARED_NAME`.
- **Capability contracts.** `defineCapability({ type, label, description, resolve })` declares
  a contract that a need inherits, so the template need not repeat the type; the template
  still wins on any field it overrides. A capability map entry may be a resolver function (as before)
  or a `defineCapability` descriptor.
- **Dynamic capability `args`.** A capability `args` value may reference another binding; the
  dependency becomes a static edge in the requirement graph (ordered into phases by `analyze`) while
  the value stays runtime. An `args` dependency cycle is reported as `CYCLE_DETECTED`.

### Removed

- **BREAKING: `var`, `require`, and `resolverHints` are removed entirely** (no deprecation period).
  Migration: `var('x', T())` → `bind('x', T())`; `require({...})` → `need({...})` (capability sugar
  `cap({...})` is unchanged); `resolverHints` → `args`. Reading a bound value no longer uses
  `var('x')` — reference it plain as `${ x }`.

## [0.2.0] — 2026-06-29

### Added

- **Actions (`action(...)`).** A declarative **effect declaration** prepared by the
  pure core and executed only through the new `seebo/actions` subpath. `${ action({...}) }` is
  collected into an **action plan** (`run(state).actions`, `analyze(template).actions`) when its
  subtree is reachable; an unresolved input requirement marks the action `blocked` while its `Need`
  still flows through the normal suspend/resume loop. The pure core never executes an action — a
  conformance test enforces that `src/eval`/`src/run`/`src/analyze`/`src/validate` never import the
  execution layer.
- **`seebo/actions` execution layer.** `executeAction`, `executeActionPlan`, `dryRunAction`,
  `dryRunActionPlan`, `compensateAction`, `compensateActionPlan`, plus the `ActionStatus`,
  `ActionErrorCode`, `ActionEventType`, `PlanStatus` enums and the pure `computeIdempotencyKey` /
  `decideAction` / `checkPermissions` helpers. Features: confirmation, dry-run, deterministic
  idempotency keys (SHA-256 over `{id,type,environment,input}`), retry (with `nonRetryable`),
  per-action permissions/policy (fail-closed), hook-based audit + redaction, and handler-provided
  compensation. Execution APIs return structured `ActionReceipt`s and never throw.
- **`defineAction` / `engine.defineAction`.** Register host action handlers
  (`execute`/`dryRun?`/`compensate?`/`validate?`) in their own namespace, separate from
  capabilities. New config field `actions` and policy field `policy.action`.
- **`analyze`/`validate` integration.** `analyze().actions` lists declared actions (document order,
  best-effort metadata, duplicate flags); `validate` adds `INVALID_ACTION`, `DUPLICATE_ACTION_ID`
  and `UNKNOWN_ACTION_TYPE` and enforces action policy.
- **Docs & CI.** New `docs/ACTIONS.md`; CI now verifies the `seebo/actions` subpath export
  resolves.

### Notes

- Fully **additive and backward-compatible**: existing templates and APIs are unchanged. `action`
  is now a reserved word; results gain an additive `actions` field. New diagnostic `code`s are
  non-breaking under the compatibility policy.

## [0.1.0] — 2026-06-26

First implemented release of **Seebo** (Suspendable Evaluation Engine Built with Opus).
Plain JavaScript + JSDoc, no runtime dependencies, Node ≥ 20.

### Added

- **Pipeline.** Full lexer → parser → `validate`/`analyze` → `run` flow, framed by the
  `expand` (aggregator macros) pre-pass and `finalize` (layout macros) post-pass; async
  confined to `drive`/`stebo`.
- **Type system & evaluation.** Immutable typed values (`int`, `float`, `bool`, `string`,
  `datetime`, `duration`, `object`, `array`), operators incl. temporal arithmetic, transformer
  methods, object/array access, lazy `and`/`or`/`??`/ternary and desugared `match`; suspendable
  `Ok | Susp | Err` evaluator with full re-evaluation and requirement `Need`s.
- **Static analysis.** `validate` reports `UNDECLARED_NAME`, `UNKNOWN_FUNCTION`,
  `UNKNOWN_METHOD`, `ARITY_MISMATCH`, `TYPE_ERROR`, `NON_EXHAUSTIVE_MATCH`,
  `UNKNOWN_CAPABILITY`, and `POLICY_FORBIDDEN` (incl. `allowedTypes`/`allowedFunctions`),
  backed by a conservative static type inferencer. `analyze` computes requirements, graph,
  execution plan, capabilities, static values, determinism, streamability and metrics.
- **Extensibility (`define*`).** Custom types (`defineType`: construction, validation,
  stringify), producers/transformers (`defineFunction`), libraries (`defineLibrary`),
  capabilities (`defineCapability`), and finalize macros (`defineMacro` with `apply`).
  `builtins.{types,functions,macros}` expose the standard vocabulary for `...builtins.all`.
- **Persistence & versioning.** Serializable `PublicState`; `run` migrates older states and
  rejects newer ones with `UNSUPPORTED_STATE_VERSION`.
- **Security & limits.** Configurable limits with diagnostics (`INPUT`/`TOKEN`/`NODE`/
  `NESTING`/`STEP`/`DEPTH`/`OUTPUT_LIMIT_EXCEEDED`, `maxOutputBytes` enforced), runtime
  `CONSTRAINT_VIOLATION`, prototype-pollution protection, trusted/untrusted capability policy
  and per-capability `audit`.
- **Performance.** Benchmark runner (`npm run bench`, `--smoke`) and the opt-in
  `optimizations.astCache` (transparent parse/analyze memoization).
- **Tooling.** ESLint + Prettier + `tsc --noEmit` type-check; GitHub Actions CI (lint,
  format-check, typecheck, test, bench smoke) on Node 20 & 22.
- **Documentation.** README plus `docs/{ARCHITECTURE,API,USAGE,SECURITY,PERFORMANCE,CONFORMANCE}.md`.

### Notes

- Diagnostic `code`s are a stable public contract: never renamed; adding
  new ones is non-breaking.
- Intentionally out of scope for v1: a shipped `fake.*` library, `steboStream` streaming, and
  the `lazyParse`/`stream`/`objectPool` optimizations (accepted but inert).

[unreleased]: https://github.com/BoniFederico/seebo/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/BoniFederico/seebo/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/BoniFederico/seebo/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/BoniFederico/seebo/releases/tag/v0.1.0
