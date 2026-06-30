# Seebo

**Suspendable Evaluation Engine Built with Opus** — a suspendable evaluation engine in which
template rendering is one of the possible applications.

Seebo evaluates a small, strongly-typed expression language embedded in text. Evaluation is
**suspendable**: when a value is missing, the engine does not fail — it yields a typed
**requirement** (a `Need`) and pauses. A host (or the built-in async driver) provides the
value and resumes. The core is **pure and synchronous**; asynchrony is confined to the driver,
so the whole conversation state is serializable and the same code runs on client and server.

- **Status: v1 implemented.** The full pipeline works: lexer → parser → `validate`/`analyze` →
  `run`, framed by the `expand` (aggregator macros) pre-pass and `finalize` (layout macros)
  post-pass.
- **Plain JavaScript + JSDoc.** No TypeScript, no build step, **no runtime dependencies**.
- Reference specs: [`docs/initial_docs/spec.md`](docs/initial_docs/spec.md) (language + API)
  and [`docs/initial_docs/impl.md`](docs/initial_docs/impl.md) (implementation).

## Overview

A template is text with three kinds of slots (delimiters are configurable, SPEC §1.2):

| Slot    | Syntax         | Meaning                                            |
| ------- | -------------- | -------------------------------------------------- |
| Formula | `${ expr }`    | Evaluated and stringified at emission.             |
| Comment | `#{ ... }`     | Removed from the output.                           |
| Macro   | `@{ NAME(…) }` | Aggregator (pre-pass) or layout (post-pass) macro. |

Everything is typed (`int`, `float`, `bool`, `string`, `datetime`, `duration`, `object`,
`array`); stringification happens only at slot emission, driven by each value's `format` and
`constraints`. Missing data declared via `need(...)` / capability sugar becomes a `Need`
that suspends evaluation instead of throwing.

A name is introduced with `bind(name, descriptor)` and read **plain** by name afterwards
(`${ name }`). The descriptor's nature is its kind: a type-builder (a pure value), `need(...)`
(missing data), or `action(...)` (an effect). A capability can declare its own contract
(`type`/`constraints`) so `need('cap')` inherits it, and a capability `args` value may depend on
another binding (resolved first, in phases). See [`docs/USAGE.md`](docs/USAGE.md).

A template can also declare external **effects** with `action({...})` (SPEC §2.8). The pure core
only _prepares_ an action plan (`run(state).actions`); execution is explicit and host-driven via
the `seebo/actions` subpath — `import { executeActionPlan } from 'seebo/actions'`. See
[`docs/ACTIONS.md`](docs/ACTIONS.md).

## Requirements

- **Node.js ≥ 20** (uses `node:test` and native ESM).
- **No runtime dependencies.** Dev dependencies cover tooling only: ESLint (lint), Prettier
  (format) and TypeScript (JSDoc type-check, no build).

## Install

```bash
npm install seebo
```

From a clone, install dev tooling with `npm install`.

## Quickstart

```js
import { createEngine, builtins } from 'seebo';

const engine = createEngine({
  ...builtins.all, // explicit standard vocabulary (optional; always available)
  locale: 'it-IT',
});

// Fully-static template → one async orchestration call.
const res = await engine.stebo({ template: '${ 1 + 2 * 3 }' });
res.status; // 'completed'
res.output; // '7'
```

### Suspension (a missing value becomes a requirement)

```js
const engine = createEngine({
  capabilities: {
    // A capability resolves a `need`; returning undefined means "not me".
    user: () => undefined,
  },
});

let state = engine.start("Hello ${ user({ id:'name', type:string() }) }!");
state = engine.run(state); // pure, synchronous
state.status; // 'waiting'
state.pending.map((r) => r.id); // ['name']

// Provide the value (as a host or an external resolver would) and resume.
state = engine.run({ ...state, resolved: { ...state.resolved, name: 'World' } });
state.status; // 'completed'
state.output; // 'Hello World!'
```

### Capabilities as producers (the `need` sugar)

