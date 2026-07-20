# Seebo

**Suspendable Evaluation Engine Built with Opus** — a typed, suspendable
expression/template engine with a pure synchronous core.

[![CI](https://github.com/BoniFederico/seebo/actions/workflows/ci.yml/badge.svg)](https://github.com/BoniFederico/seebo/actions/workflows/ci.yml)
[![Docs](https://github.com/BoniFederico/seebo/actions/workflows/docs.yml/badge.svg)](https://github.com/BoniFederico/seebo/actions/workflows/docs.yml)
[![npm](https://img.shields.io/npm/v/seebo)](https://www.npmjs.com/package/seebo)
[![Node](https://img.shields.io/node/v/seebo)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Seebo evaluates a small, strongly-typed expression language embedded in text. Evaluation is
**suspendable**: when a value is missing, the engine does not fail — it yields a typed
**requirement** (a `Need`) and pauses. A host (or the built-in async driver) provides the
value and resumes. The core is **pure and synchronous**; asynchrony is confined to the
driver, so the whole conversation state is serializable and the same code runs on client
and server.

## 📚 Documentation

**Full documentation: <https://bonifederico.github.io/seebo/>**

| Section                                                                                  | Contents                                            |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------- |
| [Getting started](https://bonifederico.github.io/seebo/getting-started/installation/)    | Install, configure an engine, first run.            |
| [Usage & extensibility](https://bonifederico.github.io/seebo/guide/usage/)               | Declarations, `define*` extension points, examples. |
| [Architecture](https://bonifederico.github.io/seebo/architecture/overview/)              | The pipeline, modules, the execution model.         |
| [API reference](https://bonifederico.github.io/seebo/api/overview/)                      | The full public surface and configuration.          |
| [Security](https://bonifederico.github.io/seebo/security/security/)                      | Threat model, limits, capability policy.            |
| [Troubleshooting](https://bonifederico.github.io/seebo/troubleshooting/troubleshooting/) | Symptom → diagnostic-code table, gotchas.           |

The documentation is built from [`docs/`](docs/) with MkDocs Material and published
automatically on every push to `master`.

## Install

```bash
npm install seebo
```

Requires **Node.js ≥ 20**. Zero runtime dependencies, native ESM, no build step.

## Quick start

```js
import { createEngine } from 'seebo';

// Fully-static template → one async orchestration call.
const engine = createEngine({ locale: 'it-IT' });
const res = await engine.stebo({ template: '${ 1 + 2 * 3 }' });
res.status; // 'completed'
res.output; // '7'
```

A missing value suspends evaluation instead of failing:

```js
const engine = createEngine({
  capabilities: { user: () => undefined }, // interactive: resolved by the host
});

let state = engine.run(engine.start("Hello ${ user({ id:'name', type:string() }) }!"));
state.status; // 'waiting'
state.pending.map((r) => r.id); // ['name']

state = engine.run({ ...state, resolved: { ...state.resolved, name: 'World' } });
state.output; // 'Hello World!'
```

More in the [first-run guide](https://bonifederico.github.io/seebo/getting-started/first-run/).

## Tech stack

- **Plain JavaScript + JSDoc** — no TypeScript, no build step; contracts type-checked with
  `tsc --noEmit`.
- **Node ≥ 20, native ESM**, `node:test` for the test suite (no test-framework dependency).
- **Zero runtime dependencies**; dev tooling only (ESLint, Prettier, TypeScript).
- **GitHub Actions** for CI (Node 20/22 matrix), npm releases and the docs site
  (MkDocs Material → GitHub Pages).

## Repository structure

```
src/        # the engine: lexer, parser, ast, runtime, eval, run, validate,
            # analyze, macros, driver, actions, util + public façade (index.js)
test/       # unit + conformance suites (node:test)
bench/      # benchmark runner and fixtures
docs/       # documentation site sources (MkDocs Material)
.github/    # CI, release and docs workflows
mkdocs.yml  # documentation site configuration
```

Details: [project structure](https://bonifederico.github.io/seebo/development/project-structure/).

## Development

```bash
npm install
npm run check   # format:check + lint + typecheck + test (the CI gate)
```

## Contributing

Issues and PRs are welcome — see the
[contributing guide](https://bonifederico.github.io/seebo/contributing/) for setup, coding
conventions, test requirements and the release process.

## License

MIT — see [LICENSE](LICENSE).
