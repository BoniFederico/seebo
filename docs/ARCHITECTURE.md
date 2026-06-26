# Architecture

This document describes the Seebo pipeline and the responsibility of each module. It is
the developer-facing companion to the reference specs in
[`docs/initial_docs/spec.md`](initial_docs/spec.md) (language + API) and
[`docs/initial_docs/impl.md`](initial_docs/impl.md) (implementation). Section references
like `SPEC §x.y` / `IMPL §x` point to those documents.

> **Status: working engine core.** Implemented end-to-end: `tokenize`, `parse`, the
> runtime value system, the **suspendable evaluator** (`Ok | Susp | Err` with lazy gating
> and requirement `Need`s), the pure `run` state machine, and the **async driver**
> (`drive`/`stebo`) with the four provider outcomes, `stopOn`, policy and limits.
> The full expression grammar evaluates (literals, refs, producers, methods,
> object/array literals, operators incl. temporal arithmetic, ternary, desugared `match`).
> Still pending: `validate` and `analyze` (static passes), macro `expand`/`finalize`
> (pre/post passes, currently pass-through), and libraries (`fake.*`) — these throw
> `NotImplementedError` or are skipped in evaluation, and their conformance tests remain
> `PENDING`.

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

## Module responsibilities

Each module is organized as **named contract file(s)** (the source of truth for shapes
and signatures) plus an `index.js` **barrel** that re-exports them.

| Module          | Contract file(s)           | Responsibility                                                               | Spec             |
| --------------- | -------------------------- | ---------------------------------------------------------------------------- | ---------------- |
| `src/lexer/`    | `tokens.js` + `lexer.js`   | `Token`/`TokenType`/`Position`; `tokenize(input, options?)` (error-tolerant) | IMPL §2          |
| `src/ast/`      | `nodes.js`                 | `Document` and node/`Expr` shapes (incl. `ObjectLit`/`ArrayLit`)             | IMPL §3.1        |
| `src/parser/`   | `parser.js`                | recursive descent + Pratt; `parse(tokens, options?)`; `PRECEDENCE`           | IMPL §3          |
| `src/runtime/`  | `values.js`                | `Value` model, type/format/constraints shapes, builders                      | IMPL §4          |
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
