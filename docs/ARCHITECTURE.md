# Architecture

This document describes the Seebo pipeline and the responsibility of each module. It is
the developer-facing companion to the reference specs in
[`docs/initial_docs/spec.md`](initial_docs/spec.md) (language + API) and
[`docs/initial_docs/impl.md`](initial_docs/impl.md) (implementation). Section references
like `SPEC §x.y` / `IMPL §x` point to those documents.

> **Status: working engine core.** Implemented end-to-end: `tokenize`, `parse`, the
> runtime value system, the **suspendable evaluator** (`Ok | Susp | Err` with lazy gating
> and requirement `Need`s), the pure `run` state machine, the **async driver**
> (`drive`/`stebo`) with the four provider outcomes, `stopOn`, policy and limits, and the
> static passes **`validate`** (accumulating diagnostics) and **`analyze`** (requirement
> graph, execution plan, metrics), and the macro passes **`expand`** (aggregators
> `ABSORB`/`MERGE`, pre-pass) and **`finalize`** (layout `REMOVE_*`/`COLLAPSE`, post-pass).
> The full expression grammar evaluates (literals, refs, producers, methods, object/array
> literals, operators incl. temporal arithmetic, ternary, desugared `match`). Still pending:
> libraries (`fake.*`, throw `NotImplementedError`) and a few advanced evaluator features
> exercised by the SPEC §2.7 end-to-end (kept `PENDING`).

## Design principles (SPEC §1.1)

1. **Everything is typed** — values are `{ type, value, format, constraints }`;
   stringification happens only at slot emission.
2. **Pure evaluation** — no side effects; declarations are collected statically.
3. **Not Turing-complete** — bounded inclusion only; every evaluation terminates.
4. **Suspendable evaluation** — a node yields `Value | Need | Error`; a `Need` suspends
   instead of failing.

A guiding architectural rule (IMPL §1): **the core is pure and synchronous; the only
asynchronous component is the driver.** This keeps the state serializable, the logic
testable, and lets the exact same code run on client and server.

## The pipeline

```
 document ──▶ [LEX] ──▶ tokens ──▶ [PARSE] ──▶ AST
                                         │
                ┌────────────────────────┼────────────────────────────┐
                ▼                         ▼                            ▼
           [VALIDATE]                [ANALYZE]                  [RUN] (state machine)
           diagnostics         graph / plan / capabilities     Value | Need | Error
                                                                      │
  pre-pass: [EXPAND aggregators] ──▶ run/driver loop ──▶ post-pass: [FINALIZE layout]
```

- **LEX / PARSE / VALIDATE / ANALYZE / RUN** are pure and synchronous (IMPL §1).
- **EXPAND** (aggregators) and **FINALIZE** (layout) frame the execution.
- **The async DRIVER** sits around `run`, querying capabilities to satisfy `Need`s.

`VALIDATE` and `ANALYZE` are **independent static passes** over the same AST, not a chain:
the host calls `engine.validate(template)` to collect diagnostics and `engine.analyze(template)`
to obtain the `Analysis`. Neither is required by `run` (which re-parses and evaluates
directly); both are wired in `createEngine` and share the static symbol table (IMPL §8).

### `validate` (IMPL §8)

Parses, builds the symbol table, and walks the AST reporting `UNDECLARED_NAME`,
`UNKNOWN_FUNCTION` (unknown producer / un-enabled library), `UNKNOWN_CAPABILITY`,
`POLICY_FORBIDDEN` (capability excluded by `policy.allowedCapabilities`) and
`NON_EXHAUSTIVE_MATCH`. The last relies on a **non-normative marker** the parser attaches
to the outermost ternary of a `match` desugared without a `*` arm (the marker is absent for
exhaustive matches, so their AST is unchanged). `validate` never throws: a malformed
template surfaces as a single `SYNTAX_ERROR` diagnostic.

### `analyze` (IMPL §9)

Consumes the AST + symbol table and computes the `Analysis`: `requirements` (enriched with
derived `phase` and `options`), the `requirementGraph` (edge `A → B` when `B` is declared
under a branch whose condition references `A`), the `executionPlan` (requirements grouped by
phase, where phase = longest dependency path), `capabilitiesUsed`, `staticValues`
(cold-resolvable pure formulas, evaluated with an empty environment), `deterministic`
(false when `now()`/`fake.*` appear — v1 is conservative), `streamability`, `potentialCycles`,
`maxPhases` (capped by `limits.maxPhases`) and `worstCaseRequirements`.

