# Testing an Engine: Conformance, Unit Tests, and Edge Cases

## Table of Contents

1. [Why Testing an Engine Is Different](#1-why-testing-an-engine-is-different)
2. [Specification-Driven Testing](#2-specification-driven-testing)
3. [The Test Taxonomy](#3-the-test-taxonomy)
4. [The Two-Layer Directory Structure](#4-the-two-layer-directory-structure)
5. [Node's Built-In Test Runner](#5-nodes-built-in-test-runner)
6. [Testing the Lexer](#6-testing-the-lexer)
7. [Testing the Parser](#7-testing-the-parser)
8. [Testing the Evaluator](#8-testing-the-evaluator)
9. [Testing Static Analysis](#9-testing-static-analysis)
10. [Testing the Driver](#10-testing-the-driver)
11. [Testing Macros](#11-testing-macros)
12. [Testing Security Properties](#12-testing-security-properties)
13. [Appendix B: Normative Borderline Cases](#13-appendix-b-normative-borderline-cases)
14. [The No-Skip Invariant](#14-the-no-skip-invariant)
15. [Subtle Bugs in Parser and Evaluator](#15-subtle-bugs-in-parser-and-evaluator)
16. [Property-Based Testing as a Future Direction](#16-property-based-testing-as-a-future-direction)
17. [Conclusion](#conclusion)
18. [Further Reading](#further-reading)

---

## 1. Why Testing an Engine Is Different

Testing application code is largely about business logic: does the system accept the right inputs, reject the wrong ones, and produce the expected outputs given various scenarios? The number of scenarios is bounded by the number of business rules. Edge cases tend to emerge from user behavior, not from mathematical properties of the language itself.

Testing a language engine is fundamentally different. The subject under test is a collection of formal rules — precedence, type promotion, lazy evaluation, suspension semantics — and the edge cases emerge from the combinatorial interactions of those rules. An arithmetic expression with three operators has six ways to parenthesize it, and each parenthesization is a test case. A boolean short-circuit expression with a suspended requirement on the right side might behave one way when the left is true and another when it is false, and the correct behavior is determined by the specification, not by intuition. A macro that removes a line from the template must handle the case where that line contains another macro that was already processed, or one that has not been processed yet.

This combinatorial character means the test suite for a language engine is never exhaustively complete. There is always another combination. What you can achieve is a suite that covers every specified behavior exactly once, plus a set of regression tests for edge cases that have been explicitly specified because they were once ambiguous or surprising.

Seebo addresses this with a test strategy that is explicitly specification-driven: tests are organized by the section of the specification they cover, borderline behaviors are collected in a normative appendix, and the test suite is treated as a conformance checklist rather than a coverage metric.

---

## 2. Specification-Driven Testing

Seebo's development followed a specification-first methodology. The `SPEC.md` and `IMPL.md` documents were written before any implementation code. Every test was written against the specification, not against the implementation.

This discipline has a concrete payoff: when a test fails, the failure tells you whether the implementation diverges from the specification. When a test passes, you know the implementation conforms to that specification section. The test is a machine-checkable projection of a human-written requirement.

The consequence is visible in the test files. Every test in `test/conformance/` carries a comment identifying the SPEC or IMPL section it covers. For example:

```js
// SPEC §1.4 — arithmetic precedence: `*` binds tighter than `+`.
// Input: 1 + 2 * 3   Expected: "7"   (ACTIVE: implemented by the v1 slice)
test('SPEC §1.4 — arithmetic precedence (1 + 2 * 3 = 7)', async () => {
  assert.equal(await renderExpr('1 + 2 * 3'), '7');
});
```

The test name is not just a description; it is a citation. A reader looking at a test failure can immediately locate the relevant specification section without grepping the codebase. A reader auditing the specification can check each normative statement against the test suite to verify coverage.

This approach also makes the distinction between specification gaps and implementation bugs clear. If a behavior is not tested, it may be because no specification section covers it. That is a specification gap, and the correct fix is to add a specification entry and a corresponding test, not to add a test that guesses at the intended behavior.

---

## 3. The Test Taxonomy

Seebo uses four categories of tests, each serving a distinct purpose.

**Unit tests** isolate individual components: the lexer, the parser, the evaluator, the value system, the registry, the cache. A unit test constructs a minimal scenario for one function and asserts on the output. Unit tests run fast, identify failures precisely, and require no integration between components.

**Conformance tests** are end-to-end per specification section. They take a template string, run it through the full pipeline (or a specified sub-pipeline), and assert on the final state. Conformance tests verify integration between components and verify that the system as a whole conforms to the specification. They are slower than unit tests but more reliable for catching regressions that cross component boundaries.

**Golden tests** are conformance tests with exact output matching. A golden test says: given this specific template and these specific values, the output must be exactly this string. The name comes from the practice of storing expected output in "golden files" that are compared against actual output. Seebo's golden tests are inline — expected strings are embedded in the test code — which makes them readable but requires updating them when intentional changes are made to formatting behavior.

**Security tests** verify resource limits, prototype-pollution defenses, and policy enforcement. These tests deliberately exceed limits, inject `__proto__` keys, and configure forbidden capabilities. They are conformance tests specialized to the security section of the implementation specification (IMPL §13).

**Regression tests** cover edge cases that were once ambiguous or surprising and have been given explicit normative treatment in Appendix B of the implementation specification. A regression test says: this specific behavior was once unclear or incorrect, and we now have a specification for it. Do not break this.

---

## 4. The Two-Layer Directory Structure

Tests are organized into two directories: `test/unit/` and `test/conformance/`.

The unit directory contains tests that exercise individual modules in isolation:

```
test/unit/
  lexer.test.js     — tokenize() with every token kind and edge case
  parser.test.js    — parse() with every node kind, precedence, and error case
  values.test.js    — every make* factory, fromJs, equals, compare, serialize
  eval.test.js      — evaluate() and evaluateDocument() outcomes
  analyze.test.js   — analyze() shapes and graph structures
  macros.test.js    — expand and finalize in isolation
  registry.test.js  — defineType, defineFunction, defineCapability wiring
  cache.test.js     — astCache transparency (cached = uncached results)
  api.test.js       — the engine facade (createEngine and all its methods)
  validate.test.js  — validate() diagnostic codes and recoverable markers
```

The conformance directory contains tests that treat the engine as a black box and assert on specification-defined behaviors:

```
test/conformance/
  tokenize.test.js       — IMPL §2, SPEC §1.2 tokenization contract
  parse.test.js          — IMPL §3, match desugaring, position accuracy
  expressions.test.js    — SPEC §1.4/§1.5 operators and type system
  analyze.test.js        — IMPL §9, requirement phases and graph
  errors.test.js         — Appendix A diagnostic codes
  extensions.test.js     — define* extensibility surface
  suspension_driver.test.js — SPEC §1.6/§1.9, conversation loop
  end_to_end.test.js     — SPEC §2.7 complete worked example
  limits.test.js         — IMPL §13 resource limits and security guards
  appendix-b.test.js     — IMPL Appendix B normative edge cases
  minimal_slice.test.js  — smallest possible sub-pipeline validations
```

This structure separates concerns clearly. Failures in the unit layer indicate that a specific component is broken. Failures in the conformance layer indicate an integration issue or a specification violation. A failure that appears only in the conformance layer but not in any unit test points to an interaction between components that individual tests do not exercise.

---

## 5. Node's Built-In Test Runner

All tests use `node:test` from Node.js's standard library, with `node:assert/strict` for assertions. There is no `jest`, no `mocha`, no `vitest`, no `chai`. The engine has zero runtime dependencies, and the test suite shares that property.

This is not an accident. Depending on a test framework introduces a dependency whose update behavior, breaking changes, and own bugs can affect the test suite. It creates an additional surface for supply-chain attacks. It increases the number of packages a security auditor must review. For a library that advertises zero runtime dependencies and ESM-only distribution, a test suite that pulls in a 400-package dependency tree would undermine those properties.

The Node built-in test runner has all the capabilities needed: `test()` for named test cases, `assert.equal()` / `assert.deepEqual()` / `assert.throws()` for assertions, and async test support via `async/await`. Test results are reported via the TAP protocol by default, and Node's reporter infrastructure handles output formatting.

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../../src/lexer/lexer.js';

test('plain text is a single text token', () => {
  const toks = tokenize('just text, no slots');
  assert.deepEqual(toks.map((t) => t.kind), ['text']);
  assert.deepEqual(toks[0], {
    kind: 'text',
    start: 0,
    end: 'just text, no slots'.length
  });
});
```

This is the complete test — no setup, no teardown, no describe blocks, no matchers, no lifecycle hooks. The signal-to-noise ratio is high.

---

## 6. Testing the Lexer

The lexer converts a template string into a flat array of tokens. Testing it means verifying that every token kind is produced correctly, that positions are accurate, that sigil escaping works, that error recovery functions, and that custom delimiters affect the output correctly.

A complete lexer test covers:

- The token kind sequence for representative inputs
- The `start` and `end` byte offsets for each token
- Escaped sigils (`\$`) that should produce text tokens rather than slots
- Unterminated strings and slots (error recovery without throwing)
- Comment body extraction
- Macro name tokens
- Custom delimiter configurations
- Empty input producing zero tokens

The `TokenType` contract test is particularly important:

```js
test('TokenType contract exposes the IMPL §2 kinds', () => {
  for (const kind of [
    'text', 'slot-open', 'slot-close', 'name', 'method',
    'number', 'string', 'bool', 'operator', 'dot', 'comma',
    'paren', 'bracket', 'brace', 'arrow', 'star',
    'comment-body', 'macro-name',
  ]) {
    assert.ok(Object.values(TokenType).includes(kind), `missing token kind: ${kind}`);
  }
});
```

This test asserts on the public contract rather than on implementation details. If a future refactor changes the internal constant names but preserves the public values, this test still passes. If a token kind is accidentally removed from the exported `TokenType` object, this test catches it before any downstream code notices.

Position testing is tested by verifying that `input.slice(t.start, t.end)` reconstructs the original source text for each token. This is not obvious: the `start` and `end` values are byte offsets into the original template string, and they must be accurate enough that an IDE or validator can highlight the exact text that a diagnostic refers to.

---

## 7. Testing the Parser

The parser converts a token stream into an AST. Testing it means verifying that every node kind is produced with the correct shape, that operator precedence is correctly encoded in the tree structure (not just in evaluation order), that match desugaring produces the right ternary chain, and that errors include position information.

The precedence test is a direct assertion on the `PRECEDENCE` table exported by the parser:

```js
test('PRECEDENCE matches SPEC §1.4 ordering', () => {
  assert.ok(PRECEDENCE['*'].binding > PRECEDENCE['+'].binding);
  assert.ok(PRECEDENCE['+'].binding > PRECEDENCE['<'].binding);
  assert.ok(PRECEDENCE['<'].binding > PRECEDENCE['=='].binding);
  assert.ok(PRECEDENCE['=='].binding > PRECEDENCE['and'].binding);
  assert.ok(PRECEDENCE['and'].binding > PRECEDENCE['or'].binding);
  assert.ok(PRECEDENCE['or'].binding > PRECEDENCE['??'].binding);
  assert.ok(PRECEDENCE['??'].binding > PRECEDENCE['?:'].binding);
});
```

This test does not run any templates. It asserts directly on the data structure that drives parsing. If the precedence table is corrupted, this test fails before any expression test runs, making the diagnosis immediate.

AST shape tests use a `stripPositions` helper that removes the `position` field from every node before comparing. This allows `assert.deepEqual` to compare the structural content of an AST without being sensitive to exact byte offsets, which can change if whitespace in the test template changes:

```js
test('literals: int / float / string / bool', () => {
  assert.deepEqual(expr('42'), { kind: 'Lit', type: 'int', value: 42 });
  assert.deepEqual(expr('3.14'), { kind: 'Lit', type: 'float', value: 3.14 });
  assert.deepEqual(expr("'hi'"), { kind: 'Lit', type: 'string', value: 'hi' });
  assert.deepEqual(expr('true'), { kind: 'Lit', type: 'bool', value: true });
});
```

Match desugaring requires a separate set of tests because `match` does not appear as a node kind in the AST — the parser converts it to a chain of ternary expressions. A test that asserts `expr.kind === 'Match'` would fail; the correct test asserts that a specific chain of `Ternary` nodes is produced.

Error recovery tests verify that a malformed expression causes `parse` to throw a `SeeboError` with a `code` and a `position`. Unlike the lexer, which never throws, the parser throws on unrecoverable syntax errors. The position in the thrown error must accurately identify where in the template the problem occurs.

---

## 8. Testing the Evaluator

The evaluator is the most complex component to test because it has three possible outcomes for every expression, and the distinction between them is semantically significant. A test that only checks for `Ok` outcomes is missing half the contract.

The unit tests for the evaluator construct AST nodes directly, bypassing the lexer and parser, which allows them to test specific node kinds in isolation:

```js
const lit = (type, value) => ({
  kind: 'Lit',
  position: { start: 0, end: 1 },
  type,
  value
});
const ctx = (resolved = {}) => ({
  resolved,
  symbols: new Map(),
  needs: new Map(),
  config: {},
  clock: () => new Date(0),
});

test('IMPL §5 — a literal evaluates to Ok(value)', () => {
  const res = evaluate(lit('int', 1), ctx());
  assert.equal(res.kind, ResultKind.OK);
  assert.equal(res.value.value, 1);
});
```

The `Susp` outcome tests verify that an unsatisfied requirement produces a suspension, and that the `id` of the suspension matches the requirement descriptor:

```js
test('IMPL §5 — an unsatisfied required requirement yields Susp(Need)', () => {
  const c = ctx();
  const req = engine.parse(
    "${ require({ id:'x', type:string(), capability:'user' }) }"
  ).nodes[0];
  const res = evaluate(req.expr, c);
  assert.equal(res.kind, ResultKind.SUSP);
  assert.equal(res.need.id, 'x');
  assert.ok(c.needs.has('x')); // recorded in the context's needs map
});
```

The lazy evaluation tests are the most important in the evaluator suite. Lazy `and`, `or`, `??`, and ternary operators must not evaluate their right branch when the left branch determines the result. More importantly, they must not emit a `Need` for a suspended requirement in the non-taken branch:

```js
test('IMPL §5 — phased resolution: lazy gating prevents Need emission', () => {
  const template = "${ paese == 'IT'
    ? require({id:'citta', type:string(), capability:'user'})
    : 'n/a' }";

  // paese = US → citta Need never emitted
  const us = engine.run(engine.start(template, { paese: 'US' }));
  assert.equal(us.status, Status.COMPLETED);
  assert.deepEqual(us.pending, []);

  // paese = IT → citta Need is emitted
  const it = engine.run(engine.start(template, { paese: 'IT' }));
  assert.equal(it.status, Status.WAITING);
  assert.equal(it.pending[0].id, 'citta');
});
```

This test is not just about lazy evaluation — it is the core test for the multi-phase execution model. If the lazy gating is broken, all phase-dependent behavior breaks.

---

## 9. Testing Static Analysis

The `analyze()` function returns a rich structure: the parsed AST, the requirement list enriched with phase numbers, the requirement graph edges, the execution plan (requirements grouped by phase), the set of capabilities used, static values that can be computed without any capability, the determinism flag, and the streamability classification.

Each field of the analysis output has a corresponding test. The most interesting are the phase tests and the graph tests.

Phase tests verify that a requirement gated behind another requirement appears in a later phase:

```js
test('IMPL B.1 — nested branch phases: citta is phase 2 when gated by paese', () => {
  const analysis = engine.analyze(
    "${ paese == 'IT'
      ? require({id:'citta', type:string(), capability:'user'})
      : 'ok' }"
  );
  const citta = analysis.requirements.find(r => r.id === 'citta');
  assert.equal(citta?.phase, 2);
});
```

Graph tests verify the edges in `requirementGraph.edges`. An edge `[A, B]` means requirement B is active only in a branch whose governing condition references A:

```js
const edges = analysis.requirementGraph.edges;
assert.ok(edges.some(([from, to]) => from === 'paese' && to === 'citta'));
```

The determinism test verifies that `analysis.deterministic` is `false` when the template uses `now()`, and `true` when it does not. This flag is used by UI layers to decide whether to show a "preview may change" warning.

---

## 10. Testing the Driver

The driver test suite in `test/conformance/suspension_driver.test.js` tests the complete conversation loop: template → capabilities → resolution → output. These tests use real engine instances with real capability providers.

The fundamental driver test verifies that a capability is invoked and its return value appears in the output:

```js
test('IMPL §7 — driver auto-resolves a capability', async () => {
  const engine = realEngine({ capabilities: { crm: () => 'A42' } });
  const res = await engine.stebo({
    template: "Order ${ crm({ id:'oid', type:string(), capability:'crm' }) }",
  });
  assert.equal(res.status, Status.COMPLETED);
  assert.equal(res.output, 'Order A42');
});
```

The `stopOn` tests verify that capabilities in the stop list are left as `pending` rather than resolved:

```js
test('IMPL §7.1 — Unresolved capability stops with pending (stopOn)', async () => {
  const engine = realEngine({ capabilities: { user: () => undefined } });
  const res = await engine.drive(
    "Hi ${ user({ id:'name', type:string(), capability:'user' }) }",
    { stopOn: ['user'] }
  );
  assert.equal(res.status, Status.WAITING);
  assert.deepEqual(res.pending.map(r => r.id), ['name']);
});
```

Policy enforcement tests verify that `CAPABILITY_FORBIDDEN` is produced when a template attempts to use a capability not in `allowedCapabilities`. These tests are integration tests: they exercise the full driver loop, not just the policy check in isolation.

---

## 11. Testing Macros

Macro tests divide into two categories: expand tests and finalize tests, corresponding to the two macro phases.

**Expand tests** verify that `ABSORB` and `MERGE` macros correctly replace their call sites with the content of the referenced sub-template, and that cyclic inclusions produce `INCLUSION_CYCLE` errors rather than infinite loops.

**Finalize tests** verify that layout macros produce the correct edits to the emitted string. `REMOVE_LINE` must remove the entire line containing the macro marker. `REMOVE_LEFT(n)` must remove `n` characters to the left. `REMOVE_RIGHT(n)` must remove `n` characters to the right. `COLLAPSE` must collapse adjacent blank lines into one.

The finalize tests are tricky because they involve string offsets that shift as characters are removed. A test might verify:

```js
const template = [
  'riga1',
  '${ empty }@{REMOVE_LINE}',
  '${ x }@{REMOVE_RIGHT(2)}AB',
].join('\n');

const res = await engine.stebo({ template, values: { empty: '', x: 'V' } });
assert.equal(res.output.trim(), 'riga1\nV');
```

The second line (`${empty}@{REMOVE_LINE}`) should be completely removed because the layout macro applies to the entire line. The third line should have the `@{REMOVE_RIGHT(2)}AB` suffix removed, leaving only `V`.

---

## 12. Testing Security Properties

Security tests deserve their own section because they are not just edge cases — they verify invariants that must hold against adversarial inputs.

**Limit tests** verify that each configurable limit, when set to a minimal value, causes the appropriate diagnostic code to be produced. For example:

```js
test('IMPL §13 — input length over maxInputBytes ⇒ INPUT_LIMIT_EXCEEDED', () => {
  const engine = realEngine({ limits: { maxInputBytes: 4 } });
  assert.throws(
    () => engine.parse('${ 1 }'),
    (e) => e.code === DiagnosticCode.INPUT_LIMIT_EXCEEDED,
    'expected parse to throw INPUT_LIMIT_EXCEEDED'
  );
});
```

**Prototype-pollution tests** verify that `__proto__` keys in templates, requirement IDs, initial values, and object literals never affect `Object.prototype`. Each attack vector gets its own test:

```js
test('a __proto__ initial value never pollutes Object.prototype', () => {
  const engine = realEngine();
  engine.run(engine.start('${ 1 }', { __proto__: { polluted: true } }));
  assert.equal(({}).polluted, undefined);
});

test('a __proto__ key inside an object literal is dropped', () => {
  const engine = realEngine();
  const state = engine.run(
    engine.start('${ { __proto__: { polluted: true }, a: 1 }.keys().len() }')
  );
  assert.equal(state.output, '1'); // only 'a' key, __proto__ was dropped
  assert.equal(({}).polluted, undefined);
});
```

The assertion `({}).polluted === undefined` is the ultimate check: after the engine runs, does a freshly created empty object have no unexpected properties? If prototype pollution succeeded, every new object would have `polluted: true`.

---

## 13. Appendix B: Normative Borderline Cases

Appendix B of the implementation specification is a collection of behaviors that are normative — they define what the correct behavior is — but were once ambiguous or surprising enough to require explicit documentation. Every entry in Appendix B has a corresponding test in `test/conformance/appendix-b.test.js`.

**B.2 (need in non-taken branch)** verifies that a suspended requirement gated behind a false condition does not appear in `pending`. This is the lazy gating invariant — a requirement in the non-taken branch of a ternary must not be emitted:

```js
test('IMPL B.2 — need in non-taken branch is not emitted', () => {
  const template =
    "${ flag ? require({id:'x', type:string(), capability:'user'}) : 'ok' }";

  const off = engine.run(engine.start(template, { flag: false }));
  assert.equal(off.status, Status.COMPLETED);
  assert.equal(off.output, 'ok');
  assert.deepEqual(off.pending, []); // x was never emitted
});
```

**B.6 (layout macros)** verifies the interaction between `REMOVE_LINE` and `REMOVE_RIGHT` in a multi-line template. Both macros are applied in the finalize pass after evaluation completes.

Other Appendix B cases covering non-exhaustive match, unknown capability, and inclusion cycles are distributed across `errors.test.js` and `analyze.test.js`, with references in the coverage map at the top of `appendix-b.test.js`.

---

## 14. The No-Skip Invariant

Every test in the Seebo test suite is active. There are no `.skip` calls, no `.todo` markers, no disabled tests. This is a deliberate policy enforced by the team.

The rationale is straightforward: a disabled test is not a test. It is a note that says "this behavior should be verified but currently is not." Over time, disabled tests accumulate, their intended purpose becomes unclear, and they are either never re-enabled or deleted without the underlying issue being addressed. They create false confidence in the completeness of the test suite.

If a test fails because the behavior it tests has not been implemented yet, the correct action is to not merge that test until the implementation is complete. If a test fails because the behavior is ambiguous, the correct action is to resolve the ambiguity in the specification and then write a conforming test.

Running the test suite should always produce a green result. A red result means something is genuinely broken, not that someone forgot to re-enable a test.

---

## 15. Subtle Bugs in Parser and Evaluator

Experience building language engines teaches that certain categories of bugs are reliably subtle and reliably tested poorly.

**Operator precedence off-by-one errors** are the most common parser bug. A Pratt parser assigns a binding power to each operator; if the binding power is too low, the parser produces left-leaning trees where right-leaning was expected, or vice versa. This produces incorrect evaluation order for expressions like `a - b - c` (which should be `(a - b) - c`) or `a ?? b ?? c`. The precedence test asserts directly on the binding power table:

```js
assert.ok(PRECEDENCE['*'].binding > PRECEDENCE['+'].binding);
```

This catches the error at the data structure level rather than at the evaluation level.

**Short-circuit edge cases** involve expressions where one side is suspended and the other is not. In `false and require(...)`, the right side should never be evaluated, and the requirement should not appear in `pending`. In `true or require(...)`, the same. But in `condition and require(...)` where `condition` is itself suspended, the entire expression must suspend without touching the right side. Tests for lazy evaluation must exercise all three cases: left is known-true, left is known-false, left is suspended.

**Position tracking bugs** are invisible unless you specifically test source positions. An expression like `1 + 2 * 3` produces three binary nodes, and each node's `position` must span exactly the source text it represents. If positions are incorrectly copied from parent to child or computed at the wrong moment, diagnostics will point to the wrong location in the template. The position tests use `input.slice(node.position.start, node.position.end)` to verify that the reported position reconstructs the original source.

---

## 16. Property-Based Testing as a Future Direction

The test suite as described is an example-based test suite: each test specifies one input and one expected output. This is effective for covering known cases but cannot discover unknown edge cases.

Property-based testing is a technique where the test framework generates random inputs and checks that specified invariants hold across all of them. For a template engine, useful properties include:

- **Round-trip soundness**: for any token stream produced by the lexer, the parser should either produce an AST or throw an error with a position within the input bounds. It should never produce an undefined position or a position beyond the input length.
- **Evaluation totality**: for any valid AST, the evaluator should return `Ok`, `Susp`, or `Err` — never throw an uncaught exception or return `undefined`.
- **Limit monotonicity**: for any template that succeeds with limit L, it should also succeed with limit L + 1. For any template that fails with `LIMIT_EXCEEDED` at limit L, it should fail at limit L - 1 as well.
- **Sanitization idempotency**: for any input to `sanitizeJson`, running `sanitizeJson(sanitizeJson(x))` should equal `sanitizeJson(x)`.

These invariants are hard to verify by example — there are too many inputs to enumerate — but easy to check with a generator. Property-based testing libraries like `fast-check` are compatible with `node:test` and would extend the suite's coverage without requiring manual scenario construction.

---

## Conclusion

Testing a language engine requires a different mindset than testing application code. The combinatorial space of possible inputs is vast; complete coverage is impossible; and the most important properties — correct precedence, lazy evaluation, type safety, resource limits — are mathematical invariants rather than business rules.

Seebo addresses this with a specification-driven test suite that treats tests as machine-checkable projections of normative requirements. The two-layer directory structure separates unit isolation from integration conformance. The no-skip invariant ensures the test suite always represents the true state of the implementation. Appendix B collects the borderline cases that once were ambiguous and are now normative.

The choice of `node:test` with zero external dependencies aligns the test suite with the engine's own dependency philosophy: the test infrastructure is as minimal as the engine itself.

---

## Further Reading

- `test/unit/` — all unit tests organized by component
- `test/conformance/` — specification-mapped conformance tests
- `test/conformance/limits.test.js` — security limit conformance tests
- `test/conformance/appendix-b.test.js` — normative borderline case tests
- `test/helpers/` — shared helper utilities (`realEngine`, `stripPositions`, `assertHasCode`)
- IMPL Appendix A — normative diagnostic codes tested in `errors.test.js`
- IMPL Appendix B — normative borderline behaviors tested in `appendix-b.test.js`
