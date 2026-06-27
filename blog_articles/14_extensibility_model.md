# Extensibility: Designing a Safe Plugin Architecture

## Table of Contents

1. [The Extensibility Philosophy](#the-extensibility-philosophy)
2. [Why Extensions Must Be Explicit](#why-extensions-must-be-explicit)
3. [Why Side-Effecting Functions Are Dangerous](#why-side-effecting-functions-are-dangerous)
4. [The Five Extension Points](#the-five-extension-points)
5. [defineType: Adding a New Runtime Type](#definetype)
6. [defineFunction: Producers and Transformers](#definefunction)
7. [defineCapability: Adding External Providers](#definecapability)
8. [defineMacro: Structural Directives](#definemacro)
9. [defineLibrary: Namespaced Function Collections](#definelibrary)
10. [Name Governance](#name-governance)
11. [The Registry as Single Source of Truth](#the-registry-as-single-source-of-truth)
12. [Policy Constraints on Extensions](#policy-constraints-on-extensions)
13. [The Action/Effect Model as Future Extension](#the-actioneffect-model-as-future-extension)
14. [Dependency Inversion](#dependency-inversion)
15. [Conclusion](#conclusion)
16. [Further Reading](#further-reading)

---

## The Extensibility Philosophy

Every extensible system faces a fundamental tension: the more you allow extensions to do, the more damage a bad extension can cause. A plugin that can call any function can crash the host. A plugin that can write to global state can corrupt other plugins. A plugin that can make network requests can leak data.

Seebo resolves this tension with a clear principle: **the core is closed; the vocabulary is open**. The core engine — the lexer, parser, evaluator, state machine, driver — is not extensible. No extension can change how the evaluator works, how the state machine transitions, or how the driver orchestrates capability resolution. These are fixed.

What is extensible is the vocabulary: the set of types, functions, capabilities, macros, and libraries available to templates. Extensions add new words to the language. They cannot change the grammar, the semantics, or the execution model.

This distinction matters because vocabulary extensions are declarative: they describe what something does, in terms of well-defined contracts. A custom type says "here is how to validate and stringify a value of this type." A custom function says "here is a pure computation that maps arguments to a result." A custom capability says "here is an async resolver that can supply values." These contracts are narrow enough to enforce safety guarantees — a function that satisfies the "pure computation" contract cannot accidentally call the network.

---

## Why Extensions Must Be Explicit

It would be possible to design a system where extensions are discovered automatically: scan a directory for files matching a pattern, import them, and register them. This is the convention-over-configuration approach popularized by some web frameworks.

Seebo does not do this. Every extension must be explicitly registered at `createEngine()` time. There are several reasons.

**Security**: In a system that processes untrusted templates, the vocabulary available to a template must be precisely controlled. Implicit discovery makes it easy to accidentally make something available. Explicit registration makes the available vocabulary auditable: you can read the `createEngine()` call and know exactly what the template can use.

**Predictability**: A template's behavior should not change because a new file appeared in a directory. Explicit registration means the vocabulary is determined by the application code, not by the file system.

**Testability**: When you test a template, you test it against a specific vocabulary. If the vocabulary could change implicitly, tests become fragile. With explicit registration, tests are deterministic.

**Name governance**: Explicit registration is where name conflicts are detected. If two extensions claim the same function name, the engine fails fast at startup rather than silently using one over the other.

---

## Why Side-Effecting Functions Are Dangerous

The evaluator in Seebo is pure. A pure evaluator has no side effects: it does not write to the file system, does not make network requests, does not modify global variables, and does not produce any output other than its return value.

Purity is not just a style preference — it is the foundation of several critical properties:

**Idempotency**: `run(state)` can be called multiple times with the same state and always produce the same result. If a function inside the evaluator made a network request, that request would be re-made on every `run()` call, potentially causing duplicate actions.

**Testability**: Pure functions can be tested without mocking, without ordering constraints, and without environmental setup. A custom function that calls a database cannot be tested without the database.

**Reasoning**: When debugging a template, you need to be able to reason about what the evaluator did. If functions have side effects, the evaluator's behavior depends on the history of previous calls, not just the current inputs.

This is why custom functions registered via `defineFunction` must have pure `eval` implementations. If you need to call an external system, you must use a capability, not a function. Capabilities are async, I/O-performing, and explicitly managed by the driver. Functions are sync, pure, and managed by the evaluator.

The contract is enforced by convention rather than by the JavaScript runtime (you could write an impure function and the engine would not immediately detect it), but the specification is unambiguous: `eval` must be pure. Violation of this contract produces undefined behavior and breaks the idempotency guarantees.

---

## The Five Extension Points

Seebo provides five factory functions for defining extensions, all exported from `src/index.js`:

1. `defineType(name, def)` — a new base type with its own validation and formatting
2. `defineFunction(name, def)` — a new expression-level producer or transformer
3. `defineCapability(name, def)` — a new async external data provider
4. `defineMacro(name, def)` — a new structural directive (expand or finalize phase)
5. `defineLibrary(name, def)` — a namespace grouping related functions

All five return **frozen descriptor objects** — plain data structures, not classes. They do not install behavior into the engine; they describe behavior that the engine will look up. This is the registry pattern: the engine holds a registry of descriptors, and consults it during evaluation.

---

## defineType: Adding a New Runtime Type

A custom type extends Seebo's value system with a new base type. The descriptor specifies how to validate, format, and stringify values of the type.

```js
import { defineType } from 'seebo';

const moneyType = defineType('money', {
  category: 'base',

  defaultFormat: {
    currency: 'EUR',
    locale: 'en-US'
  },

  validate: (rawValue, constraints) => {
    if (typeof rawValue !== 'number') return false;
    if (rawValue < 0) return false;
    if (constraints?.max !== undefined && rawValue > constraints.max) return false;
    return true;
  },

  stringify: (value, format) => {
    return new Intl.NumberFormat(format.locale ?? 'en-US', {
      style: 'currency',
      currency: format.currency ?? 'EUR'
    }).format(value);
  }
});
```

Once registered, templates can create `money` values using `money(1234.5)` syntax, and the engine will format them using the `stringify` function.

The `validate` function is called when a capability provider returns a value for a requirement of this type. If it returns `false`, the engine emits a `CONSTRAINT_VIOLATION` diagnostic.

The `stringify` function is called when a value of this type is converted to text for insertion into the output. It receives the raw value and the format metadata.

Custom types integrate with the runtime at multiple points: `values.js` knows how to create typed values for registered types; `stringify.js` knows how to format them; the evaluator knows how to apply operators to them (or how to report TYPE_ERROR for unsupported operations).

---

## defineFunction: Producers and Transformers

Functions extend the expression language. There are two kinds: producers (which create new values) and transformers (which operate on an existing receiver value).

### Producers

A producer is a free function — it has no receiver. It takes arguments and returns a value.

```js
import { defineFunction } from 'seebo';

const uuidFunction = defineFunction('uuid', {
  arity: { min: 0, max: 0 },
  eval: () => {
    // Must be pure! In practice, use a seeded PRNG or accept clock/seed injection.
    // Here shown as a placeholder.
    return crypto.randomUUID();  // Note: this is NOT pure; shown for illustration only.
  }
});
```

In practice, functions that produce non-deterministic values (random, time-dependent) should use injected sources (clock, seed) rather than global calls, so that the evaluator remains deterministic for a given configuration.

### Transformers

A transformer is a method — it operates on a receiver value of a specific type.

```js
const slugifyFunction = defineFunction('slugify', {
  receiver: 'string',  // this method is callable on string values
  arity: { min: 0, max: 0 },
  eval: (self) => {
    return self.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  }
});
```

Once registered, templates can write `${ title.slugify() }` where `title` is a string value. The evaluator looks up `slugify` in the function registry under the `string` receiver and calls `eval` with the string value.

The `arity` descriptor specifies `{ min, max }` argument counts. `min === max` means exactly that many arguments are required. The validator uses this to check `ARITY_MISMATCH` at static analysis time.

---

## defineCapability: Adding External Providers

Capabilities are the bridge between the pure evaluator and the impure external world. Unlike functions, capabilities are async and explicitly I/O-performing.

```js
import { defineCapability } from 'seebo';

const weatherCapability = defineCapability('weather', {
  resolve: async (req) => {
    const { city } = req.resolverHints;
    const data = await fetchWeatherAPI(city);
    return data.temperature;  // returned as a plain JS value, converted by the driver
  }
});
```

The `resolve` function receives the full `RequirementDescriptor` including `resolverHints`. It can return:
- A value: resolved. The driver validates it against the requirement's type and constraints.
- `undefined`: "not my responsibility." The driver treats this as unresolved and may try other providers or leave the need pending.
- A thrown exception: `CAPABILITY_ERROR`. The driver records the error and marks the need as failed.

The driver handles all the async orchestration, timeout enforcement (`timeoutMs`), retry logic, and type validation of the returned value. The capability's `resolve` function only needs to return the raw value.

The critical distinction: capabilities are not called during `run()` (which is pure and synchronous). They are called by the `drive()` function between `run()` calls. This is what keeps the evaluator pure.

---

## defineMacro: Structural Directives

Custom macros add new `@{...}` directives. They are defined with a phase (`'expand'` or `'finalize'`) and an `apply` function.

```js
import { defineMacro } from 'seebo';

// An expand-phase macro that includes today's date as a static string
const todayMacro = defineMacro('TODAY', {
  phase: 'expand',
  apply: (slot, context) => {
    const today = context.clock().toISOString().slice(0, 10);
    return today;  // returned string is inlined into the template
  }
});
```

Once registered, `@{TODAY}` in a template is replaced with the current date string during the EXPAND phase.

Finalize-phase macros work differently: they receive a position in the output string and return a modified output string.

```js
const trimTrailingSpacesMacro = defineMacro('TRIM_TRAILING', {
  phase: 'finalize',
  apply: (marker, output) => {
    // Remove trailing spaces from all lines up to the marker position
    return output.replace(/ +\n/g, '\n');
  }
});
```

Custom macros follow the same registration and governance rules as other extensions. Their names must be unique and not conflict with built-in macro names.

---

## defineLibrary: Namespaced Function Collections

Libraries group related functions under a common namespace. Instead of polluting the top-level function registry with many names, you register them under a prefix.

```js
import { defineLibrary } from 'seebo';

const mathLibrary = defineLibrary('math', {
  functions: {
    clamp: {
      arity: { min: 3, max: 3 },
      eval: (value, min, max) => Math.min(Math.max(value, min), max)
    },
    lerp: {
      arity: { min: 3, max: 3 },
      eval: (a, b, t) => a + (b - a) * t
    },
    abs: {
      arity: { min: 1, max: 1 },
      eval: (x) => Math.abs(x)
    }
  }
});
```

Once registered, templates use these functions with the namespace prefix:

```
${ math.clamp(score, 0, 100) }
${ math.abs(delta) }
```

Libraries are particularly useful when:
- You have many related utility functions and want to avoid name conflicts
- You're creating a domain-specific vocabulary (e.g., `crm.formatAddress()`)
- You want to make the source of a function clear in the template (e.g., `fmt.currency()` is obviously a formatting function)

The parser recognizes library namespaces at parse time (the namespace name must be registered). The evaluator dispatches library calls through the registry just like regular function calls.

---

## Name Governance

At `createEngine()` time, after all extensions are registered, the engine performs a comprehensive name governance check:

**Reserved word check**: All builtin keywords, operators, and special function names are listed in `src/util/vocabulary.js` as `RESERVED_WORDS`. No extension may use a reserved name. Attempting to define a function named `require`, `match`, `and`, `or`, `not`, `in`, `true`, `false`, or any builtin function name results in an `EngineConfigError` with code `RESERVED_NAME`.

**Uniqueness check**: Within each namespace (types, functions, macros, libraries, capabilities), names must be unique. Defining two functions named `slugify` results in an `EngineConfigError` with code `NAME_CONFLICT`.

**Fail-fast semantics**: These checks are performed at engine construction time, before any template is processed. If any name governance check fails, `createEngine()` throws an `EngineConfigError`. This ensures that name conflicts are caught at startup, not during template rendering.

The rationale: in a production system, you should not discover that two extensions conflict when a user tries to run a template. The engine should fail immediately and loudly at startup, when the conflict can be fixed.

---

## The Registry as Single Source of Truth

The engine holds an immutable `Registry` object, built at `createEngine()` time from the registered extensions:

```js
// Conceptual structure (src/runtime/registry.js)
Registry {
  types: Map<string, TypeDef>,
  functions: Map<string, FunctionDef>,    // keyed as 'receiver.name' or '.name'
  macros: Map<string, MacroDef>,
  libraries: Map<string, LibraryDef>,
  capabilities: Set<string>
}
```

The registry is:
- **Immutable**: created once at `createEngine()`, never modified after
- **Frozen**: all descriptors are `Object.freeze()`'d, preventing mutation
- **Shared**: the same registry instance is used by all pipeline stages

The registry is consulted by:
- The **parser**: to recognize library namespaces (e.g., `math.clamp`) and to validate macro invocation syntax
- The **evaluator**: to call custom functions, transformers, and library functions
- The **validator**: to check against known names for `UNKNOWN_FUNCTION`, `UNKNOWN_METHOD`, `UNKNOWN_CAPABILITY`
- The **driver**: to route capability Needs to the correct providers
- The **finalize pass**: to apply custom layout macros

There is no way to call a function, use a type, or invoke a capability that is not in the registry. The registry is the single, authoritative, compile-time-fixed vocabulary.

---

## Policy Constraints on Extensions

The registry defines what is possible. Policy defines what is allowed for a particular execution context.

The `policy` configuration in `createEngine()` (and optionally per-call in `stebo()`) specifies:

```js
policy: {
  // Hard block list: these capabilities cannot be used in this execution
  allowedCapabilities: ['user', 'crm'],

  // Trust level: affects which capabilityRules apply
  trustLevel: 'untrusted',

  // Per-capability rules (e.g., 'billing' only from trusted templates)
  capabilityRules: {
    billing: { allowFrom: 'trusted' }
  },

  // Audit hook: called after each capability invocation
  audit: (event) => {
    logger.info('capability invoked', { capability: event.capability, id: event.id });
  },

  // Redact hook: masks sensitive values in audit logs
  redact: (event) => {
    if (event.id === 'ssn') event.value = '[REDACTED]';
    return event;
  }
}
```

The `allowedCapabilities` set is the primary policy control. A template that references `billing` capability when `billing` is not in `allowedCapabilities` receives a `POLICY_FORBIDDEN` diagnostic from `validate()` and a `CAPABILITY_FORBIDDEN` error from the driver at runtime.

These allow lists can be used to run templates from untrusted sources (user-generated content, third-party integrations) in a sandboxed context where only a subset of registered capabilities are accessible.

---

## The Action/Effect Model as Future Extension

The current capability model is a **pull model**: the engine requests data, and the capability provider produces it. There are no "write" operations, no "send email" effects, no "update database" calls inside the evaluation loop.

A future extension could introduce an **action model**: the mirror of capabilities, but for effects rather than data. Instead of `require('data', ...)` pulling a value in, an action directive like `effect('send_notification', { message })` would push an effect outward. The engine would collect pending effects alongside pending needs, and the driver would apply them after evaluation.

Several constraints apply to such a model:

**Effects must be explicit.** A pure function that calls `sendEmail()` inside its `eval` breaks the purity guarantee and would re-execute on every `run()` call. Effects must be declared as first-class objects, collected by the evaluator, and applied exactly once by the driver.

**Effects must be deferred to the driver layer.** The driver is the only layer that performs I/O. Effects belong there, executed after the evaluation pass is complete and the output is finalized.

**Effect ordering matters.** Unlike requirements (which can be resolved in any order), effects may have causal constraints. A receipt requires the payment to have succeeded. An effect model would need dependency ordering, either through explicit declaration or through phasing.

This is not present in v1. It is mentioned here because the existing architecture — pure evaluator, I/O in the driver, explicit declaration of all dependencies — is designed so that adding effects correctly is a natural extension. The existing extension points would remain unchanged; effects would be a sixth.

---

## Dependency Inversion

The relationship between the engine's core and its extensions is a textbook instance of the **dependency inversion principle**: high-level modules should not depend on low-level modules; both should depend on abstractions.

In Seebo, the high-level module is the core (parser, evaluator, validator, driver). The low-level modules are the application-specific extensions (the `money` type, the `slugify` function, the `crm` capability). The abstraction is the registry interface.

The core never imports any extension directly. When the evaluator needs to call `slugify`, it calls `registry.getFunction('string', 'slugify')` and invokes the returned descriptor's `eval` function. The evaluator does not know about the `slugify` module. It knows only about the registry abstraction.

This means:
- The core can be tested in complete isolation, with an empty registry
- Extensions can be tested in isolation, without instantiating the full engine
- The same core can serve completely different vocabularies in different applications
- Extensions can be added, removed, or changed without touching the core

The factory functions (`defineType`, `defineFunction`, etc.) produce plain data objects — descriptors. They describe behavior; they do not install it. The engine is a lookup machine, not a call chain.

---

## Conclusion

Seebo's extensibility model achieves a precise balance: powerful enough to support the full range of operational use cases (custom data types, domain-specific functions, external data providers, structural directives), yet constrained enough to maintain the engine's core safety guarantees (purity, determinism, resource limits).

The five extension points — type, function, capability, macro, library — cover the vocabulary space cleanly. Each has a well-defined contract that specifies what it can and cannot do. Name governance enforces that extensions don't conflict. The registry is the single source of truth, consulted by every pipeline stage, and immutable after construction.

The key architectural decision that makes this work is the clean separation between vocabulary (what the language can express) and semantics (how the language is evaluated). Extensions contribute to vocabulary. The semantics are fixed and owned by the core. Vocabulary extensions cannot change how the evaluator behaves — they can only add new values, new operations on values, and new sources of data.

---

## Further Reading

- `src/index.js` — `defineType`, `defineFunction`, `defineCapability`, `defineMacro`, `defineLibrary`, `createEngine`, `normalizeConfig`
- `src/runtime/registry.js` — `createRegistry()`, the `Registry` typedef, name governance implementation
- `src/util/vocabulary.js` — `RESERVED_WORDS` and all builtin name lists
- `src/util/errors.js` — `EngineConfigError`, `DiagnosticCode.RESERVED_NAME`, `DiagnosticCode.NAME_CONFLICT`
- `src/driver/async_driver.js` — policy enforcement in `resolvePending()`, audit hook in `auditEvent()`
- Article 10 in this series: "State Machines and Resumable Evaluation"
- Article 13 in this series: "Macro Processing: Text Transformation Before and After Evaluation"
- Martin, R.C. (2002). *Agile Software Development: Principles, Patterns, and Practices*. Prentice Hall. — Chapter 11: The Dependency-Inversion Principle
- Gamma, Helm, Johnson, Vlissides (1994). *Design Patterns: Elements of Reusable Object-Oriented Software*. — The Abstract Factory pattern (analogous to the registry pattern)