### Macro passes: `expand` (IMPL §10.1) and `finalize` (IMPL §10.2)

Macros live in two phases that **frame** execution, in the canonical order _compose →
resolve → clean up_ (SPEC §2.5). `stebo` chains them:

```
 raw template
      │  (a) EXPAND  ── pre-pass: inline ABSORB/MERGE aggregators
      ▼
 composed template ──▶ [PARSE] ──▶ run/driver loop ──▶ resolved text
                                                              │  (c) FINALIZE ── post-pass:
                                                              ▼     apply REMOVE_*/COLLAPSE
                                                          final output
```

- **`expand({ template, templates }) → composed`** (async signature, IMPL §10.1). Parses
  the source, replaces every aggregator slot by the (recursively expanded) referenced
  template, and copies everything else verbatim — so imported requirements later reach the
  symbol table. `ABSORB('name')` inlines one template; `MERGE('glob', sep?)` concatenates,
  in stable sorted order, the templates whose name matches an **anchored glob** (`*`/`?`
  only — linear-time, no ReDoS). Recursion is bounded by `limits.maxDepth`
  (`DEPTH_EXCEEDED`) and an inclusion chain (`INCLUSION_CYCLE`); both errors are turned by
  `stebo` into a `failed` state (B.5). A missing template inlines as empty.
