# State Machines and Resumable Evaluation: A Conversation with the Engine

## Table of Contents

1. [The Fundamental Problem](#the-fundamental-problem)
2. [State as a Public Contract](#state-as-a-public-contract)
3. [The Conversation Metaphor](#the-conversation-metaphor)
4. [The Five States and Their Transitions](#the-five-states-and-their-transitions)
5. [What "Resuming" Means](#what-resuming-means)
6. [The v1 Strategy: Full Re-Evaluation](#the-v1-strategy-full-re-evaluation)
7. [Serialization and Persistence](#serialization-and-persistence)
8. [Continuations vs Resumable State](#continuations-vs-resumable-state)
9. [The Phase Counter and maxPhases](#the-phase-counter-and-maxphases)
10. [A Three-Turn Walkthrough](#a-three-turn-walkthrough)
11. [Idempotent Re-Execution](#idempotent-re-execution)
12. [Future Directions](#future-directions)
13. [Conclusion](#conclusion)
14. [Further Reading](#further-reading)

---

## The Fundamental Problem

Every template engine eventually confronts the same question: what happens when the template needs data that isn't there yet?

The naive answer is to crash. If a variable is missing, throw an error. The developer must ensure that all data is available before rendering begins. This works for batch rendering — take a template, take a data object, produce a string — but it breaks down the moment any part of the data must come from a human, from an external system, or from a second request that depends on the result of the first.

Consider a template that generates a customer email. The greeting depends on a salutation the user must choose. The body depends on order data from a CRM. The subject line depends on the order ID, which comes from the CRM lookup. You cannot render the template until all three pieces are ready. But you also cannot ask the CRM for the order until you know which customer to look up. And you cannot show the user the salutation choices until you know what kind of email you are generating.

What you need is a system that can start evaluation, proceed as far as possible, pause when it needs something it doesn't have, communicate what it needs, accept the answer, and continue. This is the problem that Seebo's state machine solves.

---

## State as a Public Contract

In Seebo, the concept of "where evaluation is paused" is reified as a plain data object called `PublicState`. It is not a closure, not a generator, not a coroutine — it is a simple, serializable JavaScript object that captures everything the engine needs to resume evaluation.

```js
// PublicState — the complete, serializable evaluation state
{
  status: 'running' | 'waiting' | 'completed' | 'failed',
  template: string,                       // the original template string
  resolved: { [id: string]: Value },      // requirements already satisfied
  pending: Need[],                        // requirements still outstanding
  phase: number,                          // how many driver cycles have completed
  output: string | null,                  // only set when status === 'completed'
  diagnostics: Diagnostic[]              // accumulated across all phases
}
```

The word "public" in `PublicState` is deliberate: this is a versioned contract, not an implementation detail. The `stateVersion` field (carried in the state's metadata) tracks which version of this contract the state was created under. When the engine reads a state, it checks `stateVersion` and migrates the state forward if needed, or rejects it with `UNSUPPORTED_STATE_VERSION` if the state is from a newer engine that the current version cannot understand.

The `resolved` map is particularly important. It is the accumulation of all answers provided so far — by capability providers, by the host application, or by the user. Every value in `resolved` has already been type-checked and validated. It is a snapshot of what the engine knows.

The `pending` array is the list of questions. Each `Need` carries the full `RequirementDescriptor`: the ID, the type, the capability name, the human-readable label, and any `resolverHints` that might help the provider answer the question. This is what the host application, the driver, or the user interface needs in order to answer.

---

## The Conversation Metaphor

The interaction between the engine and the host is best understood as a conversation. The engine proposes an output, discovers what it needs, asks for it, receives the answer, and continues — turn by turn — until it either completes or fails.

This is not a metaphor invented for documentation. It is the literal design intent. The driver function is named `drive()`. The engine produces `Need` objects that read like natural-language requests: "I need the value of `saluto`, which is the customer's preferred greeting, expected to be one of: Gentile, Caro, Egregio." The `label` and `resolverHints` fields are designed to be surfaced directly to a user interface.

The conversation terminates when one of two things happens: either all needs are satisfied (status becomes `completed`) or an unrecoverable error occurs (status becomes `failed`). The engine guarantees that it never loops indefinitely — the `maxPhases` limit ensures that the conversation has a finite length regardless of what the template does.

---

## The Five States and Their Transitions

The state machine has five named statuses. Understanding each and what causes the transition between them is key to working with the engine.

```
                  start(template, values)
                         │
                         ▼
                    [ created ]
                         │
                      run(state)
                         │
                         ▼
                    [ running ]  ──── needs? ────▶  [ waiting ]
                         │                               │
                         │           resolve + run()  ◀──┘
                         │
              ┌──── completed? ────▶  [ completed ]
              │
              └──── error? ──────▶   [ failed ]
```

**created**: The initial status returned by `start(template, initialValues)`. The template has been accepted but not yet evaluated. This status exists so that the caller can inspect the initial state before evaluation begins, and optionally add pre-loaded values before calling `run()`.

**running**: The engine is actively evaluating. In practice, `run()` is synchronous and returns immediately — the engine never spends real time in the `running` state from the caller's perspective. But logically, the engine is working through the AST, accumulating results, collecting needs.

**waiting**: Evaluation has proceeded as far as possible without the currently pending needs. The `pending` array is non-empty. The engine is waiting for the host to resolve those needs. This is the state in which the host calls capability providers, asks the user for input, or queries an external system.

**completed**: All needs have been satisfied and the full output has been produced. The `output` field is set. The `pending` array is empty. The conversation is over.

**failed**: An unrecoverable error has occurred. The `diagnostics` array contains the reason. The `output` field is null. This can happen due to a type error at runtime, a resource limit being exceeded, or a capability provider returning an invalid value.

---

## What "Resuming" Means

Resuming evaluation is conceptually simple: take a state in the `waiting` status, add newly resolved values to the `resolved` map, and call `run()` again.

```js
// First turn: start evaluation
let state = engine.start(template, { invoice_id: 'INV-001' });
state = engine.run(state);
// state.status === 'waiting'
// state.pending === [{ id: 'saluto', capability: 'user', ... }]

// Host resolves the pending need
const answers = { saluto: 'Gentile' };

// Merge answers into resolved and run again
state = engine.run({
  ...state,
  resolved: { ...state.resolved, ...answers },
  pending: []
});
// state.status === 'completed'
// state.output === '...'
```

This is exactly what the driver does in a loop. The `drive()` function handles the mechanics: calling capability providers, collecting their responses, merging them into `resolved`, and calling `run()` again until the status is no longer `waiting`. For interactive capabilities like `user`, `drive()` can be configured with `stopOn: ['user']` to return the state to the caller rather than blocking indefinitely.

The important invariant is: **adding more values to `resolved` never makes evaluation go backward**. The evaluator always re-runs the full template, but it short-circuits immediately on requirements already in `resolved`. The accumulated knowledge only grows between turns.

---

## The v1 Strategy: Full Re-Evaluation

The v1 implementation uses a deliberate simplification: every call to `run(state)` re-evaluates the complete template from scratch. There are no checkpoints, no saved continuations, no incremental evaluation. The evaluator always starts at the root of the AST and walks the entire tree.

This is correct because the evaluator is deterministic and pure. Given the same `template` string and the same `resolved` map, it will always produce the same output (or the same set of pending needs). Re-evaluation is safe.

It is also efficient enough for practical use, because the main cost of re-evaluation is re-parsing. The template string must be tokenized and parsed on every call to `run()`, which at ~3.78ms for a 20KB template is not negligible. The `optimizations.astCache` option eliminates this cost for repeated calls on the same template:

```js
const engine = createEngine({
  ...config,
  optimizations: { astCache: true }
});
```

With the cache enabled, `run()` costs roughly 0.63ms for the same 20KB template (a ~4.5× speedup), because the AST is retrieved from a `WeakMap` keyed on the config object and the template string rather than being recomputed.

The full re-evaluation strategy is simpler than continuation-passing for several reasons:

1. **No continuation capture**: capturing a continuation in a recursive-descent evaluator requires transforming the entire evaluator into continuation-passing style, which is a significant implementation complexity.

2. **No stale state**: continuations capture the stack at a specific moment. If `resolved` changes between captures, the continuation may hold references to outdated intermediate values. Full re-evaluation avoids this by starting fresh every time.

3. **Serializable state**: a continuation is an opaque closure — it cannot be serialized to a database or sent over a network. The `PublicState` POJO can be serialized with `JSON.stringify()`.

4. **Testability**: each call to `run()` is an independent, deterministic computation. There is no hidden mutable state inside the evaluator that could cause surprising results.

---

## Serialization and Persistence

The serializable nature of `PublicState` is one of the most practically valuable properties of the design. A state can be:

- Stored in a database between user interactions
- Sent from a server to a client and back
- Checkpointed before a risky operation
- Replicated across server instances
- Inspected in logs for debugging

To serialize a state, you need only `JSON.stringify(state)`. To resume from a serialized state, you deserialize with `JSON.parse()` and pass the result back to `run()`. The engine re-parses the template from the `template` string field — no AST is included in the serialized state.

What needs to be serialized:
- `template`: the original template string
- `resolved`: the map of requirement IDs to their resolved Values
- `pending`: the list of outstanding Needs (may be empty if resuming later)
- `status`: the current status
- `phase`: the phase counter
- `diagnostics`: accumulated diagnostics

What does NOT need to be serialized:
- The AST (recomputed from `template` on the next `run()`)
- The registry (part of the engine configuration, not the state)
- Any internal evaluator context (it is discarded after each `run()`)

This separation between the engine's configuration (registered types, functions, capabilities) and the evaluation state is fundamental. The engine is stateless with respect to evaluation — it is the state object that carries the evaluation forward.

One practical implication: if you change the engine's vocabulary between evaluation turns (add a new function, change a capability provider), the re-evaluation will use the new vocabulary. This is usually desirable (you can fix a bug in a capability provider and resume pending states without losing progress), but it requires care if the vocabulary change is breaking.

---

## Continuations vs Resumable State

Computer science literature on suspendable computation typically discusses continuations: a captured representation of "the rest of the computation" at a specific point. A continuation can be resumed later, potentially multiple times. Continuations are powerful but complex to implement and difficult to serialize.

Seebo's approach is different and simpler: rather than capturing "where we were" inside the evaluator, it captures "what we know" at the boundary between turns. The `resolved` map is not a continuation — it is a summary of the answers provided so far. On the next turn, the evaluator re-derives "where it is" by running the complete template again and short-circuiting on known values.

The conceptual difference:

| Continuation | Resumable State (Seebo v1) |
|---|---|
| Captures call stack | Captures input/output boundary |
| Resumes from exact pause point | Re-runs from scratch with more data |
| Cannot be serialized (naively) | Trivially serializable |
| Complex to implement | Simple to implement |
| Incremental (doesn't re-evaluate) | Full re-evaluation (mitigated by cache) |

Neither approach is universally superior. Continuations have better asymptotic performance for deeply nested computations. Resumable state is simpler, safer, and more debuggable. For the operational workflow domain that Seebo targets — where templates are at most tens of kilobytes and evaluation is fast — resumable state is the correct trade-off.

---

## The Phase Counter and maxPhases

The `phase` field in `PublicState` counts how many times the driver has completed a full resolution cycle. It starts at 0 and increments after each turn in which at least one pending need is resolved.

The `maxPhases` limit (default: 10) is a safety valve. It ensures that even a pathologically designed template — one that, after each answer, reveals new questions indefinitely — cannot loop forever. When the phase counter reaches `maxPhases`, the driver stops with a `MAX_PHASES_EXCEEDED` diagnostic.

In practice, well-designed templates have at most 2 or 3 phases:
- Phase 1: ask for all requirements with no conditional dependencies
- Phase 2: ask for requirements gated on phase-1 values
- Phase 3 (rare): requirements gated on phase-2 values

The `analyze()` function computes the maximum number of phases a template can require and exposes it as `maxPhases` in the analysis output. If `analyze()` reports `maxPhases: 2`, you know the conversation will take at most 2 turns regardless of what values are provided.

---

## A Three-Turn Walkthrough

Consider this template:

```
Country: ${ require({ id: 'country', type: string(), capability: 'user', label: 'Country' }) }
${ country == 'IT' ? require({ id: 'city', type: string(), capability: 'user', label: 'Italian city' }) : 'N/A' }
```

**Turn 1: Start**

```js
let state = engine.start(template, {});
state = engine.run(state);
// status: 'waiting'
// pending: [{ id: 'country', capability: 'user', label: 'Country' }]
// resolved: {}
```

The evaluator runs the template, finds `require({id:'country',...})` in the first slot, and emits `Susp(Need{id:'country'})`. The second slot contains a ternary; to evaluate the condition `country == 'IT'`, the evaluator needs `country`, which is also missing. Both references to the same requirement collapse to a single Need.

**Turn 2: Provide country**

```js
state = engine.run({ ...state, resolved: { country: val('IT') }, pending: [] });
// status: 'waiting'
// pending: [{ id: 'city', capability: 'user', label: 'Italian city' }]
// resolved: { country: Value('IT') }
```

Now `country` is known. The ternary condition `country == 'IT'` evaluates to true, so the engine evaluates the true branch: `require({id:'city',...})`. City is not yet in `resolved`, so another Need is emitted.

**Turn 3: Provide city**

```js
state = engine.run({ ...state, resolved: { ...state.resolved, city: val('Rome') }, pending: [] });
// status: 'completed'
// output: 'Country: IT\nRome'
// pending: []
```

Both requirements are now satisfied. The ternary resolves to the city value, and the template renders completely.

This three-turn conversation is precisely what the `analyze()` function predicts:

```js
engine.analyze(template).executionPlan
// [
//   { phase: 1, requirements: ['country'] },
//   { phase: 2, requirements: ['city'] }
// ]
```

The execution plan is a static description of what the runtime will do. The runtime doesn't use the execution plan directly — it simply runs and suspends — but the plan is invaluable for building UIs, validating templates, and capacity planning.

---

## Idempotent Re-Execution

A subtle but important property: calling `run(state)` twice with the same state produces the same result. The evaluator is a pure function of the template string and the resolved map. There is no hidden mutable state, no incrementing counter inside the evaluator, no random source.

This means that:

- You can call `run()` for preview purposes without "using up" the state
- You can retry `run()` after a transient capability failure without risk of double-applying effects (there are no effects in the evaluator)
- You can checkpoint a state, try an operation, and roll back to the checkpoint if it fails

Idempotency is not an accident. It is a consequence of the purity requirement. A pure function with the same inputs always produces the same outputs. The state machine enforces this by making `run()` a pure transformation: it takes a state and returns a new state, without mutating the input.

---

## Future Directions

The v1 full re-evaluation strategy, while correct and simple, has limitations that become visible at scale:

**Streaming**: If a template has large static sections before the first requirement, those sections could be streamed to the client immediately. Full re-evaluation prevents this because the engine doesn't produce partial output until it has evaluated everything it can. A streaming evaluator would need to emit output segments incrementally as they are resolved, interleaved with suspension points.

**Incremental evaluation**: In a long multi-phase conversation, phases 1 and 2 are re-evaluated identically on every turn. With an incremental evaluator, you would cache the results of sub-expressions that depend only on already-resolved requirements and reuse them on subsequent turns. This would improve performance for large templates with many phases.

**Continuations for deep recursion**: If Seebo were extended to support recursive macro inclusion with evaluator callbacks (not a current feature), continuations would become necessary to avoid re-evaluating the outer context on every recursive call.

None of these are in v1. They are mentioned here because understanding why they are not present — and what the cost would be to add them — is part of understanding the design.

---

## Conclusion

Seebo's state machine is built around a simple, powerful idea: the evaluation state is a serializable public contract, not a private opaque object. This makes it possible to pause evaluation mid-template, store the state, resume it later, and do all of this on different machines or at different times.

The full re-evaluation strategy in v1 keeps the implementation simple and correct. The AST cache makes it fast enough for real workloads. The `maxPhases` limit ensures safety. And the `PublicState` type contract gives host applications a stable, versioned interface for building multi-turn workflows on top of the engine.

The result is an engine that models evaluation not as a one-shot function call, but as a conversation — one that can pause, wait, and resume, while keeping all of its state in a plain, JSON-serializable object.

---

## Further Reading

- `src/run/run.js` — `start()` and `run()` implementation; the pure state machine
- `src/driver/async_driver.js` — `drive()` and `stebo()` — the async orchestration loop
- `src/util/versions.js` — `stateVersion`, migration pipeline, `UNSUPPORTED_STATE_VERSION`
- `src/util/limits.js` — `maxPhases` and all other resource limits
- Article 09 in this series: "Suspendable Evaluation: Pausing Without Failing"
- Article 12 in this series: "Static Analysis: Understanding Templates Without Running Them"
- Reynolds, J.C. (1972). "Definitional interpreters for higher-order programming languages." — the original paper on continuation-passing style
- Wadler, P. (1992). "The essence of functional programming." — monads as a model for effect separation
