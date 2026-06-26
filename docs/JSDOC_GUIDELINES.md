# JSDoc Guidelines

Standard JSDoc conventions for the Seebo JavaScript engine.
The project is **plain JavaScript** — no TypeScript syntax, no `.d.ts` files, no `import type`.

---

## Table of Contents

1. [General rules](#1-general-rules)
2. [Public functions](#2-public-functions)
3. [Internal functions](#3-internal-functions)
4. [Factory functions](#4-factory-functions)
5. [Fluent builders](#5-fluent-builders)
6. [Immutable objects and frozen constants](#6-immutable-objects-and-frozen-constants)
7. [Runtime Value types](#7-runtime-value-types)
8. [Diagnostic types](#8-diagnostic-types)
9. [State types](#9-state-types)
10. [AST nodes](#10-ast-nodes)
11. [Config objects](#11-config-objects)
12. [Callbacks and hooks](#12-callbacks-and-hooks)
13. [Error classes](#13-error-classes)
14. [Minimal examples](#14-minimal-examples)

---

## 1. General rules

| Rule | Rationale |
|------|-----------|
| Use JSDoc only — no TypeScript syntax. | The project is `.js`; TS types break plain-JS tooling. |
| One `@typedef` per conceptual type, in the file that owns it. | Avoids duplication and drift. |
| Cross-file references use `import(...)` paths, not bare names. | Keeps tooling-resolvable without a tsconfig. |
| Optional properties are written `[propName]`. | Standard JSDoc convention. |
| `@returns` is always present on non-`void` public functions. | Makes the contract explicit. |
| Spec/impl section references (`SPEC §x`, `IMPL §x`) go in the opening description, not in `@param` lines. | Keeps param lines short. |
| `@type {ReadonlyArray<T>}` / `@type {Readonly<Record<K,V>>}` for frozen constants. | Signals immutability to callers. |
| Add `// TODO(doc): …` when a type is genuinely ambiguous. | Prefer an explicit marker over a silent wrong annotation. |

**Scope of comments.** Document the *contract* (what is guaranteed to callers), not the
implementation. One sentence describing the *why* is better than a paragraph describing
the *how*.

---

## 2. Public functions

Public functions are exported from a module's `index.js` or from a contract file (e.g. `tokens.js`, `nodes.js`).

### Template

```js
/**
 * One-line summary. Add a second sentence only when the summary is insufficient.
 * Reference the spec/impl section if applicable (SPEC §x / IMPL §x).
 *
 * @param {Type} name  Short description of the parameter.
 * @param {Type} [optionalName]  Description. Default is `value`.
 * @returns {ReturnType}  What the return value represents.
 * @throws {ErrorClass}  When and why this throws.
 */
export function publicFn(name, optionalName = value) { … }
```

### Rules

- The first line must be a full sentence ending with a period.
- `@param` descriptions are short (≤ 10 words); put longer explanations in the function description.
- `@throws` is required for functions that throw synchronously; omit for functions that never throw.
- Do not document `@param` for rest parameters (`...args`) if their meaning is obvious from the name.

### Example

```js
/**
 * Tokenizes a Seebo template into a flat token stream (SPEC §2 / IMPL §2).
 * Recoverable lexical errors are routed to `options.onError`; the function itself never throws.
 *
 * @param {string} input  Raw template source.
 * @param {import('./tokens.js').TokenizeOptions} [options]
 * @returns {import('./tokens.js').Token[]}
 */
export function tokenize(input, options = {}) { … }
```

---

## 3. Internal functions

Internal functions (not exported) need lighter documentation.

### Rules

- A single-line `/** … */` is sufficient when the name is self-explanatory.
- Add `@param` / `@returns` only when types are non-obvious or when a reader must know the shape
  to understand the contract with callers.
- Never add `@private` — non-export is already the signal.

### Example

```js
/** Wraps a value + kind into a frozen Ok result. */
function ok(value) {
  return Object.freeze({ kind: 'Ok', value });
}

/**
 * Emits a recoverable diagnostic through the provided sink, if any.
 *
 * @param {((d: import('../util/errors.js').Diagnostic) => void) | undefined} onError
 * @param {string} message
 * @param {number} start
 * @param {number} end
 */
function report(onError, message, start, end) { … }
```

---

## 4. Factory functions

A factory is a function whose primary job is to construct and return an object.

### Rules

- The description must state what the object *is*, not how it is built.
- `@returns` must name the typedef, not write `{Object}`.
- If the factory captures state via closure, document the mutable fields explicitly.
- If the factory freezes the result, add `Immutable.` or `Deeply frozen.` to the description.

### Example — simple factory

```js
/**
 * Builds a {@link Diagnostic}. Pure helper, no side effects.
 *
 * @param {string} code  One of {@link DiagnosticCode}.
 * @param {Object} [opts]
 * @param {import('./errors.js').Severity} [opts.severity='error']
 * @param {import('./errors.js').Phase} [opts.phase='validate']
 * @param {boolean} [opts.recoverable=true]
 * @param {string} [opts.message='']
 * @param {{ start: number, end: number }} [opts.position]
 * @param {Record<string, unknown>} [opts.data]
 * @returns {import('./errors.js').Diagnostic}
 */
export function createDiagnostic(code, opts = {}) { … }
```

### Example — closure-based context factory

```js
/**
 * Creates the mutable parser context that holds token-stream position (IMPL §3.2).
 * All parser helpers receive a context, never the raw token array.
 *
 * @param {import('../lexer/tokens.js').Token[]} tokens
 * @param {ParseOptions} options
 * @returns {Context}
 */
function createContext(tokens, options) { … }
```

---

## 5. Fluent builders

A fluent builder is an object whose methods return a new builder with an updated field,
ending in a terminal method (e.g. `toDescriptor()`).

### Typedef — document the interface, not the closure state

```js
/**
 * Immutable type descriptor builder (IMPL §4 clarifications §8).
 * Every mutating method returns a **new** builder; the original is unchanged.
 *
 * @typedef {Object} TypeBuilder
 * @property {string} type  The base type name.
 * @property {(f: Record<string, unknown>) => TypeBuilder} format  Merges format options.
 * @property {(c: Record<string, unknown>) => TypeBuilder} constraints  Merges constraint options.
 * @property {(d: unknown) => TypeBuilder} default  Sets the default value.
 * @property {() => import('./values.js').TypeDescriptor} toDescriptor  Finalises and freezes.
 */
```

### Factory for the builder

```js
/**
 * Creates a fresh {@link TypeBuilder} for `type`.
 * Start here when building a {@link TypeDescriptor} programmatically.
 *
 * @param {string} type  Must be a known {@link TypeName}.
 * @returns {TypeBuilder}
 * @throws {TypeError}  If `type` is unknown.
 */
export function builder(type) { … }
```

### Rules

- All builder method signatures in the typedef must show `=> TypeBuilder` (or the terminal type).
- Do not expose internal closure state (`state`, `_format`, etc.) in the typedef.
- If the terminal method can throw (e.g. validation), document `@throws` on the terminal method's inline doc.

---

## 6. Immutable objects and frozen constants

### Enums (frozen plain objects)

```js
/**
 * Canonical type names understood by the runtime (SPEC §1.3).
 *
 * @type {Readonly<Record<string, string>>}
 */
export const TypeName = Object.freeze({
  INT: 'int',
  FLOAT: 'float',
  // …
});
```

### Frozen arrays

```js
/**
 * Language reserved words (SPEC §1.5).
 * An application-defined identifier must not match any of these.
 *
 * @type {ReadonlyArray<string>}
 */
export const RESERVED_WORDS = Object.freeze([ … ]);
```

### Frozen config/defaults

```js
/**
 * Security limits applied during JSON sanitization.
 *
 * @type {Readonly<{ maxDepth: number, maxNodes: number }>}
 */
export const VALUE_LIMITS = Object.freeze({ maxDepth: 100, maxNodes: 100_000 });
```

### Rules

- Always use `@type {Readonly<…>}` or `@type {ReadonlyArray<…>}` for `Object.freeze()` results.
- Do not repeat each member in `@property` lines for enums — the source is the documentation.
  Add a single `@property` line only when a member needs a non-obvious explanation.

---

## 7. Runtime Value types

A `Value` is the immutable typed record produced by the runtime (IMPL §4).

### Core typedef (owns `src/runtime/values.js`)

```js
/**
 * Immutable typed value flowing through evaluation (IMPL §4).
 * Always produced by a `make*` factory; never constructed manually.
 *
 * @typedef {Object} Value
 * @property {string} type         One of {@link TypeName}.
 * @property {unknown} value       Internal canonical representation (type-dependent).
 * @property {Record<string, unknown>} format       Display options, frozen.
 * @property {Record<string, unknown>} constraints  Validity rules, frozen.
 */
```

### Factory for a specific type

```js
/**
 * Creates an immutable integer {@link Value}.
 * Deeply frozen; mutating the result is a silent no-op.
 *
 * @param {number} n  Must be a finite integer.
 * @param {{ format?: Record<string, unknown>, constraints?: Record<string, unknown> }} [opts]
 * @returns {Value}
 * @throws {TypeError}  If `n` is not a finite integer.
 */
export function makeInt(n, opts) { … }
```

### TypeDescriptor typedef

```js
/**
 * Descriptor that defines how a type is constructed and validated (IMPL §4 / clarifications §8).
 * Produced by {@link TypeBuilder#toDescriptor}.
 *
 * @typedef {Object} TypeDescriptor
 * @property {string} type
 * @property {Record<string, unknown>} format
 * @property {Record<string, unknown>} constraints
 * @property {unknown} [default]  Present only when `.default(d)` was called on the builder.
 */
```

### Dual-semantics constructor

```js
/**
 * Dual-semantics constructor (clarifications §8).
 * - Called with no `value` argument → returns a {@link TypeBuilder}.
 * - Called with a `value` argument → returns a {@link Value}.
 *
 * @param {string} type
 * @param {unknown} [value]
 * @returns {import('./values.js').Value | import('./values.js').TypeBuilder}
 * @throws {TypeError}  If `type` is unknown.
 */
export function makeTypeConstructor(type, value) { … }
```

---

## 8. Diagnostic types

Diagnostics are non-exceptional feedback objects that accumulate during a phase.

### Core typedefs (owns `src/util/errors.js`)

```js
/**
 * Severity of a diagnostic.
 * @typedef {'error' | 'warning' | 'info'} Severity
 */

/**
 * Phase that produced a diagnostic.
 * @typedef {'tokenize' | 'parse' | 'validate' | 'analyze' | 'eval' | 'run'} Phase
 */

/**
 * Structured diagnostic (IMPL Appendix A).
 * Canonical shape of non-exceptional, accumulate-able feedback from any phase.
 *
 * @typedef {Object} Diagnostic
 * @property {string}   code         Stable identifier; one of {@link DiagnosticCode}.
 * @property {Severity} severity
 * @property {Phase}    phase        Phase that produced the diagnostic.
 * @property {boolean}  recoverable  Whether the phase continued after this diagnostic.
 * @property {string}   message      Human-readable text, already localized or redacted.
 * @property {{ start: number, end: number }} [position]  Byte offsets in the template source.
 * @property {Record<string, unknown>} [data]  Code-specific payload (e.g. `{ name }`).
 */
```

### Stable code enum

```js
/**
 * Stable diagnostic codes used across all phases (IMPL Appendix A).
 * Values are string literals so they survive serialization.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const DiagnosticCode = Object.freeze({
  SYNTAX_ERROR:       'SYNTAX_ERROR',
  UNKNOWN_VARIABLE:   'UNKNOWN_VARIABLE',
  // …
});
```

### Rules

- `code` is always a string from `DiagnosticCode`.
- `message` is human-readable; structured data goes in `data`.
- A function that accumulates diagnostics takes `diagnostics: Diagnostic[]` as an output-accumulator
  parameter, not a return value — document it as `@param {Diagnostic[]} diagnostics  Accumulator; diagnostics are pushed, not returned.`

---

## 9. State types

State represents the serializable snapshot of one evaluation step (IMPL §6).

### Core typedef (owns `src/run/run.js`)

```js
/**
 * Serializable public state snapshot (SPEC §2.4 / IMPL §6.1).
 * Produced by {@link start} and transformed — never mutated — by {@link run}.
 *
 * @typedef {Object} PublicState
 * @property {number}   stateVersion  Schema version; see {@link STATE_VERSION}.
 * @property {string}   template      Original template source.
 * @property {Record<string, import('../runtime/values.js').Value>} resolved
 *   Values that have been provided for pending requirements.
 * @property {import('../eval/evaluator.js').RequirementDescriptor[]} pending
 *   Requirements not yet satisfied.
 * @property {number}   phase         Monotonically increasing step counter.
 * @property {StatusValue} status     Current execution status.
 * @property {string}   [output]      Rendered output; present only when `status === 'done'`.
 * @property {import('../util/errors.js').Diagnostic[]} [diagnostics]
 */
```

### Status enum

```js
/**
 * Possible execution statuses of a {@link PublicState}.
 * @typedef {'running' | 'suspended' | 'done' | 'error'} StatusValue
 */
```

### Rules

- `PublicState` is the only type the host ever serializes/deserializes — keep its typedef accurate.
- Internal runtime state (not exposed to the host) should use a separate `RuntimeState` typedef
  with a `@private` marker in the description, not in a tag.
- Document the `stateVersion` field with a `{@link STATE_VERSION}` cross-reference.

---

## 10. AST nodes

AST nodes are produced by the parser and consumed by the evaluator (IMPL §3).

### Discriminated union pattern

```js
/**
 * All AST node kinds.
 * @type {Readonly<Record<string, string>>}
 */
export const NodeKind = Object.freeze({
  DOCUMENT:   'Document',
  TEXT:       'Text',
  EXPRESSION: 'Expression',
  // …
});

/**
 * Top-level document node (IMPL §3.1).
 *
 * @typedef {Object} Document
 * @property {'Document'} kind
 * @property {number} astVersion    Schema version; see {@link AST_VERSION}.
 * @property {(TextNode | ExpressionNode | MacroNode)[]} children
 */

/**
 * Literal text segment.
 *
 * @typedef {Object} TextNode
 * @property {'Text'} kind
 * @property {string} value
 * @property {{ start: number, end: number }} position
 */
```

### Rules

- Every node typedef must have a `kind` property typed as a string literal (e.g. `{'Text'} kind`).
- Position spans are always `{ start: number, end: number }` (byte offsets in the source).
- Do not embed child-node typedefs inside their parent — define each node type at the top level.
- If a node field is optional at parse time but required after a later pass, add a `// TODO(doc):` noting the phase that fills it.

---

## 11. Config objects

Config objects are passed by the host to configure engine behaviour.

### Typedef (owns `src/index.js`)

```js
/**
 * Engine configuration (SPEC §2.2).
 * All fields are optional; missing fields receive runtime defaults via {@link normalizeConfig}.
 *
 * @typedef {Object} EngineConfig
 * @property {string[]} [types]
 * @property {Array<unknown>} [functions]    // TODO(doc): narrow once function registration API is stable
 * @property {Array<unknown>} [macros]       // TODO(doc): narrow once macro registration API is stable
 * @property {string[]} [libraries]
 * @property {Record<string, (req: import('./eval/evaluator.js').RequirementDescriptor) => unknown>} [capabilities]
 * @property {EnginePolicy} [policy]
 * @property {string} [locale]
 * @property {() => Date} [clock]
 * @property {number} [seed]
 * @property {Record<string, number>} [limits]
 * @property {Record<string, string>} [delimiters]
 * @property {Record<string, boolean>} [optimizations]
 */
```

### Normalization function

```js
/**
 * Applies documented defaults to a raw config. Pure and deterministic.
 *
 * @param {EngineConfig} [config]
 * @returns {NormalizedConfig}
 */
export function normalizeConfig(config = {}) { … }
```

### Rules

- Every optional property must be marked `[name]`.
- When a property type is genuinely unknown at this stage, use `unknown` and add a `// TODO(doc):` comment.
- Document default values in the `@param` description (e.g. `Default is \`'en-US'\`.`), not with invented tags.
- `NormalizedConfig` (the return of `normalizeConfig`) should be its own typedef if used in multiple signatures.

---

## 12. Callbacks and hooks

A callback is a function value passed as a parameter that the engine calls at specific points.

### Typedef pattern

```js
/**
 * Sink for recoverable diagnostics produced during a phase.
 * The callback must not throw; errors thrown from it are undefined behaviour.
 *
 * @callback OnErrorCallback
 * @param {import('../util/errors.js').Diagnostic} diagnostic
 * @returns {void}
 */
```

### Inline usage (when a `@callback` typedef is overkill)

```js
/**
 * @param {(diagnostic: import('../util/errors.js').Diagnostic) => void} [onError]
 *   Sink for recoverable lexical diagnostics. Never called for fatal errors.
 */
```

### Rules

- Use `@callback` when the same function signature appears in more than one typedef or function signature.
- Use the inline `(param: Type) => ReturnType` form for one-off callbacks.
- Always note whether the callback *must not throw*, or whether the engine handles exceptions from it.
- Async callbacks must be typed as `(...) => Promise<void>` (or `Promise<T>`) — never plain `Function`.

---

## 13. Error classes

Error classes derive from `SeeboError` (IMPL Appendix B).

### Base class

```js
/**
 * Base error for all engine exceptions.
 * Host code can use `instanceof SeeboError` to distinguish engine failures from
 * unrelated runtime errors.
 *
 * @extends {Error}
 */
export class SeeboError extends Error {
  /**
   * @param {string} message
   * @param {Object} [opts]
   * @param {string} [opts.code]       One of {@link DiagnosticCode}.
   * @param {{ start: number, end: number }} [opts.position]
   * @param {unknown} [opts.cause]
   */
  constructor(message, opts = {}) { … }
}
```

### Subclass

```js
/**
 * Thrown when `createEngine()` receives an invalid configuration.
 * Non-recoverable; the engine cannot start.
 *
 * @extends {SeeboError}
 */
export class EngineConfigError extends SeeboError {
  /**
   * @param {string} message
   * @param {Object} [opts]
   * @param {string} [opts.code]
   * @param {Record<string, unknown>} [opts.data]  Structured payload for programmatic inspection.
   */
  constructor(message, opts = {}) { … }
}
```

### Rules

- Document `@extends` on every subclass.
- Document `constructor` params with `@param` even though the class already has an opening description.
- Do not add `@throws` to the constructor — constructors that throw are expected; document *why* in the class description.
- `NotImplementedError` and similar sentinel classes need only a one-line description; no `@param` needed if the constructor takes a single obvious string.

---

## 14. Minimal examples

### Annotated function — start to finish

```js
/**
 * Parses a Seebo template into an AST Document (IMPL §3).
 *
 * @param {import('../lexer/tokens.js').Token[]} tokens  Pre-tokenized stream from {@link tokenize}.
 * @param {ParseOptions} [options]
 * @returns {import('../ast/nodes.js').Document}
 * @throws {import('../util/errors.js').SeeboError}  On unrecoverable syntax errors.
 */
export function parse(tokens, options = {}) { … }
```

### Annotated typedef — start to finish

```js
/**
 * Result of a single evaluator step (IMPL §5.2).
 * A tagged union with three variants; discriminate on `.kind`.
 *
 * @typedef {Ok | Susp | Err} EvalResult
 */

/** @typedef {Object} Ok
 * @property {'Ok'}  kind
 * @property {import('../runtime/values.js').Value} value
 */

/** @typedef {Object} Susp
 * @property {'Susp'} kind
 * @property {import('../eval/evaluator.js').RequirementDescriptor} need
 */

/** @typedef {Object} Err
 * @property {'Err'} kind
 * @property {import('../util/errors.js').Diagnostic} diagnostic
 */
```

### TODO(doc) marker

Use this exact format when a type is ambiguous or the API is not yet stable:

```js
// TODO(doc): narrow this type once macro registration API is finalised (see IMPL §10)
/** @type {Array<unknown>} */
```

Do not silently use `unknown` without a comment when a more specific type is possible.

---

*End of guidelines.*
