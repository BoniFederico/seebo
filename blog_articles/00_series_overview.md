# Building a Suspendable Template Engine from Scratch: A Complete Series

## Table of Contents

1. [What Seebo Is](#what-seebo-is)
2. [Why Build an Engine Like This?](#why-build-an-engine-like-this)
3. [Target Audience](#target-audience)
4. [What You Will Learn](#what-you-will-learn)
5. [Article Summaries (01–19)](#article-summaries-0119)
6. [Recommended Reading Order](#recommended-reading-order)
7. [Glossary of Recurring Terms](#glossary-of-recurring-terms)
8. [Conclusion](#conclusion)

---

## What Seebo Is

Seebo is a JavaScript template and workflow engine with one property that sets it apart from everything else in the category: it can suspend evaluation mid-stream and resume it later, without losing state, without re-asking for data that has already been provided, and without any threads or callbacks visible at the language level.

The name is an acronym for "Suspendable Evaluation Engine Built with Opus," but the acronym matters less than the model. Seebo processes a document — a string of text that can contain embedded expression slots delimited by `${` and `}` — and evaluates each slot to produce a final rendered string. That much any template engine does. The difference is what happens when a slot refers to data that does not exist yet.

A conventional template engine would throw an exception, or render an empty string, or expand a placeholder. Seebo does none of those things. Instead, evaluation suspends. The engine produces a description of what it needs — a structured object called a `Need` — and returns control to the caller. When the caller obtains the required value and feeds it back, the engine resumes from the same logical position. The output accumulates only when all needs in a phase have been satisfied.

This design makes Seebo usable for a class of problem that template engines ordinarily cannot touch: multi-turn document generation, where the data required to complete a document must be fetched from external systems, entered by a user across multiple interactions, or resolved in a specific order because later requirements depend on earlier answers. The final rendered document is not a single function call. It is the last state of a conversation between the engine and the world outside.

Seebo is implemented in plain JavaScript with JSDoc type annotations. It has zero runtime dependencies. It targets Node.js 20 and later and uses the ES module format. The entire public API is exposed from a single entry point, `src/index.js`, through a factory function called `createEngine`. Every stage of processing — lexer, parser, validator, analyzer, evaluator, state machine — is a pure synchronous function. The only asynchronous code in the codebase is the driver layer, which coordinates capability invocations and feeds results back into the synchronous core.

---

## Why Build an Engine Like This?

The honest answer is that existing tools cannot do this, and the problem is real enough to justify a new tool.

When you generate documents programmatically — HTTP request bodies, email messages, configuration files, contract templates, structured reports — you almost always have a mix of static content, data you have on hand, and data you need to obtain. The obtainable data has sources: a database, an API, a form filled out by a user. The sequence in which you obtain it can matter: you might not know which CRM record to look up until you have read a form field that the user has not yet submitted.

Existing tools handle the simple case where all data is available before rendering begins. They fail gracefully only at the boundary of that assumption.

String template literals in JavaScript are one-shot: you write the string once, all interpolations must be ready, and you get the result immediately. Handlebars and Mustache are "logic-less" by design — no types, no expressions, no ability to declare what data a template needs. Jinja2 and Liquid are more capable but still assume all context is present before rendering starts. They have no mechanism for saying "I need the customer's account tier before I can decide whether to include the premium pricing section." JSON Schema form builders go in the opposite direction and focus on collecting data rather than rendering it.

The gap is this: there is no widely available tool that treats a document as a stateful object capable of expressing its own data dependencies, suspending when those dependencies are unmet, and completing incrementally as data arrives.

Seebo fills that gap. But building it forces you to engage with a remarkable depth of classical computer science. The engine is, in miniature, a compiler (the lexer, parser, validator, and analyzer form a complete static analysis pipeline), a type system (eight built-in types with operations defined on them), a state machine (the execution model), a macro preprocessor (the expand and finalize passes), and an extensibility framework (the `define*` API).

Building all of this in plain JavaScript, without dependencies, with zero-throw semantics in the lexer, with byte-accurate source positions on every token and AST node, with prototype-pollution guards, with resource limits that prevent any single template from consuming unbounded memory or time — these engineering decisions are individually interesting and collectively instructive. This series unpacks each of them.

---

## Target Audience

This series is written for intermediate-to-senior JavaScript developers who want to understand how compilers, interpreters, and runtime engines work, as demonstrated through a real, working codebase.

You should be comfortable reading modern JavaScript (ES modules, `async`/`await`, destructuring, optional chaining). Familiarity with the concept of an abstract syntax tree will make the parser articles easier, but the articles define every term before using it. You do not need prior knowledge of compiler theory; the series introduces the relevant concepts from first principles.

The series will be most valuable if you have felt the frustration of reaching the edge of what an existing template engine can do. If you have ever wished that a template could express "I need field X before I can decide whether to show section Y" and had no good way to model that, you are exactly the reader this series is written for.

Compiler-curious developers who primarily work in other languages will also find the series accessible. The JavaScript is straightforward, and the architectural patterns — recursive descent parsing, Pratt precedence climbing, three-way evaluation results, state serialization — are language-independent concepts that map cleanly onto the code.

---

## What You Will Learn

By the end of this series you will understand, with reference to actual source code, how to:

- Design a template language that is declarative, typed, not Turing-complete, and statically analyzable
- Write an O(n) error-tolerant lexer that handles mixed-content input (text interspersed with code)
- Write a recursive descent parser with Pratt precedence climbing for expression parsing
- Design and implement a type system with eight types, format metadata, constraint validation, and arithmetic rules for temporal values
- Implement a three-way evaluation result (Ok, Suspend, Error) that enables partial evaluation of a document
- Build a suspendable state machine whose state is a serializable POJO with no continuations
- Implement a static analysis pipeline: symbol table construction, type inference, diagnostic accumulation, requirement graph construction, and execution plan derivation
- Design a macro system with two passes: a pre-pass for structural aggregation and a post-pass for layout transformations
- Write an async driver that polls capability providers, classifies provider outcomes, and feeds results back into a synchronous core
- Harden a runtime engine against hostile input: prototype pollution, resource exhaustion, timeout, output size limits
- Design a versioned public API with three version contracts and a migration mechanism

---

## Article Summaries (01–19)

**Article 01: Why Template Engines Are Not Enough: The Problem Space**

The opening article builds the case for everything that follows. It examines why simple string templating breaks down for operational workflows, what happens when data is not yet available, and why the existing tools — Mustache, Handlebars, Jinja2, Liquid — each solve only part of the problem. Three concrete examples (HTTP request body generation, email file generation, configuration file generation) demonstrate where the tools fall short and what a better model would look like.

**Article 02: Designing a Template Language: Principles and Trade-offs**

This article explains the design goals of the Seebo language: declarative, typed, not Turing-complete, suspendable, statically analyzable. It introduces the core language constructs — text segments, slots, expressions, requirements, capabilities, and macros — and discusses the trade-offs involved in each design decision. Why should the language not be Turing-complete? Why must requirements be explicit rather than inferred? Why does lazy evaluation of branches matter for suspension?

**Article 03: Engine Architecture: A Pipeline of Pure Transformations**

A structural overview of the entire Seebo pipeline, from raw template string to final output. Each stage is described — EXPAND, TOKENIZE, PARSE, VALIDATE, ANALYZE, RUN, FINALIZE — along with the module that implements it and the data type that flows between stages. The central architectural insight is the separation of the pure synchronous core from the impure asynchronous driver layer, and why that separation is the key to the engine's testability and correctness properties.

**Article 04: Lexical Analysis: Tokenizing a Mixed-Content Language**

A deep dive into Seebo's O(n) linear lexer. The article explains what makes mixed-content lexing harder than ordinary source code lexing, how the lexer handles the three slot types (formula, comment, macro), how escape sequences work, and how error tolerance is implemented. The design decision to use byte offsets rather than line/column coordinates as the normative position representation is explained and defended.

**Article 05: Recursive Descent Parsing and Pratt Precedence Climbing**

The parser turns the flat token stream into a frozen AST. This article explains recursive descent parsing for the document-level grammar and Pratt precedence climbing for expression parsing. The precedence table is reproduced and explained. The article covers how `match` expressions are desugared to nested ternaries at parse time, why frozen POJOs are used as AST nodes, and how resource limits (maxNodes, maxNestingDepth) are enforced inside the parser.

**Article 06: The Type System: Eight Types, Values, and Temporal Arithmetic**

Seebo has eight built-in types: `int`, `float`, `bool`, `string`, `datetime`, `duration`, `object`, and `array`. This article describes the internal representation of values (immutable frozen records), the rules for type construction and coercion, the arithmetic rules for temporal types (datetime ± duration = datetime; duration ± duration = duration), and how format and constraint metadata travel with values through evaluation.

**Article 07: The Three-Way Evaluation Result: Ok, Suspend, Error**

The evaluator is the heart of Seebo. Every expression evaluation produces one of three outcomes: `Ok(value)`, `Susp(need)`, or `Err(diagnostic)`. This article explains how the three-way result type enables partial evaluation of a document, how needs are accumulated across a pass, how lazy operators (and, or, ??, ternary) gate the emission of needs so that unsatisfied branches do not produce spurious requirements, and how the evaluator's step budget prevents runaway expressions.

**Article 08: Requirements and Capabilities: Explicit Data Dependencies**

Requirements are explicit declarations of external data dependencies. A `require({ id, type, capability, label, optional })` call declares that the template needs a value from a named provider before it can render completely. This article explains the design of requirements, how they differ from ordinary variables, what capabilities are, and how the sugar form `cap({ ... })` desugars to `require({ ..., capability: 'cap' })` at parse time.

**Article 09: The State Machine: Serializable, Suspendable, Pure**

The execution model is a state machine with four states: Created, Running, Waiting, and Completed/Failed. The state is a plain serializable object — no closures, no continuations, no hidden references. This article explains the state shape, the full re-evaluation strategy of v1, why that strategy is correct even though it sounds expensive, and how state versioning and migration work.

**Article 10: Static Analysis: Validate and Analyze**

Two static analysis passes operate on the AST before any execution. `validate` performs symbol resolution, type inference, arity checking, and policy enforcement, returning an array of diagnostics. `analyze` builds the requirement graph, derives the execution plan (which requirements become active in which phase), computes static values, and classifies the template's streaming suitability. This article explains both passes in depth, including the conservative type inferencer and the longest-path algorithm used for phase assignment.

**Article 11: The Macro System: Expand and Finalize**

Macros in Seebo operate at two distinct points in the pipeline. The EXPAND pre-pass processes aggregator macros (`ABSORB`, `MERGE`) before parsing, composing multiple template sources into a single document. The FINALIZE post-pass processes layout macros (`REMOVE_LINE`, `COLLAPSE`, `REMOVE_LEFT`, `REMOVE_RIGHT`) on the already-rendered text. This article explains both passes, the implementation of glob-based template matching in MERGE, and how custom macros can be registered through the extensibility API.

**Article 12: The Async Driver: Bridging Pure Core and Impure World**

The driver is the only asynchronous component in Seebo. It manages the conversation between the pure state machine and the capability providers that supply the data the template needs. This article explains the four provider outcome types (Resolved, Unresolved, ProviderError, InvalidValue), how the driver enforces capability timeout, how the audit and redact hooks work, and how `stebo` orchestrates the complete expand → drive → finalize pipeline.

**Article 13: Extensibility: defineType, defineFunction, defineCapability, defineMacro, defineLibrary**

Seebo's public API exposes five `define*` factories that allow applications to extend the engine's vocabulary. This article explains each factory, the name governance rules that prevent conflicts with reserved words, how the extension registry resolves custom types, producers, transformers, and library functions during evaluation, and the trust/untrusted capability model.

**Article 14: Security Hardening: Resource Limits and Prototype Pollution Guards**

An engine that processes untrusted templates needs to defend against adversarial inputs. This article covers all of Seebo's defensive measures: the nine resource limits (maxInputBytes, maxTokens, maxNodes, maxNestingDepth, maxSteps, maxDepth, maxPhases, maxOutputBytes, timeoutMs), the `__proto__` key guard in `safeSet`, the deep sanitization of object and array values, the linear-time glob implementation in MERGE that prevents ReDoS, and the ISO-8601 parser that uses a non-backtracking regex.

**Article 15: Source Positions, Diagnostics, and Error Model**

Every token, AST node, and diagnostic carries a source position as a `{ start, end }` byte offset pair. This article explains why byte offsets are normative (line and column numbers are derived), how the optional `locations: true` mode attaches line/column metadata through a single precomputed line index with binary search, and how diagnostics flow through the pipeline. The distinction between the error channel (thrown `SeeboError`) and the diagnostic channel (accumulated `Diagnostic[]`) is explained and motivated.

**Article 16: Versioning and Stability Contracts**

Seebo maintains three independent version numbers: `astVersion`, `stateVersion`, and `analysisVersion`. Each governs a different serialized artifact. This article explains the versioning philosophy, what constitutes a breaking change for each contract, how state migration works, and how the `DiagnosticCode` enum is designed to be additive (new codes are non-breaking).

**Article 17: Performance: Benchmarks and the astCache Optimization**

Seebo's performance on Node v24, measured across the pipeline stages, reveals that the parser is the bottleneck at roughly 3.78ms per operation for a medium-sized template. With `optimizations.astCache` enabled, the parse step drops to approximately 0.0005ms — a 3000× speedup from memoizing the analysis result keyed by `(config, template)`. This article explains how the cache works, what its limits are, and why all optimizations are off by default.

**Article 18: Testing a Pure Engine**

A pure synchronous core has a strong testability property: there are no mocks. Every core function is a pure transformation from input to output. This article describes the testing strategy for Seebo: unit tests for individual pipeline stages, integration tests that drive templates through the full pipeline, conformance tests that verify the normative positions of error diagnostics, and the property that the full re-evaluation strategy makes snapshot testing of state objects straightforward.

**Article 19: End-to-End Example: Building a Multi-Turn Email Generator**

The closing article assembles everything into a complete worked example: a multi-turn email generator that fetches user profile data from one capability, CRM order data from another, requires a user-supplied subject line, and produces a `.eml`-formatted output. The example demonstrates the complete API (`createEngine`, `defineCapability`, `stebo`), walks through each conversation turn, shows the state objects at each phase, and explains how the execution plan from `analyze` predicts the sequence of capability invocations before a single one is made.

---

## Recommended Reading Order

The series is designed to be read linearly. Each article assumes the concepts introduced in earlier articles. The recommended order is:

**Foundation (read in order):**
01 → 02 → 03 → 04 → 05 → 06 → 07 → 08 → 09

**Analysis and macros (read in order, after the foundation):**
10 → 11 → 12

**Advanced topics (can be read in any order after 12):**
13, 14, 15, 16, 17, 18

**Synthesis:**
19 (read last; it references concepts from all preceding articles)

**Articles you can skip without losing the thread:**
- Article 17 (performance benchmarks) if you are not optimizing for throughput
- Article 18 (testing strategy) if you are not building tests for Seebo itself
- Article 16 (versioning) if you are not serializing state between engine versions

---

## Glossary of Recurring Terms

**Template.** A string of text containing zero or more *slots*. The template is the input to the engine and does not change during evaluation.

**Engine.** The configured instance returned by `createEngine(config)`. It binds a registry of extensions and a set of capability providers, and exposes the public API methods (`tokenize`, `parse`, `validate`, `analyze`, `start`, `run`, `expand`, `finalize`, `drive`, `stebo`).

**Expression.** A syntactic form inside a formula slot that computes a value. Expressions include literals, references, function calls, method calls, binary and unary operators, ternary conditionals, and `match` expressions.

**Slot.** A delimited region in the template that is replaced during evaluation. There are three kinds: formula slots (`${ expr }`), comment slots (`#{ ... }`), and macro slots (`@{ MACRO_NAME }`).

**Requirement.** An explicit declaration that the template needs an external value before it can render completely. Written as `require({ id, type, capability, label, optional })`. A requirement that is not yet satisfied causes the evaluator to produce a `Susp` result.

**Capability.** A named provider of external data, registered at engine creation time. A capability provider is a function that receives a requirement descriptor and returns the value asynchronously.

**Value.** An immutable, deeply frozen record `{ type, value, format, constraints }` that flows through the evaluator. The eight built-in value types are `int`, `float`, `bool`, `string`, `datetime`, `duration`, `object`, and `array`.

**Diagnostic.** A structured error or warning produced by a pipeline stage. Diagnostics are accumulated and returned to the caller; they are not thrown. Every diagnostic carries a stable `code`, a `severity`, a `phase`, a `recoverable` flag, a human-readable `message`, and an optional byte-offset `position`.

**State.** The serializable public object that represents the current execution position of the engine. It contains the template, all resolved values, the current set of pending requirements, the current phase number, and the status. State is a plain POJO with no functions or closures.

**Analysis.** The output of the `analyze` pass: an AST, the list of requirements, the requirement dependency graph, the execution plan, the set of capabilities used, computed static values, determinism classification, and streaming suitability.

**Macro.** A structural directive embedded in the template using the `@{ }` sigil. Two families exist: aggregator macros (`ABSORB`, `MERGE`) operate before parsing and compose multiple templates into one; layout macros (`REMOVE_LINE`, `COLLAPSE`, `REMOVE_LEFT`, `REMOVE_RIGHT`) operate after evaluation and reshape the rendered text.

**Expand.** The EXPAND pre-pass: the phase that processes aggregator macros, inlining referenced templates and resolving `ABSORB`/`MERGE` directives into flat text before the lexer and parser run.

**Finalize.** The FINALIZE post-pass: the phase that processes layout macros on the already-rendered text, removing lines, trimming whitespace, and collapsing blank lines.

**Driver.** The async orchestration layer (`src/driver/async_driver.js`) that bridges the pure synchronous state machine with the asynchronous capability providers. It is the only component in the codebase that uses `await`.

**Suspendable evaluation.** The property that the evaluator can produce a `Susp(need)` result instead of a value or an error when it encounters an unsatisfied requirement. The document evaluates to an incomplete state, the need is returned to the caller, and evaluation can resume once the need is satisfied.

**Pure core.** The set of pipeline stages that have no side effects and no I/O: the lexer, parser, validator, analyzer, and evaluator. Every pure stage is a deterministic function from input to output, with no global state, no file system access, and no network calls.

---

## Conclusion

This series is an engineering walkthrough, not a tutorial for getting started quickly. Seebo is small enough to fit in a single person's head, yet complex enough that every part of it teaches something. The lexer introduces mixed-content scanning and error tolerance. The parser introduces Pratt climbing and AST design. The evaluator introduces three-way results and lazy branch evaluation. The state machine introduces serializable execution state. The analysis pass introduces static type inference and dependency graph construction. The macro system introduces pre-pass and post-pass pipeline composition. The driver introduces the interface between a pure core and an impure world.

Read this series if you want to understand not just how Seebo works, but why it is built the way it is — the trade-offs, the constraints, the decisions that look arbitrary until you understand what problem they solve.

## Further Reading

- Knuth, D.E. (1965). "On the translation of languages from left to right." *Information and Control* 8(6). — The paper that introduced LR parsing; context for why recursive descent is a deliberate simplification.
- Pratt, V.R. (1973). "Top down operator precedence." *SIGPLAN Symposium on Principles of Programming Languages.* — The precedence climbing algorithm used in Seebo's expression parser.
- Aho, A.V., Lam, M.S., Sethi, R., & Ullman, J.D. (2006). *Compilers: Principles, Techniques, and Tools* (2nd ed.). — The standard reference for lexer and parser construction.
- Jones, S.P. (ed.) (2003). *Haskell 98 Language and Libraries: The Revised Report.* — A model for a purely functional type system with algebraic data types; context for why Seebo's `EvalResult` is a discriminated union.
