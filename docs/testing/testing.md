# Testing & conformance

Seebo's behaviour is pinned by an executable test suite: component tests nail down each
module's contract, and conformance tests restate the engine's reference specification
(kept in the repository's
[`spec/`](https://github.com/BoniFederico/seebo/tree/master/spec) folder) as runnable
cases. An implementation is **conformant** if it reproduces those behaviours.

## How to run

```bash
npm test                  # the whole suite (node:test runner, no external deps)
npm run test:unit         # component tests only        (test/unit/**)
npm run test:conformance  # specification-driven tests   (test/conformance/**)
npm run test:watch        # watch mode
```

The suite runs on Node's built-in `node:test`; there is no test framework dependency. It
must pass with **no skipped and no todo tests** — every case is executable.

## Two layers of tests

- **`test/unit/`** — component-level tests that pin the contract of each module in
  isolation (lexer, parser, AST, values, evaluator, validate, analyze, macros, registry,
  cache, the public API surface). These are where edge cases and internal invariants are
  nailed down.
- **`test/conformance/`** — end-to-end cases derived directly from the reference
  specification. Each test documents, in a comment, the **spec section it comes from**,
  the **input**, and the **expected output or error code**, so a test reads as an
  executable restatement of the specification.

Shared harness in `test/helpers/`:

- `pipeline.js` — `realEngine(overrides?)` (the actual `createEngine`) and
  `createFakeEngine()` (a tiny deterministic fake used only by the end-to-end smoke, to
  prove the harness itself runs). The fake is **not** Seebo semantics.
- `expect.js` — assertion helpers: `codesOf`, `assertCodes` (exact set,
  order-insensitive), `assertHasCode`, `stripPositions` (compare ASTs ignoring offsets),
  `normalizeOutput`.

## What each conformance file covers

| File                        | Covered area                                                         |
| --------------------------- | -------------------------------------------------------------------- |
| `tokenize.test.js`          | Lexing: slots, sigils, error tolerance.                              |
| `parse.test.js`             | Grammar, precedence, `match` desugaring, syntax errors.              |
| `minimal_slice.test.js`     | The smallest end-to-end vertical slice through the pipeline.         |
| `expressions.test.js`       | Operators, precedence, type rules, transformer methods.              |
| `analyze.test.js`           | Requirement graph, phases, execution plan, metrics.                  |
| `errors.test.js`            | Validity & error codes — static and runtime.                         |
| `limits.test.js`            | Resource limits, output size, state versioning.                      |
| `extensions.test.js`        | `define*` extensibility and name governance.                         |
| `suspension_driver.test.js` | The conversation loop, capabilities, policy, audit.                  |
| `dynamic_args.test.js`      | Capability `args` depending on other bindings (phased resolution).   |
| `actions.test.js`           | Action declaration, planning, execution layer, policy, compensation. |
| `end_to_end.test.js`        | The specification's worked end-to-end example + the harness smoke.   |
| `appendix-b.test.js`        | The specification's normative borderline cases (coverage map below). |

## Borderline-case coverage map

The reference specification catalogues a set of normative borderline cases;
`appendix-b.test.js` carries the map and hosts the cases not naturally covered elsewhere:

| Case | Topic                                         | Where                |
| ---- | --------------------------------------------- | -------------------- |
| B.1  | Nested-branch phase computation               | `analyze.test.js`    |
| B.2  | A `Need` in a non-taken branch is not emitted | `appendix-b.test.js` |
| B.3  | Non-exhaustive `match`                        | `errors.test.js`     |
| B.4  | Unknown capability                            | `errors.test.js`     |
| B.5  | Inclusion cycle                               | `errors.test.js`     |
| B.6  | Adjacent layout macros / removal              | `appendix-b.test.js` |

## Diagnostic codes are the contract

Diagnostic `code` values are a **stable public contract**: they are never renamed (adding
new ones is non-breaking). Conformance tests assert on `code`, never on `message` (which
is human-readable and may be localized/redacted). The error-surfacing rule is also tested:
structural problems surface statically (in `validate`/`parse`), while value-dependent
problems surface in `run`/`driver`. See
[Troubleshooting](../troubleshooting/troubleshooting.md#common-errors) for the full
symptom→code→phase table.

## Determinism

Conformance relies on determinism: non-deterministic producers (`now()`) read an injected
`clock`, so tests fix it (the worked end-to-end example uses a frozen clock) and obtain
byte-stable output. Outputs are compared exactly, with `normalizeOutput` guarding only
against incidental trailing-whitespace/newline noise.

## Known v1 scope (not failures)

The suite does **not** test features intentionally out of scope for v1 (so the docs and
tests agree on what exists):

- a shipped built-in `fake.*` library (only `defineLibrary` is provided);
- streaming output (`steboStream`);
- the `lazyParse` / `stream` / `objectPool` optimizations (accepted but inert; only
  `astCache` is implemented and is covered in `test/unit/cache.test.js`);
- static analysis across `ABSORB`/`MERGE` inclusion (`validate`/`analyze` run on the raw
  template; the cycle itself is still caught at `expand`/`run`).

## Writing a new test

1. Decide the layer: an internal invariant or edge case goes in `test/unit/`; an
   externally observable behaviour goes in `test/conformance/`.
2. Use the real engine via `realEngine(overrides?)` from `test/helpers/` unless you are
   testing a module in isolation.
3. Assert on **diagnostic codes and outputs**, never on messages or `line`/`column`
   metadata (only `start`/`end` offsets are contractual).
4. For a conformance test, add a comment citing the specification section the case
   restates, with input and expected outcome.
