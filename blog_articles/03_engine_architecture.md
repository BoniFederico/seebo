# Engine Architecture: A Pipeline of Pure Transformations

## Table of Contents

1. [The Pipeline at a Glance](#the-pipeline-at-a-glance)
2. [Stage by Stage: What Each Box Does](#stage-by-stage-what-each-box-does)
   - [EXPAND: The Macro Pre-pass](#expand-the-macro-pre-pass)
   - [TOKENIZE: The Linear Lexer](#tokenize-the-linear-lexer)
   - [PARSE: Recursive Descent and Pratt Climbing](#parse-recursive-descent-and-pratt-climbing)
   - [VALIDATE: Static Diagnostics](#validate-static-diagnostics)
   - [ANALYZE: The Compiler Pass](#analyze-the-compiler-pass)
   - [RUN: The Suspendable Evaluator](#run-the-suspendable-evaluator)
   - [FINALIZE: The Layout Post-pass](#finalize-the-layout-post-pass)
3. [Module Boundaries and the Source Layout](#module-boundaries-and-the-source-layout)
4. [Pure Core vs. Impure Outer Layer](#pure-core-vs-impure-outer-layer)
5. [Synchronous Core, Asynchronous Driver](#synchronous-core-asynchronous-driver)
6. [Why Purity Improves Testing](#why-purity-improves-testing)
7. [Why Resumability Uses State, Not Continuations](#why-resumability-uses-state-not-continuations)
8. [Why Full Re-evaluation Is Acceptable in v1](#why-full-re-evaluation-is-acceptable-in-v1)
9. [The Façade Pattern: createEngine](#the-façade-pattern-createengine)
10. [Data Flow Between Stages](#data-flow-between-stages)
11. [Conclusion](#conclusion)
12. [Further Reading](#further-reading)

---

## The Pipeline at a Glance

Seebo processes a template through a sequence of transformations. Each transformation takes a well-defined input type and produces a well-defined output type. No stage reaches backward to modify a previous stage's output. No stage performs I/O except the driver layer at the outermost level.

```
Raw Template String
        │
        ▼
  ┌─────────────┐
  │   EXPAND    │  macro pre-pass (ABSORB / MERGE)
  └─────────────┘
        │  composed template string
        ▼
  ┌─────────────┐
  │  TOKENIZE   │  O(n) linear lexer → token stream
  └─────────────┘
        │  Token[]
        ▼
  ┌─────────────┐
  │    PARSE    │  recursive descent + Pratt → frozen AST
  └─────────────┘
        │  Document (AST)
        ├──────────────────────────────────────┐
        ▼                                      ▼
  ┌─────────────┐                      ┌─────────────┐
  │  VALIDATE   │  static diagnostics  │   ANALYZE   │  requirement graph
  └─────────────┘                      └─────────────┘
        │  Diagnostic[]                        │  Analysis
        │                                      │
        └──────────────┬───────────────────────┘
                       │
                       ▼
  ┌─────────────────────────────────────────────────┐
  │                    RUN                          │
  │  suspendable evaluator (pure, sync)             │
  │  state machine: Running → Waiting → Completed   │
  └─────────────────────────────────────────────────┘
        │  PublicState { status, output, pending, ... }
        ▼
  ┌─────────────┐
  │  FINALIZE   │  macro post-pass (REMOVE_LINE / COLLAPSE / ...)
  └─────────────┘
        │
        ▼
  Output string + Pending Needs + Diagnostics
```

VALIDATE and ANALYZE are independent passes over the AST — they can run in either order or in parallel. In practice, both are typically called at template development time (to catch errors and understand the dependency structure) rather than at template execution time (where only RUN is called). The separation is reflected in the public API: `engine.validate(template)`, `engine.analyze(template)`, and `engine.run(state)` are independent methods.

---

## Stage by Stage: What Each Box Does

### EXPAND: The Macro Pre-pass

The EXPAND stage handles aggregator macros: `@{ ABSORB('name') }` and `@{ MERGE('pattern', separator) }`. Its purpose is to compose multiple template sources into a single flat string before the lexer and parser run.

ABSORB replaces itself with the full text of the named template, looked up in the `templates` map:

```
@{ ABSORB('email_header') }

Hello, ${ require({ id: 'name', type: { type: 'string' }, capability: 'user' }) }.

@{ ABSORB('email_footer') }
```

becomes (approximately):

```
From: no-reply@example.com
Subject: Hello

Hello, ${ require({ id: 'name', type: { type: 'string' }, capability: 'user' }) }.

Unsubscribe: example.com/unsubscribe
```

MERGE matches all template names against a glob pattern and concatenates them with a separator:

```
@{ MERGE('clause_*', '\n\n') }
```

This is useful for assembling documents from many named fragments.

The EXPAND stage is implemented in `src/macros/expand.js`. It is the only stage that is async by signature (to support future asynchronous template sources), but with in-memory templates it completes synchronously. It enforces two safety properties: a maximum inclusion depth (`maxDepth`, default 20) to prevent stack overflow, and a cycle detector that raises `INCLUSION_CYCLE` if a template eventually includes itself through a chain of ABSORB calls.

### TOKENIZE: The Linear Lexer

The TOKENIZE stage reads the composed template string and produces a flat array of `Token` objects. Each token has a `kind` (one of the `TokenType` values), a `start` offset, and an `end` offset — both inclusive start and exclusive end, measured in characters from the beginning of the string.

The lexer operates in a single left-to-right pass without backtracking. It maintains a simple state: it is either in "text context" (scanning verbatim text between slots) or "slot context" (scanning tokens inside a `${ }`, `#{ }`, or `@{ }` slot). A small integer counter tracks brace depth inside slots so that a nested object literal like `{ key: { inner: 1 } }` does not prematurely close the slot at the inner `}`.

The lexer never throws. Errors (unterminated strings, unclosed slots, unexpected characters) are reported through an `onError` callback if provided, and scanning continues past the error. This error tolerance means that even a malformed template can be partially tokenized, which is useful for editor tooling that wants to provide completions and diagnostics even in the presence of incomplete expressions.

The lexer is implemented in `src/lexer/lexer.js`. The `TokenType` enum (the list of valid `kind` values) is defined in `src/lexer/tokens.js` and is a separate public contract.

### PARSE: Recursive Descent and Pratt Climbing

The PARSE stage consumes the token stream and produces a `Document` AST (abstract syntax tree). The `Document` is a root object with a `nodes` array; each node is a `Text`, `Formula`, `Comment`, or `Macro` node. `Formula` nodes contain an `expr` subtree representing the expression inside the slot.

The parser uses two strategies. The document-level structure (the sequence of text nodes and slot nodes) is handled by simple predictive parsing: look at the current token, dispatch to the appropriate production rule. The expression grammar inside formula slots is more complex — operators have precedence and associativity, and expressions nest arbitrarily — so it uses Pratt precedence climbing. Both strategies are discussed in detail in Article 05.

The parser also handles desugaring at parse time. The `match` expression:

```
status match { 'a' => 1, 'b' => 2, * => 3 }
```

is transformed into nested ternaries before the AST is returned:

```
(status == 'a') ? 1 : (status == 'b') ? 2 : 3
```

All downstream phases — validate, analyze, run — see only ternary nodes. They never see `match` nodes. The exhaustiveness analysis happens at parse time: the outermost ternary in the desugared form carries a `nonExhaustiveMatch` property if the match had no `*` arm and did not provably cover a closed domain (the only provably closed domain in v1 is `bool`, where arms for both `true` and `false` constitute full coverage).

The capability sugar desugaring also happens at parse time: `crm({ id: 'x', type: ... })` is converted to `require({ id: 'x', type: ..., capability: 'crm' })` if `crm` is a registered capability name.

The parser enforces resource limits: `maxNodes` (default 50,000 AST nodes) and `maxNestingDepth` (default 200 levels of expression nesting). Both are checked inline during parsing and cause the parser to throw a `SeeboError` if exceeded.

All AST nodes are frozen (`Object.freeze`). They are immutable POJOs that can be shared across passes and serialized to JSON without concern for mutation.

The parser is implemented in `src/parser/parser.js`. The AST node type definitions are in `src/ast/nodes.js`.

### VALIDATE: Static Diagnostics

VALIDATE operates on the AST (obtained by calling the parser) and returns an array of `Diagnostic` objects. It does not throw; all errors, including parse errors, are caught and surfaced as diagnostics. An empty array means the template is valid.

The validator builds a symbol table from the AST (`collectDeclarations` from `src/eval/symbols.js`), then walks the AST to check:

- **UNDECLARED_NAME**: a `Ref` node references a name not in the symbol table
- **UNKNOWN_FUNCTION**: a `Call` node references an unknown producer
- **UNKNOWN_CAPABILITY**: a `require` call cites a capability not in the engine config
- **POLICY_FORBIDDEN**: a type, function, or capability is excluded by the policy allowlists
- **NON_EXHAUSTIVE_MATCH**: a desugared ternary has the `nonExhaustiveMatch` marker set
- **UNKNOWN_METHOD**: a method call uses a method not defined for the statically inferred receiver type
- **ARITY_MISMATCH**: a function or method is called with the wrong number of arguments
- **TYPE_ERROR**: an operator receives operands of wrong types, provable from static information

The last three diagnostics depend on a conservative type inferencer (`src/validate/infer.js`). The inferencer propagates type information through expressions, using `'unknown'` for any type that cannot be determined statically. When the inferencer returns `'unknown'`, the corresponding check is suppressed: no false positives are emitted. When it returns a known type, the check can be applied.

### ANALYZE: The Compiler Pass

ANALYZE is the most sophisticated static pass. It produces an `Analysis` object with the following fields:

- `requirements`: all requirements declared in the template, with their phase number
- `requirementGraph`: the directed graph of dependencies between requirements (an edge A → B means B is in a branch gated on A)
- `executionPlan`: the requirements grouped by phase, in phase order
- `capabilitiesUsed`: the distinct capability names referenced by the template
- `staticValues`: expressions computable without any capability invocation
- `deterministic`: whether the template uses non-deterministic producers (`now()`, `fake.*`)
- `streamability`: whether the template can be streamed or must be buffered
- `potentialCycles`: cycles detected in the requirement graph
- `maxPhases`: the upper bound on the number of execution phases needed

The requirement graph is built by walking the AST and tracking which requirement IDs govern each position. An ID `A` governs position `P` if `P` is inside a conditional branch whose condition references `A`. A requirement at position `P` has an edge from every governing ID to its own ID.

The phase of a requirement is its depth in the longest chain of governing requirements. Phase 1 requirements depend on no other requirements. Phase 2 requirements depend on at least one phase 1 requirement. And so on.

This computation is a longest-path algorithm over a directed graph. Seebo implements it with memoized recursion and a visited-set cycle detector:

```javascript
const phaseOf = (id, stack) => {
  const cached = phaseMemo.get(id);
  if (cached !== undefined) return cached;
  const gids = governing.get(id) ?? [];
  if (stack.has(id)) { potentialCycles.push({ nodes: [...stack, id] }); return 1; }
  stack.add(id);
  let max = 0;
  for (const g of gids) {
    const gp = reqIds.has(g) ? phaseOf(g, stack) : 1;
    if (gp > max) max = gp;
  }
  stack.delete(id);
  const p = 1 + max;
  phaseMemo.set(id, p);
  return p;
};
```

The result is an execution plan that can be inspected before any capability invocation and used to drive UI flows, predict the number of network round-trips, or present a progress indicator to the user.

### RUN: The Suspendable Evaluator

RUN is the heart of the engine. It takes a `PublicState` (or a template string, from which it derives an initial state) and returns a new `PublicState`.

The state machine has four logical states:
- **Running**: initial state; `run` has not yet been called
- **Waiting**: evaluation suspended; `pending` contains the unmet requirements
- **Completed**: all requirements satisfied; `output` contains the rendered string
- **Failed**: an unrecoverable error; `diagnostics` describes the failure

Each call to `run(state, config)` increments the phase counter, re-parses the template (in v1, full re-parse on every call), and calls `evaluateDocument`. The evaluator walks the AST, maintaining a context with:
- `resolved`: the current map of satisfied requirement IDs to values
- `symbols`: the static symbol table for the template
- `needs`: a `Map` accumulating unmet requirements discovered during this pass
- `clock`: the current time source (injectable for deterministic testing)
- `steps`: a counter enforcing `maxSteps` per pass

For each `Formula` node, the evaluator calls `evaluate(expr, ctx)`, which returns an `EvalResult`: either `Ok(value)`, `Susp(need)`, or `Err(diagnostic)`. The full three-way return type propagates naturally through the expression tree. Lazy operators short-circuit: `and` does not evaluate its right operand when the left is false; `??` does not evaluate its right operand when the left is non-empty; ternary evaluates only the taken branch.

When all formula slots produce `Ok` results, the evaluator assembles the output string (text nodes contribute their literal text, formula nodes contribute the stringified value) and returns `{ status: 'completed', output }`.

When any formula slot produces `Susp`, the need is recorded in `ctx.needs`. After the full pass, if `ctx.needs` is non-empty, the evaluator returns `{ status: 'waiting', pending: [...ctx.needs.values()] }`.

When any formula slot produces `Err`, the evaluator returns `{ status: 'failed', diagnostics: [diag] }` immediately.

The `PublicState` is a plain POJO. It contains the template source, the resolved map, the pending needs, the phase counter, and the status. It has no functions, closures, or non-serializable references. It can be serialized to JSON, stored in a database, and deserialized in a future run.

### FINALIZE: The Layout Post-pass

FINALIZE operates on the already-rendered text string (the `output` field of a completed `PublicState`). It finds layout macro markers — `@{REMOVE_LINE}`, `@{COLLAPSE}`, `@{REMOVE_LEFT(n)}`, `@{REMOVE_RIGHT(n)}` — and applies their effects.

Markers arrive in the rendered text in two ways: either they were present in the AST as `Macro` nodes with `family: 'layout'`, and the evaluator emitted their `@{NAME}` source literally into the output stream; or they were produced by a formula expression (for example, a conditional expression where one branch is a string that happens to start with `@{`).

The FINALIZE pass scans the text for recognized marker sequences, applying them left-to-right. Each application may remove a portion of the text, so offsets are recomputed after each operation. Unknown `@{...}` sequences (perhaps from user data that happens to look like a macro) are left in place.

After all markers have been processed, if any `COLLAPSE` marker was seen, a final pass collapses runs of three or more blank lines to a single blank line.

---

## Module Boundaries and the Source Layout

The source directory structure maps closely to the pipeline:

```
src/
  lexer/
    lexer.js       -- the tokenize() function
    tokens.js      -- TokenType enum and Token typedef (public contract)
  parser/
    parser.js      -- the parse() function
  ast/
    nodes.js       -- NodeKind, ExprKind, and all AST node typedefs (public contract)
  validate/
    validate.js    -- the validate() function
    infer.js       -- the conservative type inferencer
  analyze/
    analyze.js     -- the analyze() function + Analysis typedef (public contract)
  eval/
    evaluator.js   -- evaluateDocument(), evaluate(), createEvaluator()
    operators.js   -- pure operator implementations (no env, no suspension)
    methods.js     -- pure method implementations
    symbols.js     -- collectDeclarations(), extractRequirement()
  run/
    run.js         -- start(), run() (state machine)
  runtime/
    values.js      -- Value type, all make*() factories, fromJs(), TypeName enum
    stringify.js   -- toText() for value-to-string conversion at emission
    sanitize.js    -- deep sanitization for object and array inputs
    factory.js     -- makeTypeConstructor() for immutable value builders
    registry.js    -- createRegistry(), the extension lookup table
  macros/
    expand.js      -- the EXPAND pre-pass
    finalize.js    -- the FINALIZE post-pass
  driver/
    async_driver.js -- drive(), stebo() -- the ONLY async components
  util/
    errors.js      -- DiagnosticCode, SeeboError, EngineConfigError, createDiagnostic
    limits.js      -- DEFAULT_LIMITS
    versions.js    -- AST_VERSION, STATE_VERSION, ANALYSIS_VERSION, migrations
    vocabulary.js  -- RESERVED_WORDS, BUILTIN_TYPE_NAMES, BUILTIN_MACRO_NAMES, etc.
  index.js         -- createEngine(), builtins, all define*() factories (public façade)
```

The module boundaries are load-bearing. `tokens.js` and `nodes.js` are explicitly labeled as public contracts: their shapes are stable across versions and can be consumed by external tools. The `vocabulary.js` module imports nothing — it cannot, because it is shared by modules that would otherwise form import cycles. The `evaluator.js` separates pure evaluation helpers (in `operators.js` and `methods.js`) from the evaluation context logic.

---

## Pure Core vs. Impure Outer Layer

"Pure" in the functional programming sense means: given the same inputs, always produces the same outputs, with no observable side effects. A pure function does not read from the file system, does not make network calls, does not read environment variables (except through parameters), and does not modify any shared mutable state.

Seebo's core — everything in `src/` except `src/driver/` — is pure in this sense. The lexer, parser, validator, analyzer, evaluator, state machine, and both macro passes are all pure. They take values, compute new values, and return them. They do not call `fetch`, do not read from databases, do not write logs, and do not start timers.

The only "global" state in the core is the in-memory `astCache` (a `WeakMap` in `analyze.js`), which is keyed on the config object and therefore scoped to an individual engine instance. It is a read/write cache, not a side effect that leaks out to callers.

The driver layer (`src/driver/async_driver.js`) is explicitly impure. It makes async calls to capability providers, which may call databases, APIs, or any I/O. The driver is the membrane between the pure world and the real world. Its job is to call providers, classify their responses, and translate results back into inputs for the pure state machine.

This separation has a precise architectural meaning: the `async` keyword appears in exactly one source file in the entire codebase.

---

## Synchronous Core, Asynchronous Driver

JavaScript's concurrency model is event-loop-based. The fundamental unit of asynchrony is the `Promise`. A function that is `async` returns a `Promise` and can `await` other Promises.

Seebo's design decision to confine `async` to the driver layer has several benefits.

First, it makes the core code easier to reason about. Synchronous code does not involve scheduling, microtasks, or the subtleties of `Promise` chaining. The lexer, parser, and evaluator are straightforward sequential procedures.

Second, it makes the core testable without async test utilities. Testing an async function requires `async` test functions, careful handling of rejection, and often test-framework support for async timeouts. Testing a synchronous function requires none of that.

Third, it makes the state machine serializable. A running continuation (a suspended async function) is not serializable. A serializable state POJO is. By making the state machine synchronous and state-based rather than continuation-based, Seebo makes the conversation resumable across process restarts.

Fourth, it makes the core isomorphic: the same synchronous code runs in a browser and in Node.js, without any I/O concerns. The driver, which does I/O, is naturally Node.js-specific (or at least network-specific).

---

## Why Purity Improves Testing

The practical consequence of a pure core is that the test suite for each stage is a set of pure input/output checks.

Testing the lexer:
```javascript
const tokens = tokenize('Hello, ${ name }!');
assert(tokens[0].kind === 'text');
assert(tokens[1].kind === 'slot-open');
// ...
```

No mock objects. No dependency injection. No setup and teardown. The function is called with a string and returns an array. The assertion checks the array.

Testing the parser:
```javascript
const ast = parse(tokens, { source: 'Hello, ${ name }!' });
assert(ast.nodes[0].kind === 'Text');
assert(ast.nodes[1].kind === 'Formula');
// ...
```

Testing the validator:
```javascript
const engine = createEngine({ capabilities: { crm: () => {} } });
const diags = engine.validate('${ unknown_name }');
assert(diags[0].code === 'UNDECLARED_NAME');
```

Testing the evaluator:
```javascript
const state = engine.start(template, { name: 'Alice' });
const result = engine.run(state);
assert(result.status === 'completed');
assert(result.output === 'Hello, Alice!');
```

No mocking of the `crm` capability is needed to test the evaluator with a pre-resolved value. No network stubs are needed. The value is passed in directly through `initialValues`.

---

## Why Resumability Uses State, Not Continuations

A continuation-based approach to resumable evaluation would save the call stack at the point of suspension and restore it when resuming. This is how generators in JavaScript work (`yield`), and it is how coroutines work in languages that support them natively.

Continuation-based resumption has one significant drawback: continuations are not serializable. A JavaScript generator object is a closure over the generator function's local variables at the point of suspension. It cannot be converted to JSON and later restored.

Seebo's state-based approach avoids this problem by design. The state object contains all the information needed to resume:
- The template source (so the engine can re-parse and re-evaluate from scratch)
- The resolved values (so requirements that were satisfied in previous phases do not need to be re-satisfied)
- The pending needs (for diagnostic purposes)
- The phase counter (for progress tracking and the maxPhases limit)
- The status (the current position in the state machine)

When the driver calls `run(state, config)`, it re-evaluates the entire template from the beginning, but with the resolved map already populated with all previously satisfied values. Requirements whose IDs are already in `resolved` return their values immediately; only the requirements not yet satisfied produce `Susp` results.

This full re-evaluation strategy (v1's "strategy 1") is simple, correct, and predictable. It does not require saving any intermediate computation. It is idempotent: calling `run` twice with the same state produces the same result. Its cost is proportional to the template size on each phase, not to the state of the previous phases.

---

## Why Full Re-evaluation Is Acceptable in v1

At first glance, re-parsing and re-evaluating the template on every call to `run` seems wasteful. For a 100-node AST evaluated three times across three phases, the parse step runs three times.

In practice, this is acceptable for several reasons.

First, Seebo templates are documents, not programs. They are text files of reasonable size (kilobytes, not megabytes). The benchmark numbers show that the parser processes a medium-sized template in roughly 3.78ms per operation. Three phases means roughly 11ms of parse time total. For document-generation workflows where the bottleneck is typically network I/O to capability providers, this is negligible.

Second, the `astCache` optimization can eliminate the parse cost entirely. With `optimizations.astCache: true`, the analysis (including parsing) is memoized per `(config, template)` pair. Subsequent calls to `run` with the same template use the cached AST, reducing the parse contribution to approximately 0.0005ms. This is a 3000× speedup for the parse step alone.

Third, full re-evaluation is safe. An incremental evaluation strategy (save intermediate results, only re-evaluate changed parts) would be faster in theory but considerably more complex: it would require tracking which parts of the evaluation depended on which inputs, invalidating cached sub-results when inputs change, and ensuring that the incremental strategy produces the same result as full re-evaluation in all cases. The correctness argument for full re-evaluation is trivially simple: it always produces the correct result because it always starts from scratch.

Full re-evaluation is designated as v1's strategy explicitly in the spec. Future versions could implement incremental evaluation as an optimization without changing the semantics.

---

## The Façade Pattern: createEngine

The public API entry point is `createEngine(config)` in `src/index.js`. It returns an engine object whose methods are closures over the normalized configuration.

```javascript
export function createEngine(config = {}) {
  const registry = createRegistry(config);
  const cfg = { ...normalizeConfig(config), registry };

  const engine = {
    config: cfg,
    tokenize: (template) => _tokenize(template, cfg),
    parse: (template) => _parse(template, cfg),
    validate: (template) => _validate(template, cfg),
    analyze: (template) => _analyze(template, cfg),
    start: (template, initialValues) => _start(template, initialValues, cfg),
    run: (state) => _run(state, cfg),
    expand: (args) => _expand(args, cfg),
    finalize: (text) => _finalize(text, cfg),
    drive: (stateOrTemplate, opts) => _drive(stateOrTemplate, opts, cfg),
    stebo: (args) => _stebo(args, cfg),
  };

  return engine;
}
```

The engine object is a façade. Each method is a thin wrapper that calls the corresponding module-level function with the config pre-bound. The user never needs to pass the config explicitly to each method; it is captured once at engine creation.

This pattern has several advantages:
- The engine can be passed around as a value; it carries its configuration with it.
- Different engines with different configurations can coexist in the same process.
- The module-level functions remain directly testable without going through `createEngine`.
- The engine object is a plain object (not a class instance); it can be inspected and debugged without prototype chain traversal.

`normalizeConfig` fills in all defaults (locale, clock, delimiters, limits, optimizations, policy). `createRegistry` validates all extension definitions (types, functions, macros, libraries) for reserved name conflicts and duplicate registrations, building the lookup tables used by the evaluator and validator.

---

## Data Flow Between Stages

Each stage consumes one data type and produces another. The data types are all plain JavaScript values: strings, arrays, plain objects. No stage passes DOM nodes, streams, event emitters, or other environment-specific objects.

| Stage | Input | Output |
|-------|-------|--------|
| EXPAND | `{ template: string, templates: Record<string,string> }` | `string` (composed template) |
| TOKENIZE | `string` (template) | `Token[]` |
| PARSE | `Token[]` + source `string` | `Document` (AST) |
| VALIDATE | `string` (template) + `EngineConfig` | `Diagnostic[]` |
| ANALYZE | `string` (template) + `EngineConfig` | `Analysis` |
| RUN | `PublicState` + `EngineConfig` | `PublicState` |
| FINALIZE | `string` (rendered text) | `string` (finalized text) |

The `PublicState` deserves particular attention. It is the type that crosses the boundary between engine calls in a multi-turn conversation. Its serializable structure is the reason that conversations can span process restarts.

```typescript
interface PublicState {
  stateVersion: number;
  template: string;
  resolved: Record<string, Value>;
  pending: RequirementDescriptor[];
  phase: number;
  status: 'running' | 'waiting' | 'completed' | 'failed';
  output?: string;
  diagnostics?: Diagnostic[];
}
```

`stateVersion` enables the migration mechanism. When the engine reads a persisted state, it checks the version and either migrates older states forward or rejects states from future engine versions.

---

## Conclusion

Seebo's architecture is a linear pipeline of pure transformations with a single async layer at the boundary with the external world. Each stage has a clear input type, a clear output type, and no internal mutable state shared with other stages. The separation of the pure core from the impure driver is not accidental; it is the central architectural decision that makes the engine testable without mocks, isomorphic across environments, and serializable across process boundaries.

The full re-evaluation strategy is a deliberate simplicity choice for v1. It is correct by construction, avoids the complexity of incremental evaluation, and is fast enough for the document-generation use case when the astCache optimization is enabled for high-throughput scenarios.

The next article descends into the first pipeline stage in detail: the lexer.

---

## Further Reading

- Odersky, M., Spoon, L., & Venners, B. (2008). *Programming in Scala.* Artima. Chapter on case classes and pattern matching. — Case classes in Scala are a language-level version of the frozen discriminated unions (AST nodes, EvalResult, etc.) that Seebo implements manually in JavaScript.
- Gamma, E., Helm, R., Johnson, R., & Vlissides, J. (1994). *Design Patterns: Elements of Reusable Object-Oriented Software.* Addison-Wesley. The Facade pattern. — Seebo's `createEngine` is a textbook Facade over its module-level functions.
- Hughes, J. (1989). "Why Functional Programming Matters." *Computer Journal* 32(2). — The paper arguing that modularity (the ability to compose independent parts) is the primary practical benefit of functional style; directly relevant to Seebo's pipeline design.
- Mogensen, T.Æ. (2009). *Basics of Compiler Design.* DIKU. — A free textbook covering lexer, parser, type checker, and code generation design; the pipeline structure maps directly to Seebo's stages.
