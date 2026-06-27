# Testing an Engine: Conformance, Unit Tests, and Edge Cases

## Table of Contents

1. [Why Testing an Engine Is Different](#why-testing-an-engine-is-different)
2. [Specification-Driven Development](#specification-driven-development)
3. [Test Types in Seebo](#test-types-in-seebo)
4. [The Two-Layer Structure](#the-two-layer-structure)
5. [Using Node's Built-in node:test](#using-nodes-built-in-nodetest)
6. [Testing the Lexer](#testing-the-lexer)
7. [Testing the Parser](#testing-the-parser)
8. [Testing the Evaluator](#testing-the-evaluator)
9. [Testing Static Analysis](#testing-static-analysis)
10. [Testing the Driver](#testing-the-driver)
11. [Testing Macros](#testing-macros)
12. [Testing Security Properties](#testing-security-properties)
13. [Appendix B Conformance Cases](#appendix-b-conformance-cases)
14. [Why Parser and Evaluator Bugs Are Subtle](#why-parser-and-evaluator-bugs-are-subtle)
15. [The No-.skip Invariant](#the-no-skip-invariant)
16. [Property-Based Testing as Future Improvement](#property-based-testing-as-future-improvement)
17. [Worked Test Examples](#worked-test-examples)
18. [Conclusion](#conclusion)
19. [Further Reading](#further-reading)

---

## Why Testing an Engine Is Different

Testing application code is usually about verifying behavior in known scenarios: create a user, save it, retrieve it, check the fields. The behavior is straightforward; the challenge is wiring up the environment.

Testing a language engine is categorically different. The engine is a function from text to structured output — from a template string to values, needs, and diagnostics. The input space is infinite (any string is a potential template), and the interesting behaviors live at the edges: near limit boundaries, at operator precedence boundaries, in interactions between language features that rarely occur together in practice.

Several properties of engine testing are particularly challenging:

**Precedence bugs are invisible to casual inspection**: The expression `1 + 2 * 3` should evaluate to `7`, not `9`. In a correctly implemented parser, this is obvious. But `a or b and c` parsing as `a or (b and c)` rather than `(a or b) and c` is a silent precedence bug that produces wrong results only when the specific combination of operators, values, and truth tables occurs. You cannot discover these bugs by running a few happy-path examples.

**Lazy evaluation is easy to test wrong**: The test for `require({id:'x'}) and false` should verify that `x` does not appear in pending needs. But if the test only checks the output value (which is correctly `false`), the test passes even if the evaluator incorrectly evaluated the right operand.

**Error recovery is subtle**: A parser that fails on the first error and crashes leaves many tokens unexamined. A parser that attempts to recover and continue may introduce phantom errors in the recovery path. Testing error recovery means testing both what errors are reported and what errors are not.

**Positions are load-bearing**: A diagnostic that points to the wrong position in the template is useless to a developer trying to fix an error. But position bugs don't cause tests to fail unless tests explicitly verify positions — which is tedious to maintain.

These challenges demand a disciplined, specification-driven testing approach.

---

## Specification-Driven Development

The SPEC.md and IMPL.md documents were written before significant code was written. This is not incidental — it is a deliberate development methodology that has profound implications for testing.

When a specification exists before the implementation, tests can be written against the specification rather than against the code. This matters because:

**The specification describes intended behavior, not implemented behavior.** Tests that verify the specification catch implementation deviations. Tests that verify the implementation code only catch regressions.

**Specification sections provide natural test organization.** Each test file in `test/conformance/` references the specification section it covers: `// tests IMPL §2.3` or `// covers SPEC §1.6`. This makes it possible to audit test coverage by checking which sections have conformance tests.

**Appendix B borderline cases are normative.** The specification's appendix lists specific cases that are easy to get wrong, with the expected behavior for each. These cases become test cases directly, without interpretation.

**The specification enables independent verification.** A third party can implement a compatible engine and run the same conformance tests to verify compatibility. The tests are not tied to the implementation — they are tied to the specification.

---

## Test Types in Seebo

Seebo's test suite encompasses several test types, each with a different purpose.

**Unit tests** verify that a single component works correctly in isolation, with no external dependencies. A lexer unit test provides a raw string and checks the exact sequence of tokens produced. A parser unit test provides a token sequence and checks the AST structure. Unit tests are fast, independent, and precise.

**Conformance tests** verify that the full pipeline produces behavior that matches the specification. They test components in integration, using actual template strings as inputs, and verify the overall output, pending needs, and diagnostics. Conformance tests catch integration bugs that unit tests miss.

**Golden tests** verify exact output for known, fixed inputs. A golden test for a complete email template provides all the required values and checks that the rendered output matches a stored expected string character-for-character. Golden tests catch regressions in text formatting, whitespace handling, and locale-specific behavior.

**Regression tests** document specific bugs that have been found and fixed. Each regression test is a minimal reproducer for a known bug, along with the expected behavior after the fix. They ensure bugs don't silently reappear.

**Security tests** verify that safety invariants hold under adversarial inputs: oversized templates, deeply nested expressions, prototype pollution attempts, resource limit violations. Security tests check not just the output but the absence of side effects.

---

## The Two-Layer Structure

Seebo's test directory is split into two layers that reflect the distinction between component isolation and specification conformance.

```
test/
  unit/
    lexer.test.js          -- token types, positions, error tokens
    parser.test.js         -- AST shapes, precedence, match desugaring
    values.test.js         -- value creation, normalization, temporal arithmetic
    evaluator.test.js      -- Ok/Susp/Err outcomes, lazy gating
    validate.test.js       -- diagnostic codes, conservative inferencer
    analyze.test.js        -- requirement graph, execution plan, streamability
    macros.test.js         -- ABSORB, MERGE, REMOVE_LINE, COLLAPSE
    registry.test.js       -- name governance, extension registration
    cache.test.js          -- astCache hit/miss, invalidation
    api.test.js            -- createEngine, defineFunction, stebo() shape
  conformance/
    tokenize.test.js       -- IMPL §2, SPEC §1.2: full tokenization conformance
    parse.test.js          -- IMPL §3: document structure, match desugaring
    expressions.test.js    -- SPEC §1.4/§1.5: operators, types, precedence
    analyze.test.js        -- IMPL §9: requirement phases, dependency graph
    errors.test.js         -- Appendix A: all diagnostic codes
    extensions.test.js     -- SPEC §2.6: define* extensibility
    suspension_driver.test.js -- SPEC §1.9, IMPL §7: conversation loop, stopOn
    end_to_end.test.js     -- SPEC §2.7: the worked example from the specification
    appendix-b.test.js     -- IMPL Appendix B: borderline conformance cases
```

The unit layer tests components in isolation. The conformance layer tests the complete pipeline against the specification. A bug that is only detectable through the full pipeline (e.g., an interaction between the parser and the evaluator) will appear in conformance tests but not unit tests. A bug that is detectable in isolation (e.g., wrong operator precedence) should appear in both.

---

## Using Node's Built-in node:test

Seebo's test suite uses Node.js's built-in `node:test` module with no external test framework. This is a deliberate choice with several consequences.

**Zero dependencies**: The test suite has no test framework dependencies. `npm install` produces the same test environment everywhere without version conflicts.

**Standard output**: `node:test` produces TAP-compatible output that any CI system can parse. There is no proprietary reporter format.

**No magic**: Test files are plain JavaScript files that `import { test, describe, it, assert }` from `node:test` and `node:assert`. There is no magic injection, no global variables, no runtime patching.

**Small surface area**: The API is `describe()`, `it()`, `test()`, `assert.strictEqual()`, `assert.deepStrictEqual()`, `assert.throws()`, `assert.doesNotThrow()`. Nothing exotic.

The trade-off is that `node:test` lacks some features of mature test frameworks: no snapshot testing, no built-in parameterized tests (though you can write them with loops), limited async control. For Seebo's use case — deterministic, pure functions with known inputs and outputs — `node:test` is entirely adequate.

---

## Testing the Lexer

Lexer tests verify that the tokenizer correctly converts a raw string into the expected sequence of tokens, including token types, values, and byte-offset positions.

A good lexer test for a mixed-content language covers:

- **Pure text**: A string with no slots produces a single TEXT token
- **Single slot**: `${ name }` produces FORMULA_OPEN, IDENT, FORMULA_CLOSE
- **Nested expressions**: `${ a + b }` produces the correct operator token between idents
- **Macros**: `@{ REMOVE_LINE }` produces MACRO_OPEN, IDENT, MACRO_CLOSE
- **Escaped delimiters**: `\${ ` produces a TEXT token containing the literal `${`
- **Unclosed slots**: `${ name` produces FORMULA_OPEN, IDENT, MALFORMED — the lexer does not crash
- **Adjacent slots**: `${ a }${ b }` produces the correct interleaved tokens
- **Multi-line templates**: Newlines in TEXT tokens are preserved exactly
- **Unicode content**: Non-ASCII characters in TEXT tokens are counted by bytes, not characters
- **Byte offsets**: The `start` and `end` fields of each token match the byte position in the source string

Position testing deserves particular attention. A test that verifies `start: 9, end: 13` for a specific token is testing a load-bearing property that enables editor integration. These tests are tedious to write and maintain, but they are essential.

---

## Testing the Parser

Parser tests verify that the Pratt parser produces the correct AST for given expressions, paying particular attention to operator precedence and associativity.

**Precedence tests** are the most important:

| Expression | Expected AST shape |
|---|---|
| `1 + 2 * 3` | `BinaryExpr(+, 1, BinaryExpr(*, 2, 3))` |
| `a or b and c` | `BinaryExpr(or, a, BinaryExpr(and, b, c))` |
| `a and b or c` | `BinaryExpr(or, BinaryExpr(and, a, b), c)` |
| `a ?? b ?: c` | `TernaryExpr(BinaryExpr(??, a, b), ...)` — actually wrong, ternary has lower precedence |
| `not a and b` | `BinaryExpr(and, UnaryExpr(not, a), b)` |
| `a.b.c` | `MemberExpr(MemberExpr(a, b), c)` — left-associative chaining |

Each of these tests verifies a specific row in the operator precedence table. If the table has an error, one of these tests will fail. If the tests are absent, a subtle precedence bug can survive for months.

**Match desugaring tests** verify that `match { case v => r, * => d }` is correctly transformed into nested ternaries at parse time. The test checks the AST of the desugared result, not the match syntax (which does not appear in the AST):

```js
// Source: match x { case 1 => 'one', * => 'other' }
// Expected AST: TernaryExpr(BinaryExpr(==, x, 1), 'one', 'other')
```

**Error recovery tests** check that malformed expressions produce diagnostics without crashing, and that correctly-formed siblings of the malformed expression are still parsed successfully:

```js
// '${ 1 + }${ 2 }' — first slot is malformed, second should parse fine
// Expected: one SYNTAX_ERROR diagnostic, plus a successfully parsed second slot
```

---

## Testing the Evaluator

Evaluator tests verify the three-way outcome model: Ok, Susp, and Err. Each test provides a template and a set of resolved values, and checks the resulting state.

**Ok outcome tests** verify that expressions with all data available produce the correct value:

```js
// template: '${ 1 + 2 }'
// resolved: {}
// expected: status='completed', output='3'
```

**Susp outcome tests** verify that missing requirements produce pending needs:

```js
// template: '${ require({ id: "x", type: string(), capability: "user" }) }'
// resolved: {}
// expected: status='waiting', pending=[Need{id:'x', capability:'user'}]
```

**Err outcome tests** verify that type errors produce error diagnostics:

```js
// template: "${ 'a' + 1 }"
// resolved: {}
// expected: status='failed', diagnostics=[{code:'TYPE_ERROR_RUNTIME', ...}]
```

**Lazy evaluation tests** are the most important and most frequently missed:

```js
// Test: right operand of 'and' when left is false should NOT emit a Need
// template: '${ false and require({ id: "x", type: string(), capability: "user" }) }'
// resolved: {}
// expected: status='completed', output='false', pending=[]
// WRONG would be: pending=[Need{id:'x'}]
```

These tests verify that Needs from untaken branches are not emitted. This is the core invariant that enables requirement phases: a requirement in the false branch of a ternary should not appear as a pending need.

---

## Testing Static Analysis

Validate tests verify that `validate()` returns the correct diagnostic codes for invalid templates, and returns an empty array for valid templates.

Each test case specifies a template, the expected diagnostic codes (order-insensitive), and optionally the diagnostic positions.

```js
// Template: '${ unknownFunc() }'
// Expected diagnostics: [{ code: 'UNKNOWN_FUNCTION', ... }]

// Template: "${ 'a' + 1 }"
// Expected diagnostics: [{ code: 'TYPE_ERROR', ... }]

// Template: '${ require({ id: "x", type: string(), capability: "user" }) }'
// Expected diagnostics: []  (valid)
```

Analyze tests verify the shape of the `Analysis` output:

```js
// Template with conditional requirement:
// '${ a ? require({id:"b",...}) : "no" }'
// Expected:
// requirements: [{id:'a',...}, {id:'b',...}]  (if 'a' is also require()d)
// requirementGraph.edges: [['a', 'b']]
// executionPlan: [{phase:1, requirements:['a']}, {phase:2, requirements:['b']}]
// maxPhases: 2
```

---

## Testing the Driver

Driver tests verify the conversation loop: that the engine correctly resolves needs through capabilities, honors the `stopOn` option, and handles capability failures.

```js
// Test: stopOn='user' returns user needs without resolving them
// template: '${ require({id:"x", capability:"user", type:string()}) }'
// capabilities: { user: () => undefined }
// stopOn: ['user']
// Expected: status='waiting', pending=[Need{id:'x', capability:'user'}]
// (not completed, even though 'user' returned undefined — stopped because stopOn includes 'user')
```

Policy tests verify that blocked capabilities produce the correct diagnostics:

```js
// Engine policy: allowedCapabilities=['user']
// Template: '${ crm({id:"order", type:object()}) }'
// Expected validate() result: [{ code: 'POLICY_FORBIDDEN', capability: 'crm' }]
// Expected drive() result: status='failed', diagnostics=[{code:'CAPABILITY_FORBIDDEN'}]
```

---

## Testing Macros

Macro tests verify both expansion and finalization behavior with exact string comparison of outputs.

**ABSORB tests** verify that named templates are correctly inlined:

```js
// Templates: { 'header': 'HEADER\n', 'footer': '\nFOOTER' }
// Template: '@{ABSORB("header")}Body@{ABSORB("footer")}'
// Expected expanded string: 'HEADER\nBody\nFOOTER'
```

**MERGE tests** verify that glob matching and sorting work correctly:

```js
// Templates: { 'sec_b': 'B', 'sec_a': 'A', 'sec_c': 'C', 'other': 'X' }
// Template: '@{MERGE("sec_*", ",")}'
// Expected expanded string: 'A,B,C'  (sorted, 'other' excluded)
```

**REMOVE_LINE tests** verify that entire lines are removed, including the newline:

```js
// Raw output before FINALIZE: 'Line 1\n@{REMOVE_LINE}\nLine 3'
// Expected after FINALIZE: 'Line 1\nLine 3'
```

**COLLAPSE tests** verify multi-blank-line normalization:

```js
// Raw output: 'A\n\n\n\nB'
// Expected after COLLAPSE: 'A\n\nB'  (at most one blank line)
```

---

## Testing Security Properties

Security tests verify that adversarial inputs are correctly rejected or neutralized.

**Resource limit tests**:

```js
// Template exceeding maxInputBytes (1MB): should produce INPUT_LIMIT_EXCEEDED
const oversized = 'x'.repeat(1_100_000);
// validate(oversized) → [{code: 'INPUT_LIMIT_EXCEEDED'}]

// Deeply nested expression exceeding maxNestingDepth:
const deepNest = '(' .repeat(250) + '1' + ')'.repeat(250);
// validate(`${ ${deepNest} }`) → [{code: 'NESTING_LIMIT_EXCEEDED'}]
```

**Prototype pollution tests**:

```js
// JSON input attempting to set __proto__
const malicious = JSON.parse('{"__proto__": {"isAdmin": true}, "name": "x"}');
const value = engine.fromJs(malicious);
// assert: Object.prototype.isAdmin is undefined (not set)
// assert: value.value.name === 'x'
// assert: value.value.__proto__ is the normal Object.prototype
```

**Policy enforcement tests**:

```js
// Template using blocked capability
const engine = createEngine({
  capabilities: { user: u, crm: c },
  policy: { allowedCapabilities: ['user'] }
});
// engine.validate('${ crm({id:"x", type:string()}) }')
// → [{code: 'POLICY_FORBIDDEN', ...}]
```

---

## Appendix B Conformance Cases

The specification's Appendix B lists specific edge cases that the spec authors identified as tricky, with the expected behavior for each. These are not examples — they are normative test cases that any conforming implementation must pass.

Examples of Appendix B cases include:

- **Integer division rounding**: `${ 7 / 2 }` in a context where both operands are int — does it produce `3` (integer division, truncating) or `3.5` (float division)? The spec answers this precisely.

- **Nullish coalesce with empty array**: `${ [] ?? 'default' }` — is an empty array "empty" for the purpose of `??`? The spec defines which values are considered "empty."

- **Duration precision in arithmetic**: `${ datetime('2026-01-01').add(duration(90)) }` — what precision does the result have? The spec's precision propagation rules determine this.

- **Match with no cases**: `match x { }` — is this a syntax error, a validation error, or a runtime error? The spec says which.

- **NON_EXHAUSTIVE_MATCH detection after desugaring**: `match` is desugared to ternaries at parse time. How does the validator detect NON_EXHAUSTIVE_MATCH in a template that no longer has match nodes in its AST? This is an implementation challenge that the spec acknowledges.

Each Appendix B case corresponds to a test in `appendix-b.test.js` that verifies the specified behavior exactly.

---

## Why Parser and Evaluator Bugs Are Subtle

An experience programmer who has worked with lexers and parsers knows this intuitively, but it is worth articulating for those approaching engine development for the first time.

**Precedence bugs manifest only in specific input combinations.** A precedence error between `and` (binding power 480) and `or` (binding power 460) only matters when both operators appear in the same expression, without parentheses, with operands that produce different results depending on the grouping. A test suite that never tests `a or b and c` without parentheses will not catch this bug.

**Position bugs compound.** If the lexer is off by one byte in its position tracking, every diagnostic position downstream will be wrong. But the positions might be "close enough" that casual testing passes — the diagnostic still points to roughly the right place.

**Short-circuit bugs are invisible in outputs.** The test for `false and require(...)` produces output `'false'` whether or not the requirement is evaluated. The only way to detect the bug is to explicitly check `state.pending` — which an output-only test won't do.

**Error recovery bugs hide each other.** If the parser incorrectly recovers from an error and the recovery introduces phantom state, the next error might be mis-attributed or skipped. Debugging two interacting recovery bugs is significantly harder than debugging either in isolation.

The mitigation is explicit, exhaustive tests for each of these properties, written against the specification's stated invariants rather than against observed behavior.

---

## The No-.skip Invariant

All tests in Seebo's test suite must pass. There are no `.skip()` calls, no `.todo()` markers, and no disabled tests. This is a strict invariant.

The reasoning: a disabled test is a known failure that has been accepted. Accepting known failures creates technical debt that is rarely paid off. The CI system cannot distinguish "this test was disabled intentionally" from "this test was disabled because it was inconvenient." Over time, the disabled tests accumulate and the suite loses its value as a quality signal.

If a test is failing and cannot be immediately fixed, the correct response is to fix the underlying issue, not to disable the test. If the behavior covered by the test is genuinely unspecified or not yet implemented, the test should not exist yet — the specification section should be marked as "future work" and the test should be written when the feature is implemented.

---

## Property-Based Testing as Future Improvement

All of Seebo's current tests are example-based: they test specific, handcrafted inputs with known expected outputs. This is valuable, but it has a fundamental limitation: it only catches bugs that the test author thought to look for.

Property-based testing (also known as generative testing or fuzzing with invariant checking) takes a different approach: instead of specifying inputs and expected outputs, you specify invariants that must hold for all inputs, and the testing framework generates random inputs and checks the invariants.

Examples of properties Seebo could test property-based:

**Round-trip property**: For any valid template and any set of resolved values, `JSON.parse(JSON.stringify(engine.run(engine.start(template, values))))` should produce the same result as the original (state is JSON-roundtrippable).

**Idempotency property**: For any state, `run(run(state))` should produce the same state as `run(state)` (single run is idempotent).

**Determinism property**: For any template and resolved map, calling `run()` twice with the same inputs produces identical results.

**Monotonicity property**: If S2 has more resolved values than S1 (S1.resolved ⊆ S2.resolved), then `run(S2).pending` should be a subset of `run(S1).pending` (more data means fewer needs).

**Lazy evaluation property**: If `run(state)` produces output O and pending needs P, then for any requirement not in P, adding it to `resolved` and running again should produce a result with the same or fewer pending needs and the same or more complete output.

Property-based testing with a library like `fast-check` would significantly increase confidence in these invariants beyond what example-based testing can provide.

---

## Worked Test Examples

### A Lexer Test

```js
import { test } from 'node:test';
import * as assert from 'node:assert';
import { tokenize } from '../../src/lexer/index.js';

test('tokenizes a formula slot with member access', () => {
  const tokens = tokenize('Hello ${ name.upper() }!');
  assert.deepStrictEqual(tokens.map(t => [t.type, t.value]), [
    ['TEXT', 'Hello '],
    ['FORMULA_OPEN', '${'],
    ['IDENT', 'name'],
    ['DOT', '.'],
    ['IDENT', 'upper'],
    ['LPAREN', '('],
    ['RPAREN', ')'],
    ['FORMULA_CLOSE', '}'],
    ['TEXT', '!']
  ]);
  // Also verify positions
  assert.strictEqual(tokens[0].start, 0);
  assert.strictEqual(tokens[0].end, 6);
});
```

### A Parser Test (Precedence)

```js
test('and binds tighter than or', () => {
  const ast = parse('${ a or b and c }');
  const slot = ast.segments[0]; // FormulaSegment
  // Expected: BinaryExpr(or, a, BinaryExpr(and, b, c))
  assert.strictEqual(slot.expr.kind, 'BinaryExpr');
  assert.strictEqual(slot.expr.op, 'or');
  assert.strictEqual(slot.expr.right.kind, 'BinaryExpr');
  assert.strictEqual(slot.expr.right.op, 'and');
});
```

### An Evaluator Test (Lazy Evaluation)

```js
test('and short-circuit: right operand Need not emitted when left is false', () => {
  const engine = createEngine({ ...builtins.all, capabilities: { user: () => undefined } });
  const template = '${ false and require({ id: "x", type: string(), capability: "user" }) }';
  const state = engine.run(engine.start(template, {}));
  assert.strictEqual(state.status, 'completed');
  assert.strictEqual(state.output, 'false');
  assert.deepStrictEqual(state.pending, []);
});
```

### A Validation Test

```js
test('POLICY_FORBIDDEN when capability blocked by allowedCapabilities', () => {
  const engine = createEngine({
    ...builtins.all,
    capabilities: { user: () => undefined, crm: () => undefined },
    policy: { allowedCapabilities: ['user'] }
  });
  const diags = engine.validate('${ crm({ id: "x", type: string() }) }');
  assert.ok(diags.some(d => d.code === 'POLICY_FORBIDDEN'));
});
```

### A Security Test (Resource Limit)

```js
test('INPUT_LIMIT_EXCEEDED for oversized templates', () => {
  const engine = createEngine({ ...builtins.all, limits: { maxInputBytes: 100 } });
  const hugeTemplate = 'x'.repeat(200);
  const diags = engine.validate(hugeTemplate);
  assert.ok(diags.some(d => d.code === 'INPUT_LIMIT_EXCEEDED'));
});
```

---

## Conclusion

Testing a language engine is a discipline in itself. The properties that matter — precedence, short-circuit semantics, position tracking, error accumulation, lazy Need emission — are precisely the properties that are hardest to verify by casual inspection or by running happy-path examples.

Seebo's test strategy addresses this through a combination of specification-driven organization (each test file maps to a specification section), two-layer structure (unit + conformance), exhaustive precedence and lazy evaluation tests, security property tests, and the no-skip invariant that ensures the test suite remains a reliable quality signal.

The result is a test suite that not only verifies current behavior but serves as an executable specification — a concrete, runnable version of the SPEC.md and IMPL.md documents. If you read the conformance test files alongside the specification sections they cite, you have a complete picture of what the engine is supposed to do and evidence that it does it.

---

## Further Reading

- `test/unit/` — unit test files for each component
- `test/conformance/` — specification-section-mapped conformance tests
- `docs/CONFORMANCE.md` — the conformance test strategy document
- Article 11 in this series: "Static Validation: Catching Errors Before the First Run"
- Article 15 in this series: "Security and Hardening: Running Untrusted Templates Safely"
- Claessen, K. & Hughes, J. (2000). "QuickCheck: A Lightweight Tool for Random Testing of Haskell Programs." — the original property-based testing paper
- Fuzz testing with `fast-check`: https://fast-check.dev — the most widely used property-based testing library for JavaScript
- Beck, K. (2002). *Test-Driven Development: By Example*. Addison-Wesley.
