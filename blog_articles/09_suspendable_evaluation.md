# Suspendable Evaluation: Pausing Without Failing

## Table of Contents

1. [The Core Insight](#the-core-insight)
2. [The Three-Way EvalResult](#the-three-way-evalresult)
3. [What Each Outcome Means](#what-each-outcome-means)
4. [Propagation Rules](#propagation-rules)
5. [Lazy Evaluation Semantics](#lazy-evaluation-semantics)
6. [Why Deterministic Evaluation Matters](#why-deterministic-evaluation-matters)
7. [No I/O Inside the Evaluator](#no-io-inside-the-evaluator)
8. [The Evaluator Context](#the-evaluator-context)
9. [Step Counting and Resource Limits](#step-counting-and-resource-limits)
10. [Worked Examples](#worked-examples)
11. [Connection to Operational Semantics](#connection-to-operational-semantics)
12. [Conclusion](#conclusion)
13. [Further Reading](#further-reading)

---

## The Core Insight

Every practical template engine has to deal with the question: what happens when data is missing? The naive answer is to fail with an error. The Seebo answer is different: when data is missing, evaluation should pause and report what it needs, not crash and report that something went wrong.

This distinction matters enormously in practice. "Error: variable `customerName` is not defined" is a dead end — the template cannot proceed, and the developer must figure out why the variable was not passed. "Waiting for: `customerName` (capability: `user`, label: 'Customer name')" is actionable — the system knows exactly what to request, from whom, and how to present the question to a human or query a database.

The mechanism that enables this is the three-way evaluation result: `Ok`, `Susp`, and `Err`. Every expression evaluation in Seebo produces one of these three outcomes, and the rules for composing them are what give the engine its suspendable character.

---

## The Three-Way EvalResult

The type definition from `src/eval/evaluator.js`:

```js
/** @typedef {Object} Ok   @property {'Ok'}   kind @property {Value} value */
/** @typedef {Object} Susp @property {'Susp'} kind @property {RequirementDescriptor} need */
/** @typedef {Object} Err  @property {'Err'}  kind @property {Diagnostic} diagnostic */
/** @typedef {Ok | Susp | Err} EvalResult */
```

The three constructors:

```js
function ok(value)      { return { kind: 'Ok',   value }; }
function susp(need)     { return { kind: 'Susp', need  }; }
function errDiag(diag)  { return { kind: 'Err',  diagnostic: diag }; }
```

Every `evaluate(expr, ctx) → EvalResult` call returns exactly one of these. The consumer switches on `kind` to decide what to do. The entire evaluator is built around this three-state discipline.

---

## What Each Outcome Means

**Ok(value)**: the expression evaluated to a concrete typed `Value`. The caller can use this value immediately for further computation.

**Susp(need)**: the expression encountered an unsatisfied `require()` call. The `need` field is the `RequirementDescriptor` from that call. The evaluator cannot produce a value right now because a datum is missing. This is not an error; it is a deferral. The caller collects these needs and returns them in the `pending` set.

**Err(diagnostic)**: the expression encountered a genuine problem: a type error (adding a string to an integer), a division by zero, an undefined identifier, an unknown function name. The `diagnostic` field carries the error code, message, and source position. Unlike `Susp`, this is not recoverable by providing more data — the template logic itself has a problem.

The difference between `Susp` and `Err` is the difference between "I don't have what I need" and "what I need is wrong." A suspended evaluation can resume when data arrives. A failed evaluation requires fixing the template.

---

## Propagation Rules

The rules for how `Ok`, `Susp`, and `Err` propagate through composite expressions are the heart of the suspendable model.

**Err propagates upward immediately** (with one exception discussed below). If any subexpression produces `Err`, the containing expression propagates the error. There is no "catch" mechanism inside the evaluator for semantic errors — type errors and other evaluation failures abort the current formula.

**Susp propagates upward, accumulating.** If a subexpression produces `Susp`, the containing expression propagates `Susp`. But crucially, the evaluator continues evaluating other independent subexpressions before returning `Susp`. This "batch collection" is what allows the engine to discover multiple needs in a single pass:

```js
// evalBinary for non-lazy operators:
const l = evaluate(e.left,  ctx);
const r = evaluate(e.right, ctx);
if (l.kind === 'Err') return l;
if (r.kind === 'Err') return r;
if (l.kind === 'Susp') return l;
if (r.kind === 'Susp') return r;
return tryApply(() => applyBinary(e.op, l.value, r.value), e);
```

Both `left` and `right` are evaluated even if `left` is `Susp`. The `Susp` need from `left` is recorded in `ctx.needs` (via `susp(d)` → `ctx.needs.set(d.id, d)`). After full document evaluation, all collected needs are in `ctx.needs` and become `state.pending`. This means a single evaluation pass can discover all phase-1 requirements at once, rather than requiring one pass per requirement.

**Multiple Susp results accumulate in a map.** The `needs` field in `EvalContext` is a `Map<string, RequirementDescriptor>`. When `susp(d)` is returned, the side effect is `ctx.needs.set(d.id, d)`. Because it is a `Map` keyed by `id`, if the same requirement appears multiple times in the template (in different formula slots, or in both branches of a ternary — though lazy evaluation prevents the latter), it is counted only once.

---

## Lazy Evaluation Semantics

Not all operators evaluate both operands. Lazy operators evaluate only the branches they need, which is what creates requirement phases.

### and

```js
function evalLogical(e, ctx) {
  const l = evaluate(e.left, ctx);
  if (l.kind !== 'Ok') return l;
  if (l.value.type !== 'bool')
    return err(DiagnosticCode.TYPE_ERROR_RUNTIME, e, `'${e.op}' expects bool`);
  const leftBool = l.value.value;
  if (e.op === 'and' && !leftBool) return ok(makeBool(false));  // short-circuit
  if (e.op === 'or'  && leftBool)  return ok(makeBool(true));   // short-circuit
  const r = evaluate(e.right, ctx);
  if (r.kind !== 'Ok') return r;
  if (r.value.type !== 'bool')
    return err(DiagnosticCode.TYPE_ERROR_RUNTIME, e, `'${e.op}' expects bool`);
  return ok(r.value);
}
```

If the left operand of `and` evaluates to `Ok(false)`, the right operand is never evaluated. Any `require()` in the right operand emits no Need. This is correct: if the condition is false, the right operand's value does not matter.

### or

If the left operand of `or` evaluates to `Ok(true)`, the right operand is never evaluated. No Need is emitted from the right.

### ?? (nullish coalesce)

```js
function evalCoalesce(e, ctx) {
  const l = evaluate(e.left, ctx);
  if (l.kind !== 'Ok') return l;
  if (!isEmpty(l.value)) return l;     // left is non-empty: right is skipped
  return evaluate(e.right, ctx);
}
```

If the left operand evaluates to a non-empty value, the right operand is never evaluated. If the left operand is empty (empty string, empty array, empty object), the right is evaluated.

The `isEmpty` definition: `string '' → empty`, `array [] → empty`, `object {} → empty`. The values `0`, `false`, and a zero-duration are explicitly NOT empty. This distinguishes Seebo's "empty" concept (missing or absent data) from JavaScript's "falsy" concept (which includes 0 and false).

### ?: (ternary)

```js
function evalTernary(e, ctx) {
  const c = evaluate(e.cond, ctx);
  if (c.kind !== 'Ok') return c;
  if (c.value.type !== 'bool')
    return err(DiagnosticCode.TYPE_ERROR_RUNTIME, e, 'ternary condition must be bool');
  return c.value.value ? evaluate(e.then, ctx) : evaluate(e.else, ctx);
}
```

Only the taken branch is evaluated. This is the most direct form of phased evaluation: if the condition depends on a phase-1 requirement, the other branch's requirements are never emitted until the condition is known.

### match (desugared)

Since `match` desugars to nested ternaries at parse time, it inherits the ternary's lazy evaluation. Each arm's result expression is only evaluated if its condition tests true. A `match` construct over a phase-1 requirement can therefore gate phase-2 requirements in different arms.

---

## Why Deterministic Evaluation Matters

The suspendable model requires that re-evaluation with the same resolved values always produces the same result. Concretely:

- `run(state)` → `newState`. If `newState.status === 'waiting'`, the driver resolves some needs and calls `run(state')`. The pending set in `newState'` must be predictable from `state'`.
- If re-evaluation were non-deterministic — if the set of emitted Needs could vary on identical inputs — the driver could loop forever, or miss requirements, or emit different requirements each time.

Seebo achieves determinism through several design choices:

1. **No randomness in the evaluator core.** The `clock` function (used by `now()`) is injected via `ctx.clock`, which is overridable for testing. The RNG seed is reserved but unused in v1.

2. **Frozen, immutable values.** Values cannot be mutated between passes. The same `resolved` map always produces the same outputs.

3. **Pure function evaluation.** `evaluate(expr, ctx)` has no external dependencies beyond `ctx`. Two calls with equal `expr` and equal `ctx` produce equal results.

4. **Fixed lazy-evaluation rules.** Which branches are evaluated is determined entirely by the values in `ctx.resolved`. The same resolved set → same branches taken → same needs emitted.

---

## No I/O Inside the Evaluator

This invariant is absolute. The `evaluate` function and all functions it calls (`applyBinary`, `applyUnary`, `applyMethod`, etc.) perform no I/O: no network calls, no file reads, no database queries, no `console.log`. The `clock` function is the only external input, and it is injected explicitly.

The practical consequence is that the evaluator is a pure mathematical function. You can test it by constructing an AST and a `resolved` map and calling `evaluateDocument`. The output is deterministic, testable, and mockable. No async machinery is needed.

The reason this matters: the evaluator is called in a loop by the driver. If the evaluator performed I/O, that I/O would be duplicated on every re-evaluation pass. A capability query that should happen once (one network request to the CRM) would happen once per re-evaluation. The architecture prevents this by confining all I/O to the driver, which is called between evaluator passes, not inside them.

---

## The Evaluator Context

The `EvalContext` is the evaluator's "world" — everything it knows during a single pass:

```js
/**
 * @typedef {Object} EvalContext
 * @property {Record<string, unknown>} resolved   Satisfied values, by id.
 * @property {Map<string, { kind: string, descriptor: RequirementDescriptor }>} symbols
 * @property {Map<string, RequirementDescriptor>} needs  Active Needs collected so far.
 * @property {import('../index.js').EngineConfig} [config]
 * @property {() => Date} clock
 * @property {number} [steps]         Current step count for this pass.
 * @property {number} [maxSteps]      Step budget for the pass.
 */
```

**`resolved`**: the set of values already known. This is the state from `state.resolved`, a plain object keyed by requirement id. It is read-only during a pass (the evaluator does not add to it; the driver does that between passes).

**`symbols`**: the static symbol table collected from the AST before evaluation begins. It maps every declared `require()` and `var()` id to its descriptor. This is built once per AST by `collectDeclarations` and memoized:

```js
const DECL_CACHE = new WeakMap();
export function collectDeclarations(ast) {
  const cached = DECL_CACHE.get(ast);
  if (cached) return cached;
  // ... scan all branches statically ...
  DECL_CACHE.set(ast, table);
  return table;
}
```

The static collection is all-branches: it walks the entire AST regardless of which branches would be taken at runtime. This means the symbol table contains every possible requirement, even those in branches that will never execute in a given run. This is correct for the semantic model where a name is "visible" everywhere in the template, as specified.

**`needs`**: a `Map<string, RequirementDescriptor>` accumulating the Needs emitted during this pass. It is writable by the evaluator: `ctx.needs.set(d.id, d)`. After the pass, its values become `state.pending`.

**`clock`**: a function returning the current time. Used by `now()`. Injected so tests can freeze time.

---

## Step Counting and Resource Limits

The evaluator maintains a step counter:

```js
export function evaluate(expr, ctx) {
  if (ctx.maxSteps !== undefined &&
      (ctx.steps = (ctx.steps ?? 0) + 1) > ctx.maxSteps) {
    return err(
      DiagnosticCode.STEP_LIMIT_EXCEEDED, expr,
      `evaluation exceeded maxSteps (${ctx.maxSteps})`, { limit: ctx.maxSteps }
    );
  }
  // ...
}
```

Every call to `evaluate` increments `ctx.steps`. If the count exceeds `maxSteps` (default 1,000,000), the evaluator returns `Err(STEP_LIMIT_EXCEEDED)` rather than looping forever. This protects against pathological templates: deeply recursive function calls via user-defined functions, exponentially branching match expressions, or other constructs that could exhaust the step budget.

The parser enforces complementary limits:
- `maxNodes`: total AST node count (default 50,000).
- `maxNestingDepth`: maximum expression nesting (default 200), preventing stack overflow during parsing.

Together these limits ensure the engine terminates on any input, regardless of the template's structure.

---

## Worked Examples

### Suspended Requirement: Need Emitted, Not Error

Template: `Dear ${require({ id: 'name', capability: 'user', type: string() })}`

State: `resolved = {}` (name not yet provided).

The evaluator reaches the `Formula` node. It calls `evaluate(Call{callee:'require',...}, ctx)`. Inside `evalCall`, `extractRequirement` reads the descriptor. `resolveRequirement` checks `ctx.resolved`: no `'name'` key. No default. Not optional. So:

```js
ctx.needs.set('name', descriptor);
return susp(descriptor);
```

The formula slot evaluates to `Susp`. `evaluateDocument` detects it:

```js
} else if (node.kind === 'Formula') {
  const res = evaluate(node.expr, ctx);
  if (res.kind === 'Ok') output += toText(res.value, ...);
  else if (res.kind === 'Err') {
    return { status: 'failed', pending: [], diagnostics: [res.diagnostic] };
  }
  // Susp: recorded in ctx.needs; slot stays a hole this pass.
}
```

The `Susp` result means the slot produces nothing in the output this pass. After processing all nodes, `ctx.needs` has `{ name: descriptor }`. The function returns:

```js
{ status: 'waiting', pending: [descriptor] }
```

The engine transitions to `waiting`. The driver calls the `user` capability. The user provides `'Alice'`. The driver adds `{ name: string('Alice') }` to `resolved` and re-runs.

On the second pass, `ctx.resolved.name` exists. `resolveRequirement` returns `ok(string('Alice'))`. The formula slot renders `'Alice'`. The output is `'Dear Alice'`. Status: `completed`.

### Ternary Gates a Requirement

Template:
```
${ isVip ? require({ id: 'vipCode', capability: 'crm', type: string() }) : 'Standard' }
```

State (phase 1): `resolved = { isVip: bool(true) }`.

`evalTernary` evaluates the condition: `Ref('isVip')` → `ok(bool(true))`. The condition is true. The then-branch is evaluated: `require({id:'vipCode',...})` → not in resolved → `Susp(need{id:'vipCode'})`.

The else-branch (`Lit('Standard')`) is never evaluated. No Need for any else-branch requirement is emitted.

State (phase 2): `resolved = { isVip: bool(true), vipCode: string('VIP-GOLD') }`.

`evalTernary` condition → true. Then-branch → `ok(string('VIP-GOLD'))`. Output: `'VIP-GOLD'`.

If the state had been `isVip: bool(false)`, the then-branch would never be evaluated in any pass. `vipCode` would never appear in `pending`. The CRM would never be called for it. This is the "requirement phase" effect: gating behind a ternary means the requirement only becomes active when the condition is known and true.

### and Short-Circuit

Template:
```
${ isReady and require({ id: 'data', capability: 'backend', type: string() }) }
```

State: `resolved = { isReady: bool(false) }`.

`evalLogical` for `and`: left → `ok(bool(false))`. Left is false. Short-circuit: return `ok(bool(false))`. The `require` call is never evaluated. No Need is emitted for `data`.

State: `resolved = { isReady: bool(true) }`.

Left → `ok(bool(true))`. Not short-circuited. Right → `require({id:'data',...})` → not in resolved → `Susp(need{id:'data'})`. Need is emitted.

### or Short-Circuit

Template:
```
${ cached or require({ id: 'fresh', capability: 'backend', type: string() }) }
```

State: `resolved = { cached: bool(true) }`.

`evalLogical` for `or`: left → `ok(bool(true))`. Left is true. Return `ok(bool(true))`. Right never evaluated. No Need for `fresh`.

### ?? Coalesce

Template:
```
${ nickname ?? require({ id: 'fullName', capability: 'crm', type: string() }) }
```

State: `resolved = { nickname: string('Ali') }`.

`evalCoalesce`: left → `ok(string('Ali'))`. `isEmpty(string('Ali'))` → false (`'Ali'` is not `''`). Return `ok(string('Ali'))`. Right never evaluated.

State: `resolved = { nickname: string('') }`.

`evalCoalesce`: left → `ok(string(''))`. `isEmpty(string(''))` → true. Evaluate right: `require({id:'fullName',...})` → `Susp(need{id:'fullName'})`.

### Runtime Type Error: Other Segments Continue

Template:
```
Name: ${name}
Total: ${price + qty}
```

State: `resolved = { name: string('Alice'), price: string('10.00'), qty: int(3) }`.

The `Text` node for `Name: ` is emitted directly. The `Formula` for `${name}` evaluates to `ok(string('Alice'))` → `'Alice'`.

The `Formula` for `${price + qty}`: `applyBinary('+', string('10.00'), int(3))` → throws `SeeboError(type error in '+': no implicit coercion between string and int)` → `errFrom(ex, node)` → `Err(diagnostic)`.

In `evaluateDocument`:
```js
else if (res.kind === 'Err') {
  return { status: 'failed', pending: [], diagnostics: [res.diagnostic] };
}
```

The evaluation of the whole document fails. Status: `failed`. Note that this is a fatal failure for the document, not just for the slot: `status: 'failed'` means the document cannot complete.

---

## Connection to Operational Semantics

Operational semantics is a formal way of describing what programs do, as opposed to what they mean abstractly. The "small-step" operational semantics describes a program as a state machine where each step reduces one computation to a simpler one: `eval(1 + 2) → eval(3)`. The "big-step" (or natural) semantics describes evaluation as a relation `expr ⇓ value`, meaning "expression evaluates to value in one big conceptual step."

Seebo's evaluation sits closer to big-step semantics: `evaluate(expr, ctx) → EvalResult` is a function call that returns in one invocation, without exposing intermediate states. But the suspension model introduces a three-way outcome that is not standard in big-step presentations: the `Susp` outcome means "this expression has no value yet, but here is the blocking requirement."

More precisely, Seebo's evaluation rule for a suspended requirement is:

```
ctx.resolved does not contain id
type has no default
optional is false
---
evaluate(require({id,...}), ctx) ⟶ Susp(need{id})
  and ctx.needs is updated: ctx.needs[id] = need{id}
```

The entire document evaluation is then a function from `(ast, resolved)` to `(output | Susp(needs) | Err(diag))`. The driver loop is the "big-step" orchestrator that repeatedly calls this function, augmenting `resolved` until the output is `completed`.

This is structurally analogous to cooperative multitasking: each evaluation pass is a "time slice" that runs until it blocks (on missing data) or completes. The driver is the scheduler that provides missing data and resumes. The difference from threads is that there is no stack to save: Seebo uses full re-evaluation (v1 strategy), so each pass starts fresh from the AST. There are no continuation frames.

---

## Conclusion

Seebo's suspendable evaluator transforms the problem of missing data from an error into a protocol. The three-way `EvalResult` — `Ok`, `Susp`, `Err` — makes the distinction between "data not yet available" and "expression is wrong" explicit and structural. Propagation rules batch multiple needs from a single pass. Lazy evaluation semantics — for `and`, `or`, `??`, and ternary — gates requirements behind conditions, enabling phased resolution where phase-2 requirements are only emitted after phase-1 values are known.

The evaluator is pure, synchronous, and I/O-free. It is a function of its AST and its resolved map. Re-evaluation is safe because values are immutable and operations are deterministic. Step counting prevents infinite loops. The driver is the only async layer, and it remains cleanly separated from evaluation logic.

This architecture is what allows Seebo to serve as both a document generation engine (single-pass, all values pre-loaded) and an interactive multi-turn workflow engine (multi-pass, values arriving from human input and capability providers) without any architectural compromise in either direction.

---

## Further Reading

- `src/eval/evaluator.js` — the complete suspendable evaluator: `evaluate`, `evaluateDocument`, `createEvaluator`, and all helper functions.
- `src/eval/operators.js` — pure operator implementations, including the temporal algebra and the `isEmpty` predicate.
- `src/eval/symbols.js` — static symbol collection and requirement extraction.
- `src/run/run.js` — the pure state machine wrapping the evaluator: `start`, `run`.
- `src/driver/async_driver.js` — the async driver loop: `drive`, `stebo`, `resolvePending`.
- Plotkin, G.D., "A Structural Approach to Operational Semantics," DAIMI FN-19, 1981. The foundational paper on structural operational semantics.
- Felleisen and Friedman, *The Little Typer* and *Programming Languages and Lambda Calculi* — accessible introductions to reduction semantics.
- The concept of algebraic effects and effect handlers in programming language theory provides the most principled account of what suspension is: a `require()` is an "effect" and the driver is the "handler."

---

Here are the five complete articles, each grounded in the actual source code of Seebo.

**Article 05 — Parsing Expressions** covers the two-tier parser design (recursive descent for document structure, Pratt/precedence-climbing for expressions), the full `PRECEDENCE` table from `parser.js`, how `parseExpr` uses `minBinding` to handle left vs. right associativity, the `match`-to-ternary desugaring including the `nonExhaustiveMatch` marker and `coversClosedDomain`, and four worked examples with full AST structures.

**Article 06 — Runtime Value Model** explains the `{ type, value, format, constraints }` record design, all eight canonical representations with their factory validation code, the `fromJs` inference rules and their deliberate conservatism (strings are never auto-parsed as datetimes), the full temporal arithmetic algebra from `operators.js`, and the `sanitizeJson` security story including `__proto__` handling and `Object.defineProperty`.

**Article 07 — Type Builders and Constraints** explains the builder vs. value distinction, the `make(state)` closure pattern that makes every builder call return a new frozen builder, how the `makeTypeConstructor` dual-semantics design works (`T()` = builder, `T(value)` = value), constraint enforcement at resolution time via the driver, and the `array().constraints({ values: [...] })` enum pattern. It ends with an explicit accounting of what the type system deliberately does not do.

**Article 08 — Requirements and Capabilities** covers the full `RequirementDescriptor` structure, the four `ProviderOutcome` values and their handling in `callProvider`, resolution precedence (pre-resolved → default → optional empty → Susp), the `stopOn` mechanism for multi-turn interactive workflows, and why capabilities must not be pure functions. Four concrete worked examples (user input, CRM lookup, secrets vault, environment variables) are included.

**Article 09 — Suspendable Evaluation** is the deepest article. It explains the `Ok | Susp | Err` three-way result type, the propagation rules (Err short-circuits, Susp accumulates in `ctx.needs`), and the lazy evaluation semantics for all five lazy operators (`and`, `or`, `??`, ternary, and match-as-ternary) with actual evaluator code. It covers the evaluator context structure, step counting, and closes with a connection to operational semantics framing suspension as a cooperative scheduling protocol.
