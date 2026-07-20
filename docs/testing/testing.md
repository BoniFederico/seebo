# Testing & conformance

How the test suite relates to the reference specification. Seebo's behaviour is defined by
[`spec.md`](../reference/spec.md) (language + API) and
[`impl.md`](../reference/impl.md) (implementation, including **Appendix A** —
the normative diagnostic codes — and **Appendix B** — normative borderline cases). An
implementation is **conformant** if it reproduces those behaviours.

## How to run

```bash
npm test                  # the whole suite (node:test runner, no external deps)
npm run test:unit         # component tests only        (test/unit/**)
npm run test:conformance  # SPEC/IMPL-driven tests only  (test/conformance/**)
npm run test:watch        # watch mode
```

The suite runs on Node's built-in `node:test`; there is no test framework dependency. It must
pass with **no skipped and no `todo` tests** — every case is executable.

## Two layers of tests

- **`test/unit/`** — component-level tests that pin the contract of each module in isolation
  (lexer, parser, AST, values, evaluator, validate, analyze, macros, registry, cache, the
  public API surface). These are where edge cases and internal invariants are nailed down.
- **`test/conformance/`** — end-to-end cases derived directly from SPEC/IMPL. Each test
  documents, in a comment, the **section it comes from**, the **input**, and the **expected
  output or error code**, so a test reads as an executable restatement of the spec.

Shared harness in `test/helpers/`:

- `pipeline.js` — `realEngine(overrides?)` (the actual `createEngine`) and `createFakeEngine()`
  (a tiny deterministic fake used only by the end-to-end smoke, to prove the harness itself
  runs). The fake is **not** Seebo semantics.
- `expect.js` — assertion helpers: `codesOf`, `assertCodes` (exact set, order-insensitive),
  `assertHasCode`, `stripPositions` (compare ASTs ignoring offsets), `normalizeOutput`.

## What each conformance file covers

| File                        | Spec/impl area                                                             |
| --------------------------- | -------------------------------------------------------------------------- |
| `tokenize.test.js`          | Lexing: slots, sigils, error tolerance (IMPL §2, SPEC §1.2).               |
| `parse.test.js`             | Grammar, precedence, `match` desugaring, syntax errors (IMPL §3).          |
| `minimal_slice.test.js`     | The smallest end-to-end vertical slice through the pipeline.               |
| `expressions.test.js`       | Operators, precedence, type rules, transformer methods (SPEC §1.4/§1.5).   |
| `analyze.test.js`           | Requirement graph, phases, plan, metrics (SPEC §2.3, IMPL §9; B.1).        |
| `errors.test.js`            | Validity & error codes — static and runtime (SPEC §1.10; B.3/B.4/B.5).     |
| `limits.test.js`            | Resource limits, output size, state versioning (SPEC §1.11, IMPL §13/§14). |
| `extensions.test.js`        | `define*` extensibility and name governance (SPEC §2.6).                   |
| `suspension_driver.test.js` | The conversation loop, capabilities, policy, audit (SPEC §2.4, IMPL §7).   |
| `end_to_end.test.js`        | The SPEC §2.7 worked example + the harness smoke.                          |
| `appendix-b.test.js`        | IMPL Appendix B normative cases (coverage map below).                      |

## Appendix B coverage map

Appendix B's borderline cases are grouped across the conformance files; `appendix-b.test.js`
carries the map and the cases not naturally hosted elsewhere:

| Case | Topic                                         | Where                |
| ---- | --------------------------------------------- | -------------------- |
| B.1  | Nested-branch phase computation               | `analyze.test.js`    |
| B.2  | A `Need` in a non-taken branch is not emitted | `appendix-b.test.js` |
| B.3  | Non-exhaustive `match`                        | `errors.test.js`     |
| B.4  | Unknown capability                            | `errors.test.js`     |
| B.5  | Inclusion cycle                               | `errors.test.js`     |
| B.6  | Adjacent layout macros / removal              | `appendix-b.test.js` |

## Diagnostic codes (Appendix A)

Diagnostic `code` values are a **stable public contract**: they are never renamed (adding new
ones is non-breaking, IMPL §14). Conformance tests assert on `code`, never on `message`
(which is human-readable and may be localized/redacted). The error-surfacing rule is also
tested: structural problems surface statically (in `validate`/`parse`), while value-dependent
problems surface in `run`/`driver`. See [Troubleshooting](../troubleshooting/troubleshooting.md#common-errors)
for the full symptom→code→phase table.

## Determinism

Conformance relies on determinism (SPEC §1.11): non-deterministic producers (`now()`) read an
injected `clock`, so tests fix it (e.g. the §2.7 example uses a frozen clock) and obtain
byte-stable output. Outputs are compared exactly, with `normalizeOutput` guarding only against
incidental trailing-whitespace/newline noise.

## Known v1 scope (not failures)

The suite does **not** test features intentionally out of scope for v1 (so the docs and tests
agree on what exists):

- a shipped built-in `fake.*` library (only `defineLibrary` is provided);
- streaming output (`steboStream`);
- the `lazyParse` / `stream` / `objectPool` optimizations (accepted but inert; only `astCache`
  is implemented and is covered in `test/unit/cache.test.js`);
- static analysis across `ABSORB`/`MERGE` inclusion (`validate`/`analyze` run on the raw
  template; the cycle itself is still caught at `expand`/`run`).
