# Project structure

Seebo is a single npm package with no build step: the published artifact is the `src/`
tree itself (`"files": ["src"]`).

```text
src/
  lexer/     # tokenization (IMPL §2)
  parser/    # recursive descent + Pratt (IMPL §3)
  ast/       # versioned AST + node factories (IMPL §3.1)
  runtime/   # runtime type system + extension registry (IMPL §4, §3)
  eval/      # suspendable evaluator Ok|Susp|Err (IMPL §5)
  run/       # pure state machine: start/run (IMPL §6)
  validate/  # static diagnostics + type inferencer (IMPL §8)
  analyze/   # graph / plan / metrics / streamability (IMPL §9)
  macros/    # expand (aggregators) + finalize (layout) (IMPL §10)
  driver/    # async driver + stebo (IMPL §7)
  actions/   # action contracts + planning (core-safe) + execution layer (seebo/actions)
  util/      # errors, versions, limits, builtin vocabulary
  index.js   # public façade: createEngine, builtins, define*
test/        # unit + conformance (node:test)
bench/       # benchmark (timings + allocations)
docs/        # this documentation site (MkDocs Material)
.github/     # CI, release and docs workflows
```

## Module convention

Each module is organized as **named contract file(s)** — the source of truth for shapes and
signatures — plus an `index.js` **barrel** that re-exports them. For example, `src/run/`
contains `run.js` (the `PublicState`/`RuntimeState` contracts and `start`/`run`) and an
`index.js` that re-exports it. The full module → contract-file → responsibility map is in
the [architecture overview](../architecture/overview.md#module-responsibilities).

Two structural rules are enforced by tests:

- the **pure core** (`src/eval`, `src/run`, `src/analyze`, `src/validate`) never imports the
  action execution layer (`src/actions/execute.js`);
- the package `exports` map (`seebo`, `seebo/actions`) must resolve — CI imports both.

## Entry points

| Path                   | Exposed as        | Contents                                         |
| ---------------------- | ----------------- | ------------------------------------------------ |
| `src/index.js`         | `'seebo'`         | `createEngine`, `builtins`, `define*`, constants |
| `src/actions/index.js` | `'seebo/actions'` | `executeActionPlan`, `dryRunAction`, enums, …    |

## Tests and benchmarks

- `test/unit/` — component tests pinning each module's contract in isolation.
- `test/conformance/` — end-to-end tests derived directly from SPEC/IMPL; each case cites
  the section it restates. See [Testing & conformance](../testing/testing.md).
- `test/helpers/` — the shared harness (`realEngine`, assertion helpers).
- `bench/` — the warmed-up benchmark runner and fixtures. See
  [Performance](../guide/performance.md).

## npm scripts

| Script                     | What it does                                                                      |
| -------------------------- | --------------------------------------------------------------------------------- |
| `npm test`                 | All tests (`node --test`).                                                        |
| `npm run test:unit`        | Component tests only (`test/unit/**`).                                            |
| `npm run test:conformance` | SPEC/IMPL-driven end-to-end tests (`test/conformance/**`).                        |
| `npm run lint`             | ESLint.                                                                           |
| `npm run format:check`     | Prettier (verify; `format` writes).                                               |
| `npm run typecheck`        | `tsc --noEmit` — validates JSDoc contracts, no output.                            |
| `npm run bench`            | Full benchmark (`bench:gc` adds heap estimate; `bench:smoke` is the CI-fast run). |
| `npm run check`            | format:check + lint + typecheck + test (the CI gate).                             |

## Documentation

The documentation you are reading lives in `docs/` and is built with
[MkDocs Material](https://squidfunk.github.io/mkdocs-material/); `mkdocs.yml` at the repo
root defines the navigation. Every push to `master` rebuilds and publishes the site via
GitHub Actions — see [Deployment](../deployment/deployment.md#documentation-site). To
preview locally:

```bash
pip install -r requirements.txt
mkdocs serve   # http://127.0.0.1:8000, live-reload
```