- **Layout markers in the emitted text.** A layout macro is a **positional marker**. During
  evaluation, `run` emits a layout slot back as its canonical `@{NAME(args)}` source; a
  formula may _also_ produce that literal text (SPEC §2.7's `'@{REMOVE_LINE}'`). Both forms
  are identical to the next pass.
- **`finalize(text) → text`** (sync, pure, IMPL §10.2). Scans the resolved text for the
  recognized layout markers and applies them **left-to-right, recomputing offsets** after
  each edit: `REMOVE_LINE` drops the marker's line, `REMOVE_LEFT(n)`/`REMOVE_RIGHT(n)` drop
  the marker plus _n_ neighbouring chars, `COLLAPSE` removes itself and collapses runs of
  blank lines. Any unrecognized `@{…}` is left untouched, so arbitrary user data is never
  misinterpreted. No `eval`; deterministic.

> **v1 scope.** `validate`/`analyze` currently run on the **raw** template (they do not
> expand aggregators first), so requirements imported via `ABSORB`/`MERGE` are not yet seen
> by the static passes — a known limitation to lift once `expand` feeds the symbol table.

### Extensibility: the registry (SPEC §2.6)

`createEngine` builds one immutable [`Registry`](../src/runtime/registry.js) from the config's
`types`/`functions`/`macros`/`libraries`/`capabilities` and stores it on the normalized config.
It is the single read-only source of custom vocabulary, consulted by:

- the **parser** — library namespaces (enables `Namespace` nodes) and custom macro families;
- the **evaluator** — custom producers (`name(...)`), transformers (`recv.name(...)`, only
  when no builtin matches) and library functions (`ns.fn(...)`). Extension `eval` runs over
  **plain JS values** and its result is re-wrapped via `fromJs`, so extensions never touch
  internal `Value`s and cannot inject untyped data;
- the **driver** — the registered capability set, plus the trust policy (`policy.trustLevel`
  vs `capabilityRules[cap].allowFrom`) checked **before** a provider runs.

**Name governance** (SPEC §1.5) happens while building the registry: every introduced name is
checked against the reserved words (`RESERVED_NAME`) and for uniqueness in its namespace
(`NAME_CONFLICT`) — producers/types/libraries/capabilities share one namespace, macros another,
transformers are keyed per receiver type. A violation throws `EngineConfigError` at
`createEngine`. The `define*` factories return frozen descriptors; see
[`USAGE.md`](USAGE.md) for examples.

## Module responsibilities

Each module is organized as **named contract file(s)** (the source of truth for shapes
and signatures) plus an `index.js` **barrel** that re-exports them.

| Module          | Contract file(s)           | Responsibility                                                               | Spec             |
| --------------- | -------------------------- | ---------------------------------------------------------------------------- | ---------------- |
| `src/lexer/`    | `tokens.js` + `lexer.js`   | `Token`/`TokenType`/`Position`; `tokenize(input, options?)` (error-tolerant) | IMPL §2          |
| `src/ast/`      | `nodes.js`                 | `Document` and node/`Expr` shapes (incl. `ObjectLit`/`ArrayLit`)             | IMPL §3.1        |
| `src/parser/`   | `parser.js`                | recursive descent + Pratt; `parse(tokens, options?)`; `PRECEDENCE`           | IMPL §3          |
| `src/runtime/`  | `values.js`, `registry.js` | `Value` model + the extension `Registry` (custom vocab, name governance)     | IMPL §4, §3      |
| `src/eval/`     | `evaluator.js`             | suspendable evaluator `Ok \| Susp \| Err`; `RequirementDescriptor`           | IMPL §5          |
| `src/run/`      | `run.js`                   | pure state machine: `PublicState`, `RuntimeState`, `start`/`run`             | IMPL §6          |
| `src/validate/` | `validate.js`              | static diagnostics (undeclared names, arity, types, capabilities)            | IMPL §8          |
| `src/analyze/`  | `analyze.js`               | `Analysis`: requirement graph, plan, metrics, `streamability`                | IMPL §9          |
| `src/macros/`   | `expand.js`, `finalize.js` | EXPAND aggregators (pre-pass) and FINALIZE layout (post-pass)                | IMPL §10         |
| `src/driver/`   | `async_driver.js`          | the only async layer; `ProviderOutcome`, `drive`, `stebo`                    | IMPL §7          |
| `src/util/`     | `errors.js`, `versions.js` | `Diagnostic`/`DiagnosticCode`, error classes, contract versions              | IMPL App. A, §15 |
| `src/index.js`  | —                          | public API: `createEngine`, `builtins`, `define*`, config defaults           | SPEC §2.2/§2.6   |

## Public contracts and versioning (SPEC §2.1, IMPL §15)

Three independently-versioned contracts cross the engine↔application boundary:

- `astVersion` — the AST shape (`src/ast/nodes.js`).
- `stateVersion` — the `PublicState` shape (`src/run/run.js`).
- `analysisVersion` — the `Analysis` shape (`src/analyze/analyze.js`).

All start at `1` (clarifications §11). State migrators (`src/util/versions.js#migrations`)
are an empty, future-ready list in v1.

## Execution model (the conversation)

```
Created ──▶ Running ──▶ Waiting(Need…) ──▶ Running ──▶ … ──▶ Completed   (or ──▶ Failed)
```

- `run(state) → state` evaluates as far as possible using only `state.resolved`, then
  collects the active `Need`s into `pending`. Pure, synchronous (IMPL §6.2).
- The **driver** satisfies `Need`s via capabilities and re-runs. Capabilities returning
  `undefined` mean "not me" (`Unresolved`); those listed in `stopOn` are returned to the
  caller (e.g. interactive `user`). See `ProviderOutcome` (IMPL §7.1).
- v1 resumes by **full re-evaluation** (strategy 1, IMPL §6.4); continuations/checkpoints
  are optional future optimizations and are intentionally absent.

## v1 scope notes (clarifications)

- No streaming exposed; `optimizations.stream` is accepted but inert.
- All optimizations off by default; `lazyParse`/`astCache`/`stream`/`objectPool` not
  implemented.
- No external runtime dependencies. `fake.*` is only an example via `defineLibrary`.
- `date(pattern, text)` uses an internal mini parser/formatter over a normative token
  subset (`YYYY MM DD HH mm ss Z`).

## Positions (normative contract)

`Position` (`src/lexer/tokens.js`) is normatively **offset-based**: `{ start, end }`,
matching IMPL §2 and Appendix A.

> **Only `start`/`end` offsets are normative. `line`/`column` metadata is optional,
> derived from offsets, and provided solely for diagnostics/editor convenience.**

`start`/`end` are absolute offsets into the template source and are the only position
fields required by tokens, AST nodes, diagnostics, internal source maps and the
conformance tests. The optional `line`/`column` fields (v1 decision):

- MUST always be derivable from `start`/`end`;
- MUST NOT be required by normative tests;
- MUST NOT be used for semantic logic, parsing, validation or AST comparison;
- are NOT a stable compatibility surface and may be absent.

If an editor-friendly mode is needed later, prefer a separate utility such as
`enrichPositionsWithLineColumn(source, astOrTokens)` over depending on these fields.
