# Lessons Learned: Building a Typed, Suspendable Template Engine

## Table of Contents

1. [What Worked Well](#what-worked-well)
2. [Architectural Principles That Proved Valuable](#architectural-principles-that-proved-valuable)
3. [Trade-offs Made](#trade-offs-made)
4. [Mistakes to Avoid When Building Similar Engines](#mistakes-to-avoid)
5. [Why Specifications Matter](#why-specifications-matter)
6. [Why Pure Core + Impure Shell Is Useful](#why-pure-core-impure-shell)
7. [What Could Be Improved](#what-could-be-improved)
8. [A Checklist for Building a Similar Engine](#a-checklist)
9. [A Learning Path for Readers](#a-learning-path)
10. [Final Reflection](#final-reflection)
11. [Further Reading](#further-reading)

---

## What Worked Well

After building a complete typed, suspendable template engine, certain architectural decisions stand out as having had disproportionately positive impact. These are worth naming explicitly.

### Pure Core + Impure Shell

The most impactful decision was separating the pure synchronous core (lexer, parser, evaluator, state machine) from the impure asynchronous driver (capability resolution, I/O orchestration). This separation:

- Made unit testing trivial: no mocking required for the core
- Made the engine isomorphic (identical code on client and server)
- Made the state serializable (no closures, no callbacks in the state object)
- Made reasoning about correctness tractable (pure functions have no hidden state)
- Made security analysis simple (the core cannot perform I/O by construction)

Every other benefit of the architecture cascades from this one decision.

### Specification-First Development

Writing SPEC.md and IMPL.md before writing production code forced decisions to be made explicitly and early. This paid off in multiple ways:

- Tests were written against the specification, not against the code. This caught implementation deviations that code-first tests would have missed.
- The specification's Appendix B forced the team to think through edge cases before they became bugs.
- When a developer was uncertain about intended behavior, the specification was the authority. Without it, the answer would have been "check what the code does" — which conflates desired and actual behavior.
- The stable public contracts (astVersion, stateVersion, analysisVersion) were designed into the specification from the beginning, before any question of backward compatibility became urgent.

### Three Independent Versioned Contracts

Versioning the AST, the state, and the analysis output independently was the right call. These three artifacts change at different rates and for different reasons. A change to the AST contract (a new expression node kind) does not require incrementing the state contract version. A serialization concern (state fields) is different from a parser concern (AST shapes) is different from an analysis output concern (analysis result shape).

Had they been versioned together, every small change would increment a shared version, making migrations seem more impactful than they are and making the version number meaningless.

### Accumulating Diagnostics

`validate()` returns all diagnostics found in a single pass, never throwing. This sounds trivial but is not: implementing an accumulating validator requires careful defensive programming throughout. Every error path must record the error and continue, not abort.

The payoff is significant: developers see all errors at once. CI sees all errors in a single run. UI editors can show all inline errors simultaneously. The user experience of "fix one error, recompile, find the next" is avoided entirely.

### Conservative Type Inferencer

The decision to use a conservative inferencer (return 'unknown' when in doubt) rather than an optimistic one (infer a type and risk being wrong) eliminated an entire class of false-positive diagnostics. A false positive — reporting an error in a valid template — is worse than a false negative: it forces the developer to work around a spurious error or disable the validator.

The conservative approach sacrifices completeness for precision. This is the right trade-off for a system that authors cannot easily override: if the validator blocks a valid template, the author is stuck. If it misses an error, the error surfaces at runtime with a clear diagnostic code.

### Resource Limits from Day One

Adding resource limits after the fact is technically possible but culturally difficult. When limits are added to an already-deployed system, there are always templates in production that exceed the limits, requiring exceptions and grandfather clauses. Adding limits from the beginning means all templates that enter production are guaranteed to be within limits.

The specific limit values matter less than the existence of the limits. Default values can always be adjusted; the absence of limits cannot be corrected without breaking changes.

### The Three-Way EvalResult

Modeling evaluation outcomes as `Ok(Value) | Susp(Need) | Err(Diagnostic)` rather than as a value that might be undefined, or as an exception that might be caught, proved enormously clean in practice. Every callsite in the evaluator is a pattern match on three cases. The control flow is explicit and mechanical.

The alternative — using `undefined` for missing values and exceptions for errors — creates implicit control flow (exception propagation) and requires null-checking at every step. The three-way result makes the possible outcomes explicit and makes the evaluator's control flow visible in the code.

---

## Architectural Principles That Proved Valuable

Beyond the specific decisions above, several higher-level principles guided the architecture and proved their value.

**Purity is not just a functional programming principle; it is an engineering constraint that forces design clarity.** When you require a function to be pure, you cannot hide side effects inside it. Every interaction with the outside world must be pushed to the boundary. This forces the impure boundary to be explicit, small, and well-defined. The driver's async orchestration is impure because it cannot be otherwise. Everything else is pure because purity was required. The boundary is at `drive()` and nowhere else.

**"What can be statically known should be statically known."** `analyze()` is the canonical answer to this principle. The requirement graph, the execution plan, the capabilities used, the streamability rating — all of these can be computed without running the template. Computing them statically means they are available for UI generation, governance, and capacity planning without any runtime dependency.

**Public contracts are promises.** `DiagnosticCode` values are never renamed. `PublicState` fields are never silently removed. `Analysis` output fields are versioned. Once something is public, it is a promise to the consumers of that API. Breaking a promise requires a major version increment and a migration path, not a quiet refactor.

**The pure core is the safety boundary.** Anything that can be done in the pure core can be analyzed, tested in isolation, and reasoned about without runtime context. Anything that must be done in the impure shell (the driver) requires explicit I/O management, timeout handling, and error classification. Keeping the shell as thin as possible maximizes the benefits of purity.

---

## Trade-offs Made

Every design decision involves trade-offs. Honesty requires acknowledging what was given up.

### Full Re-Evaluation vs Continuations

**Chosen**: Full re-evaluation on every `run()` call, mitigated by optional AST cache.

**Alternative**: Continuation-passing evaluator that resumes from exactly where it paused.

**Trade-off**: Full re-evaluation is simpler and more debuggable, but has higher per-call overhead without caching. Continuations eliminate re-evaluation cost but are complex to implement, harder to serialize, and require CPS transformation of the entire evaluator. With the AST cache, the dominant cost (parsing) is eliminated, making the re-evaluation overhead acceptable.

**Could be revisited if**: Template sizes grow into megabytes, or the number of evaluation phases grows beyond what the cache makes efficient.

### Plain JS + JSDoc vs TypeScript

**Chosen**: Plain JavaScript with JSDoc type annotations, checked by tsc in JSDoc mode.

**Alternative**: TypeScript source with full type inference.

**Trade-off**: JSDoc types are weaker than TypeScript types (no generic inference, no discriminated union narrowing). The development experience is slightly worse. The benefit: zero build step, no TypeScript compilation configuration, direct debugging of source files, lower barrier to contribution.

**Could be revisited if**: The codebase grows large enough that TypeScript's inference would prevent whole categories of bugs that JSDoc misses.

### No Streaming in v1

**Chosen**: `stebo()` always returns the complete output after all requirements are resolved.

**Alternative**: A streaming evaluator that delivers the output prefix as soon as the prefix is determined.

**Trade-off**: Streaming would reduce time-to-first-byte for long templates. It adds significant implementation complexity: the evaluator would need to produce output segments incrementally, the driver would need to buffer pending segments while waiting for requirement resolution, and the API would need to return a stream rather than a string.

**Could be revisited if**: Time-to-first-byte becomes a measured bottleneck in production. The `streamability` field in the analysis output was designed specifically to support a future streaming implementation.

### Conservative Inferencer

**Chosen**: Type 'unknown' for any expression where the type cannot be determined with confidence.

**Alternative**: Optimistic inference (assume the most specific type that is consistent with the expression).

**Trade-off**: Conservative inference means some real type errors go undetected statically. Optimistic inference would catch more errors but would produce false positives. Given that false positives are harder to work around than false negatives in this context, conservative was the right choice.

**Could be revisited if**: A Hindley-Milner-style inference algorithm were implemented, which can infer types correctly (not just conservatively) for first-order type systems.

### Seconds-Only Duration

**Chosen**: `duration` values store signed integer seconds. No months, no years.

**Alternative**: Duration values that include months and years (as some datetime libraries do).

**Trade-off**: Months and years have variable lengths. "Add 1 month to January 31" produces either February 28 or March 2 depending on the clamping rule. "Add 1 year to February 29" (a leap year) produces either February 28 or March 1. These ambiguities require specifying a reference date for correct computation. By restricting durations to seconds (and allowing days as a derived unit of exactly 86,400 seconds), all arithmetic is unambiguous.

**Consequence**: Templates that need "add 3 months to a date" must express this as an approximate number of days, or must use a custom function that does calendar-aware arithmetic. This is an explicit limitation documented in the spec.

---

## Mistakes to Avoid When Building Similar Engines

These are pitfalls that are easy to fall into and hard to recover from.

**Don't skip the specification phase.** Writing code before writing a specification leads to incoherent behavior: each feature is designed in isolation, edge cases are handled ad hoc, and the result is a system where the only documentation is the source code. The source code documents what happens, not what should happen. Writing the specification first forces you to think through "what should happen?" systematically.

**Don't add side effects to the evaluator.** The temptation is real: "I just need to log this one thing," or "I just need to check this one external value." Each compromise is individually defensible but collectively fatal. Once the evaluator makes network calls, it can no longer be tested without network. Once it logs, it can no longer be run in silent environments. Once it reads environment variables, its behavior is environment-dependent. Keep the evaluator pure from the beginning.

**Don't use implicit type coercion.** Implicit coercion seems like a convenience (templates can mix strings and numbers freely). It is a trap: once you allow `'Hello' + 42 === 'Hello42'`, you cannot statically detect type errors, you cannot reason about expression types, and you cannot implement a type inferencer. The short-term convenience becomes a permanent limitation on the system's analyzability.

**Don't let resource limits be an afterthought.** Adding limits to a deployed system is politically difficult. Adding them from the beginning means they are part of the contract and cannot be removed without a breaking change. Default limits should be conservative (limit first, loosen if needed) because tightening limits on deployed systems is more disruptive than loosening them.

**Don't version everything together.** A single "format version" for the entire output of the engine creates unnecessary coupling. When the AST changes (new node kind), you don't want to bump the state version and force all stored states to be migrated. Independent versioning requires slightly more bookkeeping but eliminates false coupling between unrelated changes.

**Don't build a Turing-complete template language unless you need it.** The temptation to add loops ("just a simple forEach") and recursion ("just one level deep") is strong. Every added power reduces analyzability, increases security risk, and adds implementation complexity. Most operational template use cases require no more than conditional expressions, method calls, and function calls. Start with the minimum and add only what is proven necessary.

**Don't confuse the validator and the runtime.** `validate()` is for static errors; runtime errors are for runtime failures. A runtime error that is reported as a validation error (or vice versa) is a diagnostic design error that confuses users about whether a template has a permanent problem or a transient data problem.

---

## Why Specifications Matter

The word "specification" can sound bureaucratic, but its technical meaning is precise: a specification is a description of intended behavior that is independent of any implementation.

A specification serves several purposes:

**It is the contract between the engine and its consumers.** When `UNKNOWN_FUNCTION` is specified as a diagnostic code for calling an unknown function, that code is a promise. Consumers write code that handles `UNKNOWN_FUNCTION`. If the implementation later renames the code (say, to `FUNCTION_NOT_FOUND`), it breaks every consumer. The specification makes this a visible, named commitment.

**It enables conformance testing.** The IMPL.md appendices B and A specify exact diagnostic codes and exact edge case behaviors. Anyone can implement an engine against these specifications and verify conformance by running the conformance tests. The tests are tied to the specification, not to the implementation.

**It forces completeness of thought.** Writing "how should `match x { }` (with no cases) behave?" in a specification requires a definitive answer. Writing code that handles this case is easier if the answer is already decided. Without the specification, each developer answers this question individually, potentially differently, producing inconsistent behavior.

**It survives personnel changes.** The specification documents the intended behavior of the system. When a developer who wrote a particular feature leaves, the specification remains. New developers can implement features against the specification without guessing at the original intent.

---

## Why Pure Core + Impure Shell Is Useful

This deserves elaboration beyond what was said in "What Worked Well," because it is perhaps the most broadly applicable lesson.

The pure core + impure shell pattern is a generalization of several well-known design principles: hexagonal architecture, the clean architecture, functional core / imperative shell. They all express the same idea: keep the part that is easy to reason about (the functional core) free from the part that is hard to reason about (I/O, state, time, randomness).

**For unit testing**: The pure core can be tested with `assert(f(input) === expected)`. No setup, no teardown, no mocking. Each test is a standalone, deterministic function call.

**For isomorphism**: If the core is pure, it has no dependencies on the platform (no `require('fs')`, no `fetch`, no DOM). The same code runs on client and server. Seebo's engine runs identically in Node.js and in the browser.

**For serialization**: Pure state can be serialized without concern about closures, callbacks, or opaque objects. `PublicState` is a plain JavaScript object because the evaluator state that it captures is the input and output boundary of a pure computation, not the internal state of a running process.

**For reasoning**: When debugging a pure function, there is no hidden state to consider. The function's output depends only on its inputs. If `f(x) = y` yesterday and `f(x) = z` today, and x has not changed, then f has changed — not the environment, not some global variable, not a cached side effect.

**For security**: A pure core cannot exfiltrate data. It cannot make network calls. It cannot write files. These properties follow from purity, not from explicit prohibition.

The shell — the driver, the capability providers, the macro expansion infrastructure — is necessarily impure. But it is thin: it is orchestration code that calls the pure core and manages its results. The shell contains no business logic. The business logic is in the template, evaluated by the pure core.

---

## What Could Be Improved

Honest retrospection requires acknowledging what could be better.

**Type inference**: The conservative inferencer misses real errors. A Hindley-Milner-style inference algorithm would catch more errors without false positives. The challenge is that HM inference works cleanly for simple first-order type systems, but Seebo's types (with constraints, formats, and the temporal type hierarchy) require extensions to standard HM. This is future work.

**Source maps after macro expansion**: When ABSORB inlines a template, errors in the inlined template report positions in the expanded string, not in the source template. Implementing source maps (position mapping from expanded to source) would significantly improve the developer experience for composition-heavy templates.

**Streaming evaluation**: The `streamability` field in the analysis output hints at a streaming evaluator that does not exist yet. Implementing it would improve time-to-first-byte for long templates, particularly those with large static prefixes.

**Incremental re-evaluation**: The full re-evaluation strategy is correct and fast with caching, but it recomputes the entire template even when only a few requirements change. An incremental evaluator that only re-evaluates affected subtrees would reduce the evaluator's contribution to warm-cache run time.

**Better parser error recovery**: The current parser reports errors and attempts to continue, but the recovery paths are not exhaustively tested or specified. In some cases, a parse error in one slot causes spurious errors to be reported for subsequent slots. Better error recovery would give developers a more complete picture of all errors in a single validation pass.

**Property-based testing**: The current test suite is example-based. Property-based testing (with `fast-check` or similar) would verify invariants like idempotency, monotonicity, and serialization round-tripping across a much wider input space than handcrafted examples.

---

## A Checklist for Building a Similar Engine

If you are building a typed, suspendable template engine (or any language engine with similar properties), this checklist captures the decisions that matter most.

- [ ] **Write the specification first.** Define the type system, the operator semantics, the evaluation model, and the public API contracts before writing production code.

- [ ] **Define the value model (typed, immutable).** Decide your types, their canonical representations, and the rules for combining them. Forbid implicit coercion.

- [ ] **Separate pure evaluation from I/O.** The evaluator must be pure. All I/O belongs in the driver. This is the most important single decision.

- [ ] **Define versioned public contracts early.** Identify the artifacts that consumers will depend on (AST shape, state shape, output shape). Version them independently.

- [ ] **Add resource limits from day one.** Choose sensible defaults. Make them configurable. Assign a diagnostic code to each limit.

- [ ] **Design diagnostics as accumulating, not throwing.** Implement a validator that collects all errors rather than stopping at the first.

- [ ] **Make state serializable.** The evaluation state must be expressible as a plain JSON-compatible object. No closures, no opaque objects.

- [ ] **Test each pipeline stage independently.** Lexer tests, parser tests, evaluator tests, validation tests, driver tests. Don't rely only on end-to-end tests.

- [ ] **Implement the AST cache before benchmarking.** Without the cache, parse time dominates and gives a misleading picture of the evaluator's actual cost.

- [ ] **Write conformance tests before feature tests.** Conformance tests verify the specification. Feature tests verify specific capabilities. Conformance tests catch broader classes of bugs.

- [ ] **Implement prototype-pollution guards early.** If untrusted data can enter the engine, add `sanitize.js`-style guards from the beginning.

- [ ] **Design the extensibility model before the first extension.** If you add custom types or functions before the registry pattern is in place, you will need to refactor. Design the extension points first, then implement them.

---

## A Learning Path for Readers

If you want to implement a similar engine starting from scratch, here is a recommended sequence. Each step builds on the previous.

**Step 1: Implement a minimal evaluator (just expressions, no requirements).** Build a lexer, a Pratt parser, and a tree-walking evaluator for a small expression language: arithmetic, comparisons, string operations, function calls. Make the evaluator pure. Verify it with unit tests.

**Step 2: Add the value model.** Replace raw JavaScript values with typed, frozen Value objects. Implement strict type rules for each operator. Write tests for each type combination.

**Step 3: Add requirements and the three-way EvalResult.** Add `require()` as a built-in. Implement `Ok | Susp | Err` as the evaluator's return type. Implement propagation rules. Write lazy evaluation tests.

**Step 4: Add the state machine.** Implement `start(template, values)` and `run(state)`. Make state a serializable POJO. Write a simple driver that resolves needs synchronously for testing.

**Step 5: Add static validation.** Implement a `validate()` function that walks the AST and checks for structural errors. Use a conservative type inferencer. Return all errors in a single pass.

**Step 6: Add a capability provider.** Implement the async driver that calls capability providers. Handle the four provider outcomes (resolved, unresolved, error, invalid). Write multi-turn conversation tests.

**Step 7: Add the macro pipeline.** Implement EXPAND (text-level template composition) and FINALIZE (layout cleanup). Test each macro independently.

**Step 8: Benchmark and add caching.** Establish a baseline. Profile. Implement the AST cache. Measure the improvement.

**Step 9: Write the specification for what you've built.** Document the type system, operator semantics, evaluation model, and public contracts. Write this as a specification, not as API documentation.

---

## Final Reflection

The most durable insight from building Seebo is that a template engine is not fundamentally about rendering text. Rendering text is the final step. The real work is in the layers beneath it: the type system that makes values explicit, the evaluation model that makes suspension safe, the static analysis that makes requirements visible, the state machine that makes conversations resumable.

A template engine that merely renders text is useful, but replaceable. Template literal tags in JavaScript render text. Handlebars renders text. Mustache renders text. What makes Seebo different — and what makes building engines like it worthwhile — is that it knows what it needs before it needs it, can describe itself without running, and can pause without failing.

The template is not just a rendering specification. It is a declarative description of a conversation between the host and the data. The engine mediates that conversation, one turn at a time, with explicit types, explicit needs, and explicit outcomes. The rendering is the final resolution of that conversation — the moment when all questions have been answered and the document can be written.

Understanding an engine at this level — not as a black box that produces strings, but as a structured computation with well-defined semantics, explicit contracts, and principled design — is what allows you to build systems that are not just functional but maintainable, testable, secure, and extensible over time.

That understanding is what this series has tried to convey.

---

## Further Reading

- SPEC.md and IMPL.md in the Seebo repository — the authoritative sources for the specification
- Article 03 in this series: "Engine Architecture: A Pipeline of Pure Transformations"
- Article 09 in this series: "Suspendable Evaluation: Pausing Without Failing"
- Article 12 in this series: "Static Analysis: Understanding Templates Without Running Them"
- Scott Wlaschin (2018). *Domain Modeling Made Functional*. Pragmatic Bookshelf. — On making domain constraints explicit in types
- Nystrom, R. (2021). *Crafting Interpreters*. Available free at craftinginterpreters.com. — The best practical guide to building a language implementation from scratch
- Pierce, B.C. (2002). *Types and Programming Languages*. MIT Press. — The theoretical foundation for type systems
- Aho, Lam, Sethi, Ullman (2006). *Compilers: Principles, Techniques, and Tools* (2nd ed.). — The standard reference for compiler construction
- Tanenbaum, A.S. (various). — For the writing style this series has aspired to: precise, grounded, progressive, and honest about trade-offs
