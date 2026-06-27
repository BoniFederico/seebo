# Static Validation: Catching Errors Before the First Run

## Table of Contents

1. [What Static Validation Is](#what-static-validation-is)
2. [The Accumulation Philosophy](#the-accumulation-philosophy)
3. [Three Categories of Error](#three-categories-of-error)
4. [What validate() Checks](#what-validate-checks)
5. [The Conservative Type Inferencer](#the-conservative-type-inferencer)
6. [Diagnostic Design](#diagnostic-design)
7. [How Diagnostics Serve UI and CI](#how-diagnostics-serve-ui-and-ci)
8. [Worked Examples](#worked-examples)
9. [What validate() Cannot Catch](#what-validate-cannot-catch)
10. [validate() vs analyze()](#validate-vs-analyze)
11. [Conclusion](#conclusion)
12. [Further Reading](#further-reading)

---

## What Static Validation Is

In compiler terminology, "static" means "without running the program." Static validation is the process of checking properties of a program — or in Seebo's case, a template — before any input data is provided or any evaluation occurs. It is the equivalent of a compiler's type-checking phase: a pass that can catch a class of errors early, cheaply, and completely.

When you call `engine.validate(template)`, Seebo runs the full pipeline up to and including semantic analysis, but stops before evaluation. It examines the template's AST for structural problems: references to names that don't exist, calls to functions with the wrong number of arguments, operators applied to incompatible types, requirements citing capabilities that haven't been registered.

The benefit is significant. Consider deploying a template to a production workflow system. Without static validation, you might discover that the template references a misspelled function name only when the first user tries to run it — at midnight, on a production server, in a workflow that has already consumed an hour of user time. With validation, you discover it during development, during code review, during CI, or when the template is saved to the template library.

---

## The Accumulation Philosophy

Many compilers and validators stop at the first error. This is simple to implement but frustrating to use: you fix one error, recompile, discover the next, fix it, and repeat. If you have five errors, you need five round trips.

Seebo's `validate()` accumulates all diagnostics it can find in a single pass and returns them all at once. The return value is always a `Diagnostic[]` — an array that may be empty (no errors found) or may contain many diagnostics. `validate()` never throws. Even if the template is syntactically catastrophic, the function returns gracefully with a list of what it found.

This design choice has engineering implications. The validator must be written defensively: when it encounters an error, it records it and attempts to continue analysis. This requires careful handling of invalid AST states — if a subtree contains an `UNDECLARED_NAME`, the validator must still check the sibling subtrees for their own errors, not abort.

The accumulation property also means that the validator's output is always a complete picture of what is wrong with the template, not just the first thing. A CI system that runs `validate()` on every template change can report a complete list of issues in a single run, letting the developer fix everything in one session.

---

## Three Categories of Error

Not all errors are the same. Seebo distinguishes three distinct categories, discovered in different phases and with different remediation paths.

**Syntax errors** are discovered during tokenization and parsing. They indicate that the template text is not grammatically valid: an unclosed slot (`${ name` without a closing `}`), an unexpected token inside an expression (`${ 1 + }`), or a malformed macro invocation. Syntax errors are detected before semantic analysis, so they are reported alongside any semantic errors found in parts of the template that could be successfully parsed.

**Static semantic errors** are discovered by `validate()`. They indicate that the template is syntactically valid but semantically wrong: a reference to an identifier that hasn't been declared, a call to a function that doesn't exist in the registry, an operator applied to values that can't be combined. These are the errors `validate()` is designed to catch.

**Runtime errors** are discovered during evaluation — inside `run()`. They indicate problems that could not have been known before input data arrived: a capability provider returning a value that violates the declared type constraints, a division by zero in a computed expression, an output that exceeds `maxOutputBytes`. These errors are returned as `Diagnostic` objects in the state's `diagnostics` array, not thrown as exceptions.

The distinction matters because each category has different remediation:
- Syntax errors require fixing the template text
- Static semantic errors require fixing the expression logic or the engine configuration
- Runtime errors require fixing the input data or the capability providers

---

## What validate() Checks

### UNDECLARED_NAME

An identifier used in an expression that has not been declared anywhere in the template. In Seebo's scoping model, a name is declared by a `require()` call with that `id`. If you write `${ customer.name }` but never write `require({ id: 'customer', ... })`, you get `UNDECLARED_NAME`.

This is perhaps the most common error in template authoring. It catches typos, copy-paste mistakes, and missing requirement declarations.

### UNKNOWN_FUNCTION

A function call to a producer that is not registered in the engine's function registry. If you write `${ foo(42) }` and `foo` is not a builtin function and has not been registered via `defineFunction`, you get `UNKNOWN_FUNCTION`.

Note that this check covers both builtin functions (e.g., `string()`, `int()`, `now()`) and custom functions registered at `createEngine()` time. The registry is the complete set of known functions.

### UNKNOWN_METHOD

A method call on a receiver value where the method is not defined for that receiver type. For example, `${ someNumber.upper() }` would produce `UNKNOWN_METHOD` because `upper()` is a method on strings, not numbers. This requires the type inferencer to have determined the type of `someNumber` — which is only possible when the inferencer can track the type through the expression.

### ARITY_MISMATCH

A function called with the wrong number of arguments. If `formatDate` expects exactly two arguments and you write `${ formatDate(date) }`, you get `ARITY_MISMATCH`. Arity is checked against the function's registered descriptor, which specifies `{ min, max }` argument counts.

### TYPE_ERROR

A statically provable type violation. The key word is "statically provable": the validator can only report a `TYPE_ERROR` if the type inferencer is confident about both operand types and the operation is definitively invalid for those types. For example, `${ 'hello' + 42 }` is a `TYPE_ERROR` because string concatenation is not defined between string and int in Seebo's type system (there is no implicit coercion).

The validator is conservative: if it cannot determine one of the types with confidence, it emits no `TYPE_ERROR`, even if the expression might fail at runtime. This is the safe choice — a false positive (reporting an error that isn't actually wrong) is worse than a false negative (missing an error that will manifest at runtime).

### NON_EXHAUSTIVE_MATCH

A `match` expression that does not have a wildcard `*` case and does not cover all possible input values. Since Seebo cannot statically enumerate the possible values of most types (they come from runtime data), any `match` without a `*` case is considered non-exhaustive. The validator checks for this and reports the diagnostic.

### UNKNOWN_CAPABILITY

A `require()` call that names a capability not registered in the engine. If you write `require({ id: 'x', capability: 'weather' })` but `weather` is not a capability in the engine configuration, you get `UNKNOWN_CAPABILITY`. This prevents templates from referencing providers that the engine doesn't know how to route.

### POLICY_FORBIDDEN

A `require()` call that names a capability which is registered but excluded by the engine's policy configuration. For example, if the engine is configured with `policy: { allowedCapabilities: ['user'] }`, a template that uses the `crm` capability will produce `POLICY_FORBIDDEN`.

This is particularly useful for multi-tenant systems where different templates have different trust levels and are allowed to use different subsets of the available capabilities.

---

## The Conservative Type Inferencer

Static validation of type-related errors requires a type inferencer: a component that can determine the type of an expression without evaluating it. Seebo's inferencer lives in `src/validate/infer.js`.

The inferencer is **conservative**: when it cannot determine a type with confidence, it returns `'unknown'` rather than guessing. An expression with type `'unknown'` is excluded from type-based checks. This produces no false positives at the cost of missing some real errors.

Consider the expression `require({ id: 'x', type: string() }) + require({ id: 'y', type: int() })`. Statically, we know the type of each `require()` from its `type` field. The inferencer can determine that the left operand is `string` and the right is `int`, and can report a `TYPE_ERROR`.

Now consider `crm({ id: 'data', type: object() }).someField`. The inferencer knows `crm(...)` returns an `object`, but it cannot know the type of `someField` — that depends on the runtime structure of the object. So `someField` has type `'unknown'`, and any operations on it will not produce type errors from the validator. If the operation is actually invalid at runtime, the evaluator will catch it.

The conservatism also applies across conditional branches. The expression `x ? stringValue : intValue` has a type that depends on `x` at runtime. The inferencer cannot determine it statically without knowing `x`, so it returns `'unknown'`.

This design has a precise goal: **no false positives**. A false positive — reporting an error on a template that would actually run correctly — is worse than a false negative, because it forces the developer to work around a spurious error or disable the validator. The conservative approach sacrifices completeness (some real errors are missed) to preserve precision (all reported errors are real).

---

## Diagnostic Design

Each `Diagnostic` object has a consistent structure:

```js
{
  code: DiagnosticCode,      // stable enum value (e.g., 'UNDECLARED_NAME')
  message: string,           // human-readable explanation
  severity: 'error' | 'warning',
  position: {
    start: number,           // byte offset in the template string
    end: number
  }
}
```

The `code` field is a stable `DiagnosticCode` enum. Codes are never renamed or removed — adding new codes is a non-breaking change, but removing or renaming existing codes would break any code that matches on the string value. This stability guarantee is explicit in the specification.

The `position` field traces back to the AST node that caused the diagnostic. If an `UNDECLARED_NAME` error refers to the identifier `customer` at position 47 in the template string, the `position` field lets a text editor draw a red underline precisely under that identifier.

The `message` field is for human consumption: it describes what went wrong in plain English. It is not meant to be parsed programmatically — use `code` for that.

All v1 diagnostics have `severity: 'error'`. The severity field exists to support future warning-level diagnostics (e.g., "this requirement is declared but never used") without requiring a schema change.

---

## How Diagnostics Serve UI and CI

The diagnostic design is not accidental. It reflects how the engine is expected to be used in practice.

**In a CI pipeline**: A template management system runs `validate()` on every template change. If any diagnostic is returned, the change is rejected. The diagnostics provide the CI log with exact error codes, messages, and positions — enough information to identify the problem without running the template.

**In a template editor UI**: The editor calls `validate()` as the author types (or on each save). The returned diagnostics are rendered as inline error markers: red underlines under problematic identifiers, margin icons, hover-to-read messages. The `position` field gives the editor the byte offsets it needs to place the markers accurately. The `code` field can be used to link to documentation.

**In a template review tool**: A code reviewer examining a pull request that adds a new template can run `validate()` and see all errors at once. The complete picture from the accumulating approach is particularly valuable here.

**In form generation**: `validate()` does not help with form generation — `analyze()` does that. But `validate()` is a prerequisite: it would be wrong to generate a form from a template that has errors. In a well-designed system, the form generator calls `validate()` first and only proceeds to `analyze()` if validation passes.

---

## Worked Examples

### Example 1: UNDECLARED_NAME

```
Template: "Hello ${ username }!"
```

The identifier `username` is referenced in the slot, but there is no `require({ id: 'username', ... })` anywhere in the template. Result:

```js
[{
  code: 'UNDECLARED_NAME',
  message: "Identifier 'username' is not declared in this template.",
  severity: 'error',
  position: { start: 9, end: 17 }
}]
```

**Fix**: Add `require({ id: 'username', type: string(), capability: 'user', label: 'Username' })` to the template.

### Example 2: TYPE_ERROR

```
Template: "${ 'Order #' + orderId }"
```

Assume `orderId` is declared with type `int()`. The `+` operator in Seebo is not defined between `string` and `int` (no implicit coercion). Result:

```js
[{
  code: 'TYPE_ERROR',
  message: "Operator '+' cannot be applied to operands of type 'string' and 'int'.",
  severity: 'error',
  position: { start: 3, end: 22 }
}]
```

**Fix**: Convert explicitly: `'Order #' + string(orderId)`.

### Example 3: NON_EXHAUSTIVE_MATCH

```
Template: "${ match country { case 'IT' => 'Italy', case 'DE' => 'Germany' } }"
```

The `match` has no `*` wildcard case. If `country` is `'FR'`, there is no matching case and the evaluation will fail. Result:

```js
[{
  code: 'NON_EXHAUSTIVE_MATCH',
  message: "Match expression has no wildcard case ('*'). Unmatched values will cause a runtime error.",
  severity: 'error',
  position: { start: 3, end: 66 }
}]
```

**Fix**: Add a wildcard: `case * => 'Unknown'`.

### Example 4: Clean template

```
Template: "Dear ${ require({ id: 'name', type: string(), capability: 'user', label: 'Name' }) },"
```

All names are declared, all functions are known, all capabilities are registered, no type violations detectable. Result: `[]` — an empty array. The template is valid.

---

## What validate() Cannot Catch

Understanding the limits of static validation is as important as understanding what it does catch.

**Runtime type errors with dynamic data**: If a capability provider returns a value of the wrong type despite the declared type constraint, `validate()` cannot detect this. It will be caught at runtime as a `CONSTRAINT_VIOLATION` or `TYPE_ERROR_RUNTIME` diagnostic.

**Semantic errors in capability values**: If a requirement asks for `array().constraints({ values: ['yes', 'no'] })` and the provider returns `'maybe'`, `validate()` cannot catch this — it doesn't know what the provider will return. The driver catches it at resolution time.

**Logic errors**: If the template renders the wrong output because of an incorrect condition, `validate()` won't help. It validates structure and types, not business logic.

**Performance problems**: A template that is syntactically and semantically valid can still be inefficient. The `maxSteps` limit in the evaluator will catch runaway computations, but `validate()` doesn't predict computational cost.

These limitations are inherent in static analysis of a dynamically typed system with external data sources. They are the complement to the conservative inferencer: we avoid false positives by accepting that some problems can only be caught at runtime.

---

## validate() vs analyze()

These two functions are often confused because they both operate on templates without running them. The distinction is:

- `validate()` asks: **"Is this template correct?"** It returns errors. An empty result means "no problems found." It is a quality gate.

- `analyze()` asks: **"What does this template need and do?"** It returns information. It does not report errors (though it may include diagnostic metadata). It is a discovery tool.

A template can fail `validate()` and still be partially analyzable — `analyze()` may be able to extract some requirement information even from a template with validation errors. In practice, you typically run `validate()` first, and only call `analyze()` on templates that pass validation.

Neither function runs the template. Neither requires capability providers. Neither needs any input data. Both are purely static passes over the template's AST.

---

## Conclusion

Static validation is the first non-trivial gate in Seebo's pipeline. It transforms template authoring from a "try it and see" process into a specification-driven discipline where structural errors are caught early, completely, and without side effects.

The accumulation philosophy ensures developers see all errors at once. The conservative inferencer ensures no false positives. The diagnostic design ensures that every error is precisely located and stably identified. And the distinction between validation errors, analysis information, and runtime diagnostics keeps the three concerns cleanly separated.

For teams building operational tools on Seebo — template libraries, workflow systems, CI pipelines — static validation is what makes templates reliably deployable rather than experimental.

---

## Further Reading

- `src/validate/validate.js` — the validate() implementation; how diagnostics are accumulated
- `src/validate/infer.js` — the conservative type inferencer; the 'unknown' propagation rule
- `src/util/errors.js` — DiagnosticCode enum; Diagnostic type definition
- `src/ast/nodes.js` — AST node types that the validator walks
- Article 05 in this series: "Parsing Expressions: Recursive Descent, Pratt Parsing, and AST Design"
- Article 12 in this series: "Static Analysis: Understanding Templates Without Running Them"
- Pierce, B.C. (2002). *Types and Programming Languages*. MIT Press. — Chapter 8: Typed Arithmetic Expressions; Chapter 15: Subtyping
- Aho, Lam, Sethi, Ullman (2006). *Compilers: Principles, Techniques, and Tools* (2nd ed.). — Chapter 6: Semantic Analysis
