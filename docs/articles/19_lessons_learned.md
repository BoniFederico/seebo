# Lessons Learned: Building a Typed, Suspendable Template Engine

## Table of Contents

1. [What Worked Well](#1-what-worked-well)
2. [Architectural Principles That Proved Valuable](#2-architectural-principles-that-proved-valuable)
3. [Trade-offs Made](#3-trade-offs-made)
4. [Mistakes to Avoid](#4-mistakes-to-avoid)
5. [Why Specifications Matter](#5-why-specifications-matter)
6. [Why Pure Core Plus Impure Shell Works](#6-why-pure-core-plus-impure-shell-works)
7. [What Could Be Improved](#7-what-could-be-improved)
8. [A Checklist for Building a Similar Engine](#8-a-checklist-for-building-a-similar-engine)
9. [Recommended Learning Path for Readers](#9-recommended-learning-path-for-readers)
10. [Final Reflection](#10-final-reflection)
11. [Conclusion](#conclusion)
12. [Further Reading](#further-reading)

---

## 1. What Worked Well

### Pure core, impure shell

The most successful structural decision in Seebo is the separation of the pure synchronous core from the impure async shell. The lexer, parser, and evaluator have no I/O and no external state. The driver layer, which performs I/O via capability providers, is confined to `src/driver/`. This boundary is not just a convention; it is enforced by the fact that the evaluator's `evaluate()` function signature cannot accept or return a Promise, and the pure state machine `run()` is synchronous.

The payoff is large and multi-dimensional. Unit tests for the evaluator require no mocks, no stubs, no dependency injection — the function is pure, so testing it means calling it with inputs and asserting on outputs. The evaluator can be deployed identically in the browser and on the server because it has no environment dependencies. State serialization is trivial because the state is a plain JSON-compatible object. Reasoning about correctness does not require tracking side-effect history.

### Specification-first development

Writing `SPEC.md` and `IMPL.md` before writing any implementation code paid dividends throughout development. The specification phase forced decisions that implementation-first development would have deferred: what are the operator precedence rules? What happens when a requirement is optional? What does `analyze()` return? These questions have no obvious answers; they require thought. The specification is the artifact that captures that thought.

More practically, the specification provided a basis for the test suite that predates the implementation. Tests written against the spec exercise the intended behavior, not the actual behavior of the current implementation. When the implementation diverges from the spec, the test fails. When the spec is ambiguous, the test is ambiguous — which surfaces the ambiguity before it becomes a bug.

### Three independently versioned public contracts

Seebo exposes three versioned contracts: `astVersion`, `stateVersion`, and `analysisVersion`. These are independent because they change at different rates and for different reasons.

The `stateVersion` changes when the shape of the persisted state changes — when a field is added to `PublicState`, or a field is removed or renamed. The `astVersion` changes when a node kind is added, removed, or restructured. The `analysisVersion` changes when the `Analysis` object's shape changes. These do not happen simultaneously.

If all three were combined into a single version, every change to any of the three would require all consumers to update. The independence allows the AST to change (for example, a new node kind for a new language feature) without requiring the persisted state format to change. Consumers that only use `stateVersion` are unaffected.

### Accumulating diagnostics rather than throwing

The `validate()` function returns an array of `Diagnostic` objects rather than throwing on the first error. This is deliberate and important: it mirrors how compilers work. A compiler that reports only the first error forces the developer to run it repeatedly to discover all errors. A compiler that accumulates errors gives a complete picture in one pass.

In Seebo, a template with three undeclared names, a missing capability, and a non-exhaustive match gets five diagnostics in one `validate()` call. The host can show all five to the template author simultaneously, who can fix them all before re-running.

The implementation separates recoverable from non-recoverable diagnostics. A recoverable diagnostic means the validator continued past the error and may have accumulated more diagnostics. A non-recoverable diagnostic (from `parse()`, which throws) means the structure was too broken to continue.

### Conservative type inferencer

The type inferencer in `validate()` takes a conservative approach: when it cannot determine with certainty that a type error exists, it does not report one. This means false negatives (errors that could be detected but are not) are possible, but false positives (errors reported for valid templates) are not.

For a template engine used by non-programmers, false positives are more damaging than false negatives. A non-programmer who sees an error for a template that would actually run correctly loses trust in the tool. A non-programmer who does not see an error for a template that fails at runtime gets a clear error at run time. Both outcomes are bad, but the false positive erodes confidence in ways that are harder to recover from.

### Resource limits from day one

Every resource limit in Seebo — `maxInputBytes`, `maxTokens`, `maxNodes`, `maxNestingDepth`, `maxSteps`, `maxOutputBytes`, `maxPhases`, `timeoutMs`, `maxDepth` — was designed into the engine from the start, not retrofitted later. The `src/util/limits.js` file was one of the early design artifacts.

Retrofitting limits is notoriously difficult. Code that was not written with limits in mind often has no natural place to check them. Recursive descent parsers that do not track depth cannot easily add a nesting limit later without restructuring the recursion. Evaluators that do not count steps cannot easily add a step limit without touching every evaluation path. Designing limits in from the start means they are integrated naturally at the right points.

### The three-way EvalResult

The `Ok | Susp | Err` result type is a tagged union that cleanly expresses every possible outcome of expression evaluation. The alternative — using exceptions for suspension — would conflate "this expression needs more data" with "this expression encountered an error," both of which involve non-local control flow. Using exceptions for suspension would also make the lazy evaluation model much harder to implement correctly: catching an exception to detect a suspension would interfere with real error handling.

The tagged union forces the evaluator's callers to handle all three cases explicitly. A caller that handles only `Ok` and `Err` but not `Susp` is incomplete and will fail to compile (in TypeScript) or fail at runtime (in JavaScript) when a suspension occurs. The exhaustiveness is self-documenting.

---

## 2. Architectural Principles That Proved Valuable

### Purity as an engineering constraint

Purity is often discussed as a functional programming concept — a philosophical preference for functions without side effects. In Seebo's context, purity is more usefully understood as an engineering constraint that forces design clarity.

When a function is required to be pure, you cannot hide dependency injection in it. The evaluator cannot "just call the database" — it has no way to. It must return a `Susp` result and let the driver handle the database call. This forces the boundary between the engine and the external world to be explicit, typed, and named.

Every piece of external data that flows into the engine must pass through a `require()` call with a declared type and a named capability. Every piece of external action that the engine triggers must be expressed as a capability provider return value that the driver processes. The purity constraint forces you to make these dependencies explicit, which makes the system auditable, testable, and understandable.

### "What can be statically known should be statically known"

The `analyze()` function embodies a principle that proved valuable in design discussions: if a property of the template can be determined without executing it, determine it statically. The execution plan (which requirements appear in which phase) is fully derivable from the AST. The set of capabilities used is fully derivable from the requirement declarations. The determinism flag is derivable from whether `now()` appears in the template.

This principle guided the design of `analyze()` toward being comprehensive. It also guided the design of the type system: if a type mismatch can be detected statically, validate it. If an undeclared name can be detected statically, report it. The more the static analysis can determine, the more helpful the development experience, and the fewer runtime surprises.

### Public contracts are promises

The three versioned public contracts — `astVersion`, `stateVersion`, `analysisVersion` — are promises to callers. Once a public contract is published, changing it silently breaks callers. The correct behavior is to bump the version when the contract changes, provide a migration path for the old version, and give callers time to update.

The `migrateState` function in `src/util/versions.js` implements this migration path. The `migrations` array is currently empty because this is v1 — there is nothing to migrate from. But the infrastructure exists, and when `stateVersion` is bumped to 2, a migration function from 1 to 2 can be added to the array. States persisted with v1 will be automatically migrated. States from v3 (future) will be rejected rather than corrupted.

### The pure core is the safety boundary

Every security property in Seebo traces back to the purity of the core. The pure evaluator cannot make network calls, so a template cannot exfiltrate data. The pure parser cannot execute code, so a template cannot cause arbitrary code execution. Resource limits in the pure core are enforced synchronously, so a template cannot escape them by spawning async work.

The impure shell — capability providers, extension implementations — is where security properties can break down. And this is correct: the impure shell is trusted host code, configured at engine construction time by the application developer. The trust boundary is explicit, not implicit.

---

## 3. Trade-offs Made

### Full re-evaluation versus continuations

Seebo v1 uses full re-evaluation: every time the driver satisfies a batch of needs and calls `run()` again, the entire template is re-evaluated from scratch. The alternative is to save continuation frames — the partial evaluation state at each suspension point — and resume from them rather than starting over.

Full re-evaluation is simpler. There are no continuation structures to serialize, deserialize, or GC. There are no partial states that might be inconsistent. The evaluator always starts with a complete `resolved` map and a complete AST. The cost is that work done in previous phases is repeated.

With the AST cache, the parsing cost is eliminated for repeated calls. The evaluation cost scales linearly with the size of the resolved environment and the number of formula nodes. For typical templates, this cost is acceptable. The simplicity benefit — a stateless, resumable evaluator with no continuation frames — is significant.

### Plain JavaScript with JSDoc versus TypeScript

Seebo is written in plain JavaScript with JSDoc type annotations. The rationale is lower barrier to contribution: JSDoc-annotated JavaScript runs directly in Node without a compilation step. Developers do not need a TypeScript toolchain to contribute. IDEs with TypeScript support can still provide type inference from the JSDoc annotations.

The cost is weaker type safety. JSDoc annotations are not enforced at runtime, and the TypeScript compiler's checking of JSDoc-annotated JavaScript is not as thorough as full TypeScript. Some type errors that TypeScript would catch statically surface only at runtime.

This was a deliberate trade-off for v1. A TypeScript rewrite is possible as a future project; the JSDoc annotations provide a head start by documenting the intended types.

### No streaming in v1

Seebo v1 buffers the complete output before returning it. Streaming output — delivering the beginning of the rendered string before all requirements are satisfied — would reduce perceived latency for long templates. The reason it was deferred is correctness: layout macros (`REMOVE_LINE`, `COLLAPSE`, `REMOVE_LEFT`) require backward-looking edits to already-emitted text. A streaming model would need to buffer at least to the next macro marker before emitting, or require a two-pass approach. Neither is trivial to implement correctly.

The `streamability` field in the `Analysis` object (`full`, `partial`, or `buffered`) was added as a forward-looking design element: it tells the caller whether streaming would be safe for this template. When streaming is implemented, this field provides the information needed to decide whether to use it.

### Conservative inferencer versus Hindley-Milner

The type inferencer in `validate()` is conservative: it infers types where it can, but does not attempt to propagate type information across all possible paths. A Hindley-Milner style algorithm could infer more precise types and detect more errors. For example, it could detect that `${ x + y }` where `x` is declared as `string` and `y` is declared as `int` is a type error, even when `x` and `y` are requirements whose values are not yet available.

The conservative inferencer was chosen because it is simpler to implement and cannot produce false positives. A Hindley-Milner inference algorithm for a language with suspended values and conditional branches is non-trivial to design correctly. The wrong algorithm produces false positives — error reports for templates that would actually run correctly — which are more damaging than false negatives for the target user population.

### Seconds-only duration

Seebo's `duration` type stores values as a number of seconds. This is a clear, unambiguous representation. The alternative — storing as months, weeks, days, hours, minutes, seconds separately — handles calendar durations ("three months from now" means different things in February versus July) but requires calendar arithmetic.

Calendar arithmetic in a distributed system requires timezone information, locale settings, and careful handling of DST transitions. Seebo's template engine is not the right place to implement calendar arithmetic. The seconds-only representation is correct for the durations that template engines actually need: "5 minutes ago," "3 hours remaining," "7 days from now." Calendar durations (months, years) are out of scope for v1.

---

## 4. Mistakes to Avoid

### Skipping the specification phase

The single most valuable practice in Seebo's development was writing the specification before writing code. The temptation to "just start coding" is strong, especially for solo developers or small teams. Resist it. Coding before specifying leads to incoherent behavior: two similar-looking features implemented inconsistently because the pattern was never articulated; edge cases handled differently in different parts of the codebase because no one decided the general rule; public API shapes that don't compose because they were designed one at a time.

A specification does not need to be long. It needs to be precise. A precise specification for a small system is more valuable than a vague specification for a large one. Write the specification, then write the tests, then write the code.

### Adding side effects to the evaluator

If you find yourself thinking "I'll just add a console.log here to debug this," you are on the path to an evaluator with side effects. The correct debug approach for a pure evaluator is to build a trace mode: an optional flag in the evaluation context that records each expression's result in a log structure, returned as part of the evaluation output. The trace is data, not a side effect.

More seriously: do not add external calls to the evaluator. If a new feature requires fetching data from an external system during evaluation, make it a requirement with a capability, not a direct call. The evaluator is the security boundary. Once it can make external calls, that boundary is gone, and with it go the testability, determinism, and safety properties that make the engine trustworthy.

### Implicit type coercion

Implicit type coercion — where `'3' + 5` silently becomes `'35'` or `8` depending on an arbitrary rule — makes static analysis impossible. You cannot detect a type error between `string` and `int` if the engine will coerce one to the other at runtime. You cannot report that `x + y` will fail if `x` is a string and `y` is an int, because it won't fail — it will produce a surprising result.

Seebo requires explicit type conversion: `int('3') + 5` or `string(3)`. This means static analysis can detect `'3' + 5` as a potential type error, because there is no coercion rule that would make it valid. The surface area of surprising behavior is dramatically smaller.

### Letting limits be an afterthought

Resource exhaustion attacks are real and common. A template engine without input size limits, step count limits, and output size limits is vulnerable to denial-of-service attacks from template authors. Implementing limits as an afterthought requires retrofitting checks into code that was not designed for them, which is error-prone and often incomplete. Design limits in from the start, at every phase boundary, with a configurable default.

### Versioning everything together

If you have multiple public contracts — an AST shape, a persisted state format, a static analysis result — version them independently. If you version them together, any change to any one of them requires consuming code to update for all of them, even the ones that didn't change. Independent versioning allows contracts to evolve at their natural pace.

### Building a Turing-complete template language

The instinct to add loops, user-defined functions, and recursion to a template language is understandable. Power is appealing. But for operational templates — documents, emails, request bodies, runbooks — the expressive power of a Turing-complete language is almost never needed. What is needed is conditional logic, string manipulation, arithmetic, and access to typed external data. All of these are available in Seebo without loops or user-defined functions.

A Turing-complete template language cannot be statically analyzed for termination. Resource limits become essential and require careful implementation. The static analysis that enables form generation and wizard steps becomes impossible in general. The security model requires a much more sophisticated sandbox. The price of unlimited power is the loss of the properties that make the engine trustworthy.

---

## 5. Why Specifications Matter

A specification is not documentation. Documentation describes what the implementation does. A specification describes what the implementation *should* do — it is the intended behavior, independent of any particular implementation.

The distinction matters for three reasons.

**The specification enables conformance testing.** Tests written against the specification test whether the implementation conforms to the intent. Tests written against the implementation test whether the implementation behaves consistently with itself — which is always true by definition. Conformance tests catch the difference between "the code is consistent" and "the code is correct."

**The specification enables independent verification.** A second implementation of the same specification can be verified against the same conformance tests. This is useful for security analysis (an independent implementation may catch assumptions that the first missed), for platform migration (switching the engine underneath a platform without breaking templates), and for future contributors who were not present during original design.

**The specification forces edge-case thinking before bugs exist.** Writing "what happens when `or` is used with a suspended left operand?" before implementing `or` forces the answer to be explicit. Once the answer is in the specification, the implementation must conform to it, and the conformance test verifies that. Without the specification, the answer is "whatever the implementation happens to do" — which may change when the implementation is refactored.

---

## 6. Why Pure Core Plus Impure Shell Works

The architecture pattern of pure core plus impure shell appears in many successful systems: Redux's pure reducers plus React's impure rendering layer, Haskell's pure functions plus the `IO` monad, Unix pipes' pure filters plus I/O system calls. It works for a fundamental reason: side effects are hard to reason about, test, and control, so isolating them to a small, well-defined surface minimizes the area where things can go wrong.

In Seebo specifically, this pattern enables four concrete benefits:

**Testing without mocks**: the pure evaluator can be unit tested by calling `evaluate(expr, ctx)` with a constructed `ctx`. No database mock, no HTTP server stub, no file system fake. The test is a pure input-output assertion.

**Isomorphism**: the pure core runs identically in Node.js and in the browser. The driver layer, which uses async I/O, is also available in both environments but can use different capability providers for client-side preview versus server-side authoritative execution.

**Serialization**: the `PublicState` object, which is the only thing that crosses the boundary between the pure core and the driver between phases, is a plain JSON-compatible object. It contains no functions, no Promises, no non-serializable values. It can be stored in a database, transmitted over HTTP, or logged in its entirety.

**Correctness reasoning**: proving that the evaluator is correct (in the informal sense used in engineering) requires reasoning about its behavior for all possible inputs. With side effects, this reasoning must also track all possible external states. Without side effects, the domain of the proof is closed: the evaluator's behavior depends only on its inputs, and the inputs are typed and bounded.

---

## 7. What Could Be Improved

### Proper type inference

The current type inferencer is conservative: it detects obvious errors (undeclared names, known type mismatches at literal sites) but misses subtler ones (a requirement of type `int` used in a context that expects `string`). A proper Hindley-Milner style inference algorithm could detect these automatically.

The challenge is that HM inference in the presence of suspended values requires extending the algorithm to handle "unknown" as a type that propagates through expressions. This is non-trivial and can produce surprising error messages when type variables are unified incorrectly.

### Source maps after macro expansion

The `ABSORB` and `MERGE` macros expand sub-templates inline, changing the positions of all subsequent nodes. A diagnostic generated after expansion refers to a position in the expanded template, not the original source. A source map would allow the position to be translated back to the original file and line.

This is the same problem compilers face with macro expansion and code generation, and the solution is the same: track the expansion provenance for each position in the expanded output. This is not complex in principle, but it requires threading source map information through the expansion machinery.

### Streaming evaluation for large templates

For templates that generate megabytes of output — large reports, bulk-generated content — streaming would allow the client to begin processing the output before it is fully rendered. The `streamability` field in the `Analysis` object already classifies templates as `full`, `partial`, or `buffered`, providing the necessary pre-check. The implementation would require a streaming output interface and a modification to the finalize pass to operate incrementally.

### Incremental re-evaluation

When the driver satisfies a batch of requirements and calls `run()` again, the evaluator re-evaluates the entire template. Most of the template is unchanged; only the expressions that reference the newly satisfied requirements need to be re-evaluated. Incremental re-evaluation would cache intermediate expression results and re-evaluate only the affected subtrees.

This optimization is technically challenging because it requires maintaining a dependency graph between expression nodes and the requirements they reference — which is essentially another layer of the static analysis that `analyze()` already performs for the top-level requirement graph. In principle, the `requirementGraph` edges computed by `analyze()` could seed this incremental evaluator.

### Better error recovery in the parser

The parser currently throws on the first unrecoverable syntax error. An error-recovering parser would attempt to continue past the error, producing diagnostics for all errors in the template in a single pass. This is more complex to implement — error recovery requires heuristics for "where does the parser resync after the error?" — but it provides a better experience for template authors debugging complex templates.

### Property-based testing

The current test suite is example-based: specific inputs with specific expected outputs. Property-based testing generates random inputs and checks that invariants hold. For the lexer, the invariant "every output token's position span reconstructs the original source text" should hold for any input. For the evaluator, the invariant "evaluate() always returns Ok, Susp, or Err, never throws" should hold for any well-formed AST. These invariants are currently only tested for manually chosen examples.

---

## 8. A Checklist for Building a Similar Engine

The following checklist distills the lessons above into actionable steps for someone building a similar typed, suspendable evaluation engine.

- [ ] **Write the specification first.** Define the value model, operator semantics, suspension behavior, and static analysis contract before writing any code.
- [ ] **Define the value model: typed and immutable.** Every runtime value should be a frozen record with a type tag. No mutable values in the evaluation environment.
- [ ] **Separate pure evaluation from I/O.** The evaluator must be synchronous and free of external calls. All external data flows in via typed, named requirements.
- [ ] **Define versioned public contracts early.** Identify which interfaces will be persisted or transmitted across boundaries. Version them independently.
- [ ] **Add resource limits from day one.** Implement limits at every phase: input size, token count, node count, nesting depth, evaluation steps, output size, execution phases, capability timeout.
- [ ] **Design diagnostics as accumulating, not throwing.** The static validator returns an array. The parser throws (on unrecoverable errors). Know which mode each phase uses.
- [ ] **Make state serializable.** The public state must be a plain JSON object. No functions, no Promises, no non-serializable values.
- [ ] **Test each pipeline stage independently.** Unit tests for the lexer use token arrays. Unit tests for the parser use token arrays and AST shapes. Unit tests for the evaluator use constructed AST nodes. Do not test the full pipeline for unit behavior.
- [ ] **Implement the AST cache before benchmarking.** Without the cache, benchmarks measure parsing, not evaluation. The cache reveals the true evaluation cost and unlocks the majority of real-world performance.
- [ ] **Write conformance tests before feature tests.** Conformance tests cover each specification section. Feature tests cover specific behaviors. Start with conformance to ensure the spec is machine-checkable before adding feature-specific coverage.
- [ ] **Guard against prototype pollution.** Use `Object.defineProperty` instead of bracket assignment for attacker-controlled keys. Check `__proto__` explicitly at every point where object keys come from untrusted sources.
- [ ] **No console output from the engine core.** Every diagnostic is returned as a structured value, never written to stdout or stderr.

---

## 9. Recommended Learning Path for Readers

For readers who want to understand how to build a similar engine from scratch, the following sequence builds understanding progressively:

**Step 1: A minimal expression evaluator.** Start with a Pratt parser for arithmetic expressions (`+`, `-`, `*`, `/`, parentheses) and a recursive evaluator that returns `number | Error`. No requirements, no suspension, no types beyond number. This establishes the lexer-parser-evaluator pipeline in its simplest form.

**Step 2: Add types and typed values.** Replace the `number` output with a typed value record `{ type: 'int' | 'float', value: number }`. Add string and boolean literals. Implement the type checking rules: `'a' + 1` is an error; `1 + 1.0` promotes to float.

**Step 3: Add requirements and the three-way result.** Extend the evaluator to return `Ok | Susp | Err` instead of `value | Error`. Implement `require(id)` as a lookup in a `resolved` map that returns `Susp` when the id is absent. This is the core suspension mechanism.

**Step 4: Add the state machine.** Implement `start(template, values)` and `run(state)` as pure functions that transform `PublicState`. Add the driver loop that calls a provider for each pending requirement and re-runs. This implements the conversation model.

**Step 5: Add static validation.** Implement `validate(template)` that parses the template, walks the AST, and returns diagnostics for undeclared names and obvious type errors. This is the conservative inferencer.

**Step 6: Add a capability provider.** Register a real external call (database query, API request) as a capability. Wire it through the driver loop. Observe how the separation of pure evaluation and impure I/O handles the asynchrony.

**Step 7: Benchmark and add caching.** Benchmark each phase in isolation. Identify the bottleneck (almost certainly the parser). Implement the AST cache. Re-benchmark to verify the improvement.

**Step 8: Write the specification for what you built.** Now that you have working code, write the specification. You will discover ambiguities in what you built, edge cases you did not think of, and behaviors that are inconsistent. Fix them in the code and specify the correct behavior.

---

## 10. Final Reflection

Seebo can be understood as a conversation between the host application and the template author, mediated by typed, explicit declarations. The template author declares what they need (`require()`), in what type (`string()`, `int()`, `datetime()`), from what source (`capability: 'crm'`). The host application satisfies those needs through registered providers. The engine orchestrates the exchange.

What makes this conversation productive is that both parties speak through an interface that is typed, named, and statically analyzable. The template author cannot accidentally request data of the wrong type — the type system enforces consistency. The host application cannot accidentally provide data of the wrong type — the driver validates every provider return value. The static analyzer can describe the entire conversation before it happens — the execution plan is computed from the template structure alone.

The pure core is not just a performance or testing optimization. It is the mechanism that makes the conversation reliable. A pure evaluator has no hidden state, no ambient dependencies, no side effects that might change its behavior unexpectedly. It is a function, and functions are the most predictable thing in programming: given the same inputs, they produce the same outputs, every time.

This predictability is what makes Seebo suitable for operational contexts — generating emails, tickets, runbooks, API payloads — where correctness matters and surprises are expensive. An engine that might behave differently depending on global state, or that might make unexpected network calls, or that might produce different output for the same input, is not trustworthy in these contexts. An engine that is a pure function of its inputs is.

---

## Conclusion

Building Seebo surfaced lessons that apply to any language engine: specification-first development is not overhead, it is the foundation; purity is not a preference, it is an engineering constraint with concrete benefits; resource limits are security requirements, not optimization concerns; and the distance between "an engine" and "a platform" is smaller than it appears when the engine is designed to describe itself.

The most durable insight is architectural: separate what you can know statically from what you must learn dynamically. The things you can know statically — what requirements a template has, in what phases they become active, which capabilities are used — should be computed once by `analyze()` and consumed by every layer above. The things you must learn dynamically — what values the capabilities return, what the user types — flow through the suspension model. This separation is not just clean design; it is what enables the engine to serve as the foundation for a platform that generates forms, wizards, integration checklists, and audit trails automatically from template structure.

---

## Further Reading

- `src/util/versions.js` — the three independent version constants and the migration infrastructure
- `src/util/errors.js` — the `Diagnostic` accumulation model and the `SeeboError` hierarchy
- `src/run/run.js` — the pure state machine: `start()`, `run()`, and `safeSet()`
- `src/eval/evaluator.js` — the three-way `Ok | Susp | Err` result and lazy evaluation
- `src/analyze/analyze.js` — the static analysis: requirement graph, execution plan, determinism
- `docs/initial_docs/spec.md` — the normative specification
- `docs/initial_docs/impl.md` — the implementation specification with Appendix A and B