```js
const engine = createEngine({
  locale: 'it-IT',
  capabilities: {
    crm: (req) => ({ order: { id: 42, total: 1234.5 } })[req.id],
  },
});

const res = await engine.stebo({
  template:
    "Order ${ crm({ id:'order', type:object() }).id } — " +
    '${ float(order.total).constraints({ precision: 2 }) } €',
});
res.output; // 'Order 42 — 1234,50 €'
```

## Examples

A few language features (see [`docs/USAGE.md`](docs/USAGE.md) for realistic, end-to-end ones):

```js
const out = async (t, config) => (await createEngine(config).stebo({ template: t })).output;

await out('${ array([3,1,2]).min() }'); // '1'
await out('${ duration(50 * 3600).totalHours() }'); // '50'
await out("${ datetime('2026-06-20').truncate('month').day() }"); // '1'
await out("${ 2 match { 1 => 'one', 2 => 'two', * => '?' } }"); // 'two'
await out("${ '' ?? 'fallback' }"); // 'fallback'  (0/false are NOT empty)
```

## CLI

Seebo is a **library**; it ships no CLI binary. The only executable script is the development
benchmark:

```bash
npm run bench         # full benchmark (timings)
npm run bench:gc      # timings + heap allocation estimate (node --expose-gc)
npm run bench:smoke   # tiny, fast run (used by CI to verify the bench still runs)
```

## Limits

Every phase is bounded by configurable limits (override via `createEngine({ limits })`); a
breach fails with a specific diagnostic code. Defaults:

| Limit             | Default   | Phase  | Code                     |
| ----------------- | --------- | ------ | ------------------------ |
| `maxInputBytes`   | 1 000 000 | parse  | `INPUT_LIMIT_EXCEEDED`   |
| `maxTokens`       | 100 000   | parse  | `TOKEN_LIMIT_EXCEEDED`   |
| `maxNodes`        | 50 000    | parse  | `NODE_LIMIT_EXCEEDED`    |
| `maxNestingDepth` | 200       | parse  | `NESTING_LIMIT_EXCEEDED` |
| `maxSteps`        | 1 000 000 | run    | `STEP_LIMIT_EXCEEDED`    |
| `maxOutputBytes`  | 1 000 000 | run    | `OUTPUT_LIMIT_EXCEEDED`  |
| `maxDepth`        | 20        | expand | `DEPTH_EXCEEDED`         |
| `maxPhases`       | 10        | driver | `MAX_PHASES_EXCEEDED`    |
| `timeoutMs`       | 2000      | driver | `TIMEOUT`                |

See [`docs/SECURITY.md`](docs/SECURITY.md) for the threat model and policy controls.

## Documentation

- [`docs/USAGE.md`](docs/USAGE.md) — usage, extensibility, realistic examples, common errors, debugging.
- [`docs/API.md`](docs/API.md) — the public API surface (engine methods, `define*`, config, constants).
- [`docs/ACTIONS.md`](docs/ACTIONS.md) — the `action(...)` effect construct and the `seebo/actions` execution layer.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the pipeline and module responsibilities.
- [`docs/SECURITY.md`](docs/SECURITY.md) — threat model, limits, capability policy.
- [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md) — benchmarks and the opt-in `astCache`.
- [`docs/CONFORMANCE.md`](docs/CONFORMANCE.md) — how the test suite maps to SPEC/IMPL.
- [`docs/CHANGELOG.md`](docs/CHANGELOG.md) — release notes.

## Development

```bash
npm test              # all tests (node:test)
npm run test:unit         # component tests only
npm run test:conformance  # SPEC/IMPL-driven end-to-end tests only
npm run lint          # ESLint
npm run format:check  # Prettier (verify)
npm run typecheck     # tsc --noEmit (validate JSDoc contracts; no TS output)
```

## Project structure

```
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
  util/      # errors, versions, limits, builtin vocabulary
  index.js   # public façade: createEngine, builtins, define*
test/        # unit + conformance
bench/       # benchmark (timings + allocations)
docs/        # ARCHITECTURE, USAGE, API, SECURITY, PERFORMANCE, CONFORMANCE, initial_docs
```

## License

MIT — see [LICENSE](LICENSE).
