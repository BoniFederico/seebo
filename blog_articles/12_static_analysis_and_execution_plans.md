# Static Analysis: Understanding Templates Without Running Them

## Table of Contents

1. [Why analyze() Is Different from validate()](#why-analyze-is-different)
2. [The Analysis Output Shape](#the-analysis-output-shape)
3. [Requirement Extraction](#requirement-extraction)
4. [The Requirement Dependency Graph](#the-requirement-dependency-graph)
5. [Execution Phases](#execution-phases)
6. [capabilitiesUsed](#capabilitiesused)
7. [staticValues](#staticvalues)
8. [The deterministic Flag](#the-deterministic-flag)
9. [Streamability](#streamability)
10. [Dependency Graphs: A Brief Theory](#dependency-graphs-a-brief-theory)
11. [Dataflow Analysis (Simply Explained)](#dataflow-analysis-simply-explained)
12. [A Worked Example: Email Template](#a-worked-example-email-template)
13. [How the Execution Plan Maps to a UI Wizard](#how-the-execution-plan-maps-to-a-ui-wizard)
14. [Conclusion](#conclusion)
15. [Further Reading](#further-reading)

---

## Why analyze() Is Different from validate()

The distinction between `validate()` and `analyze()` is easy to state but worth dwelling on, because conflating them leads to misuse of both.

`validate(template)` is a quality gate. It asks: "Is there anything wrong with this template?" Its return value is a list of problems. An empty list means "no problems found." The useful case is when the list is non-empty and the caller can refuse to proceed.

`analyze(template)` is a discovery tool. It asks: "What can you tell me about this template?" Its return value is a rich data structure describing the template's external dependencies, its requirement graph, its computational properties, and more. It does not report errors. It reports facts.

A template can fail `validate()` and still be partially analyzable. A template that passes `validate()` always produces a meaningful `analyze()` result. In practice, you run `validate()` first and only call `analyze()` on templates that are structurally sound.

The deeper difference is this: `validate()` is about correctness, and `analyze()` is about capability. Knowing that a template is correct tells you that it will not crash. Knowing what it analyzes to tells you what you can build on top of it: what forms to render, what integrations to wire up, how many interaction turns to expect, whether the output can be streamed.

---

## The Analysis Output Shape

The `analyze()` function returns an `Analysis` object. Its shape is versioned by `analysisVersion` (currently 1), which is included so that consumers can detect when the schema has changed. Adding optional fields is a non-breaking change; removing or renaming fields increments the version.

```js
{
  analysisVersion: 1,

  // The parsed AST — can be reused for other analysis passes
  ast: Document,

  // All require() calls found in the template
  requirements: RequirementDescriptor[],

  // Dependency edges between requirements
  requirementGraph: {
    edges: [['country', 'city']]   // city depends on country's value
  },

  // Phased execution plan
  executionPlan: [
    { phase: 1, requirements: ['country'] },
    { phase: 2, requirements: ['city'] }
  ],

  // Which capability names are referenced
  capabilitiesUsed: ['user', 'crm'],

  // Requirements computable without any input
  staticValues: {
    'invoice_id': Value   // if computed from a static expression
  },

  // Does the template use now()? If yes, output varies with time
  deterministic: false,

  // Can output be streamed before all requirements are resolved?
  streamability: 'full' | 'partial' | 'none',

  // Structural safety information
  potentialCycles: [],
  maxPhases: 2,
  worstCaseRequirements: 3
}
```

Each field serves a specific use case. Requirement extraction drives form generation. The dependency graph drives wizard sequencing. The execution plan drives the driver's phase logic. `capabilitiesUsed` drives permission and audit systems. `deterministic` drives preview behavior. `streamability` drives output delivery strategies.

---

## Requirement Extraction

The most fundamental thing `analyze()` does is walk the entire AST and collect every `require()` call. Each `require()` call produces a `RequirementDescriptor`:

```js
{
  id: 'city',
  type: string(),             // the type builder from the require() call
  capability: 'user',         // the capability name
  label: 'Italian city',      // human-readable label
  optional: false,
  resolverHints: {}
}
```

The extraction is a complete walk — it visits every node in the AST, including nodes inside conditionals, match expressions, and nested function calls. It does not filter by reachability; it extracts all requirements whether or not they will be triggered in practice.

This is important: the extracted requirements represent the **universe** of possible requirements, not the requirements for any specific execution. Whether a requirement is actually triggered depends on the runtime values of conditional expressions. The execution plan (discussed below) captures the conditional structure.

The result is the `requirements` array: a flat list of all `RequirementDescriptor` objects found in the template. This list is ordered by appearance in the template (depth-first, left-to-right AST traversal), which gives a predictable and stable order for UI rendering.

---

## The Requirement Dependency Graph

Not all requirements are independent. Some requirements appear inside conditional expressions that are gated on the values of other requirements. This creates a dependency: requirement B cannot be meaningfully asked until requirement A has been answered, because the need for B is conditional on A's value.

Consider:

```
${ country == 'IT'
   ? require({ id: 'city', type: string(), capability: 'user', label: 'City' })
   : 'N/A' }
```

Here, `city` is inside the true branch of a ternary whose condition references `country`. If `country` is not `'IT'`, `city` will never be needed. If the engine asked for `city` before knowing `country`, it might ask unnecessarily (and expose the user to a confusing question).

The analyzer traces these dependencies by examining which identifiers appear in the condition of each conditional expression. When it finds `country` in a condition that gates a `require({id:'city',...})`, it records an edge:

```js
requirementGraph: {
  edges: [['country', 'city']]
}
```

This edge reads: "city depends on country." Before city can be activated, country must be resolved.

The graph is a directed acyclic graph (DAG) in the normal case. The analyzer checks for cycles and reports them in `potentialCycles` — a cycle would mean requirement A depends on B and B depends on A, which is logically impossible. In practice, cycles arise only in pathological templates, and the analyzer flags them without crashing.

---

## Execution Phases

The execution plan is a topological sort of the dependency graph. It answers: "If I satisfy requirements in order, which ones can I ask in the first turn, which in the second, and so on?"

```js
executionPlan: [
  { phase: 1, requirements: ['country'] },  // no dependencies
  { phase: 2, requirements: ['city'] }      // depends on country
]
```

Phase 1 contains requirements with no incoming edges in the dependency graph — they can be asked immediately on the first run. Phase 2 contains requirements that depend on at least one phase-1 requirement. Phase 3 would contain requirements depending on phase-2 requirements, and so on.

The `maxPhases` field reports the length of the longest chain in the execution plan. In the example above, `maxPhases: 2`. For a template with independent requirements, `maxPhases: 1`. For a deeply conditional template where each answer gates the next question, `maxPhases` could approach the engine's `limits.maxPhases` configuration (default 10).

The execution plan is not used by the evaluator directly — the evaluator simply runs the template and suspends on any unresolved requirement, collecting whatever needs it encounters. But the execution plan is invaluable for external systems:

- A UI wizard can pre-compute how many steps the form will have
- A driver can pre-fetch phase-1 capability values in parallel before starting evaluation
- A capacity planner can estimate the total number of interaction turns a workflow will require

---

## capabilitiesUsed

```js
capabilitiesUsed: ['user', 'crm', 'secrets']
```

This is the set of distinct capability names referenced by `require()` calls in the template. It is extracted during requirement collection: each `RequirementDescriptor`'s `capability` field is added to the set.

Use cases:

**Permission systems**: Before allowing a template to be run, check that the current user has permission to use all listed capabilities. A template that uses `billing` might require elevated privileges.

**Audit configuration**: Pre-configure audit logging for the listed capabilities before the driver runs.

**Integration checklist**: When onboarding a new template to a system, `capabilitiesUsed` tells the operator which capability providers need to be configured.

**Static policy checking**: If the engine policy forbids a capability, this will already be caught by `validate()`. But external systems can also check `capabilitiesUsed` against a policy whitelist before even calling `validate()`.

---

## staticValues

```js
staticValues: {
  'document_version': Value('1.0'),
  'footer_text': Value('Confidential')
}
```

Some expressions in a template are entirely static — they reference no requirements, use no `now()` call, and depend on no runtime data. These can be pre-computed by the analyzer.

The analyzer performs a "cold" evaluation pass: it runs the evaluator with an empty `resolved` map and collects all `Ok(Value)` results from expressions that fully resolve without suspension. Expressions that produce `Susp(Need)` or `Err` are excluded.

The practical use of `staticValues` is optimization: if a downstream system knows that certain values are always the same, it can avoid asking for them and pre-populate the `resolved` map with them before the first `run()` call. This can reduce the number of phases.

---

## The deterministic Flag

```js
deterministic: false
```

If the template contains a call to `now()`, its output depends on the current clock time. The same template rendered at 09:00 will produce a different output at 17:00. This makes the template non-deterministic from a testing and preview perspective.

The `deterministic` flag is set to `false` if any `now()` call appears anywhere in the template. It is `true` otherwise.

Use cases:

**Preview systems**: If `deterministic: false`, the preview UI should display a warning: "This template's output changes based on current time." The preview should also allow the user to specify a mock clock for testing.

**Caching**: Output from a deterministic template with the same inputs can be safely cached. Output from a non-deterministic template cannot.

**Testing**: Test harnesses for deterministic templates can compare against exact expected outputs. Non-deterministic templates require either clock injection or snapshot testing with appropriate tolerances.

The engine supports clock injection via the `clock` option in `createEngine()`:

```js
const engine = createEngine({
  ...config,
  clock: () => new Date('2026-06-26T12:00:00Z')
});
```

This makes non-deterministic templates testable by fixing the clock.

---

## Streamability

```js
streamability: 'full' | 'partial' | 'none'
```

Streamability describes whether the engine can begin delivering output before all requirements are resolved.

**'full'**: The template begins with a static text segment (no slots before the first requirement). The prefix can be streamed to the client immediately, before evaluation of the dynamic parts begins.

**'partial'**: Some later portions of the template are static and could be streamed, but the very first character of output depends on a requirement.

**'none'**: There is no static prefix; the first character depends on an expression that may suspend.

Note: Seebo v1 does not implement streaming output — `stebo()` always returns the complete output after all requirements are resolved. The `streamability` field is included in the analysis output as a hint for future streaming implementations or for external systems that want to know whether streaming is theoretically possible.

---

## Dependency Graphs: A Brief Theory

A dependency graph is a directed graph where each node represents an entity and each edge represents "A must be known before B can be computed." Dependency graphs appear everywhere in computing: build systems (Makefile dependencies), package managers (npm install order), spreadsheets (cell references), database query optimizers.

The key operation on dependency graphs is topological sorting: ordering nodes such that every dependency comes before the node that depends on it. If node B depends on node A, then A appears before B in the topological order. The execution plan is a topological sort of the requirement dependency graph.

A dependency graph can contain cycles: A depends on B, B depends on C, C depends on A. Cycles make topological sorting impossible — there is no valid ordering. Seebo detects cycles and reports them in `potentialCycles`. In practice, requirement cycles arise only in templates that are logically self-referential, which indicates a design error.

The depth of the graph (the length of the longest path from any source node to any sink node) determines `maxPhases`. This is the minimum number of interaction turns required to complete the template, assuming all requirements in each phase are resolved in parallel.

---

## Dataflow Analysis (Simply Explained)

Dataflow analysis is a family of techniques from compiler theory for statically determining how values flow through a program. Rather than executing the program with specific inputs, you reason about all possible executions simultaneously, tracking what might be true at each point.

Seebo's analyzer performs a simplified form of dataflow analysis:

1. It walks the AST from the root.
2. When it encounters a conditional expression (ternary, `and`, `or`, `??`), it notes which identifiers appear in the condition.
3. For each branch, it records which `require()` calls are reachable only through that branch.
4. For each such conditional `require()`, it records an edge from the condition's identifiers to the conditional requirement.

This is enough to build the dependency graph without fully understanding the program's control flow. The analyzer doesn't need to know what `country == 'IT'` evaluates to — it only needs to know that `city`'s reachability depends on the value of `country`.

The approach is conservative in the opposite direction from the type inferencer: the analyzer may report more dependencies than strictly necessary (because it doesn't attempt to prove unreachability), but it will never miss a real dependency. This is correct for the use case: it is better to over-estimate the number of phases (more conservative form, more interaction turns) than to under-estimate (incorrectly claim a single-phase form when multiple turns are required).

---

## A Worked Example: Email Template

```
From: ${ require({ id: 'sender', type: string(), capability: 'secrets', label: 'Sender email' }) }
Subject: Order ${ require({ id: 'order_id', type: int(), capability: 'crm', label: 'Order ID' }) }

Dear ${ require({ id: 'saluto', type: array().constraints({ values: ['Gentile', 'Caro'] }), capability: 'user', label: 'Greeting' }) } customer,

Your order has been processed.
${ note != '' ? 'Note: ' + require({ id: 'note', type: string(), capability: 'user', label: 'Additional note', optional: true }) : '@{REMOVE_LINE}' }
```

Running `analyze()` on this template produces:

```js
{
  analysisVersion: 1,
  requirements: [
    { id: 'sender',   type: string(),            capability: 'secrets', label: 'Sender email',    optional: false },
    { id: 'order_id', type: int(),               capability: 'crm',    label: 'Order ID',         optional: false },
    { id: 'saluto',   type: array()...,          capability: 'user',   label: 'Greeting',         optional: false },
    { id: 'note',     type: string(),            capability: 'user',   label: 'Additional note',  optional: true  }
  ],
  requirementGraph: {
    edges: [['note', 'note']]  // note appears in both condition and require() — same id, self-reference handled
  },
  executionPlan: [
    { phase: 1, requirements: ['sender', 'order_id', 'saluto', 'note'] }
  ],
  capabilitiesUsed: ['secrets', 'crm', 'user'],
  staticValues: {},
  deterministic: true,
  streamability: 'none',   // first char is from 'From: ${ ... }'
  maxPhases: 1,
  worstCaseRequirements: 4
}
```

The execution plan shows a single phase: all four requirements have no inter-dependencies, so they can all be asked in the first turn. The driver can resolve `secrets` and `crm` automatically, then pause for `user` input. Both `saluto` and `note` (the user requirements) are collected in the same interaction turn.

This maps directly to a UI form: one step, two fields (`saluto` as a select, `note` as an optional text area).

---

## How the Execution Plan Maps to a UI Wizard

The correspondence between the execution plan and a UI wizard is exact:

| Execution plan phase | UI wizard step |
|---|---|
| Phase 1 requirements | Step 1: show these fields |
| Phase 2 requirements | Step 2: shown after phase-1 values are submitted |
| Phase N requirements | Step N |

Each phase maps to a wizard step. The requirements in each phase map to the form fields in that step. The `label` on each requirement maps to the field's display label. The `type` builder maps to the field's input type and validation rules.

For the country/city example:

- **Step 1**: "Country" (text input, required)
- **Step 2** (shown only after step 1 if country == 'IT'): "Italian city" (text input, required)

The wizard doesn't need to know about the template at all. It reads the execution plan, renders each phase as a step, collects user input, and feeds it back to the engine. The engine's analysis IS the wizard's specification.

This is the key architectural insight: static analysis makes the engine self-describing. The engine can describe, before any user interaction, exactly what it will need and in what order. This description is machine-readable and UI-renderable, which is why the engine can serve as the foundation for a low-code form builder.

---

## Conclusion

`analyze()` is one of Seebo's most powerful capabilities. By running a static compiler pass over the template's AST, it extracts a rich machine-readable description of the template's external dependencies, their conditional structure, and their computational properties — without executing a single expression or calling a single capability provider.

The requirement graph and execution plan form the bridge between the template language and the user interface. They translate declarative template logic into a sequence of interaction steps that can be rendered as a wizard, a form, or an API sequence. The `capabilitiesUsed` set drives permission and audit systems. The `deterministic` flag and `streamability` rating inform delivery and caching strategies.

Together, `validate()` and `analyze()` give developers and systems a complete picture of a template before it ever runs: is it correct, what does it need, how many turns will it take, and what can be known in advance?

---

## Further Reading

- `src/analyze/analyze.js` — the analyze() implementation; requirement extraction; graph building; execution plan computation
- `src/validate/infer.js` — the type inferencer, consulted by analyze() to determine staticValues
- `src/run/run.js` — how the evaluator and the execution plan relate at runtime
- Article 08 in this series: "Requirements and Capabilities: Declarative Data Dependencies"
- Article 10 in this series: "State Machines and Resumable Evaluation"
- Article 18 in this series: "From Engine to Platform: How Static Analysis Enables Low-Code Tools"
- Aho, Lam, Sethi, Ullman (2006). *Compilers: Principles, Techniques, and Tools* (2nd ed.). — Chapter 9: Machine-Independent Optimizations; especially §9.2 on data-flow analysis
- Kildall, G.A. (1973). "A unified approach to global program optimization." *Proceedings of POPL 1973*.
