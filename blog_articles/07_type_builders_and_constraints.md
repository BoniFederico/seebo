# Type Builders: Fluent Descriptors for Requirements and Validation

## Table of Contents

1. [Why Requirements Need Type Descriptors](#why-requirements-need-type-descriptors)
2. [Descriptor vs Value: Two Different Things](#descriptor-vs-value)
3. [The TypeBuilder API](#the-typebuilder-api)
4. [Immutability in Builders](#immutability-in-builders)
5. [Builder Methods in Detail](#builder-methods-in-detail)
6. [The optional Flag and Empty Values](#the-optional-flag)
7. [Builders as Form Field Descriptors](#builders-as-form-field-descriptors)
8. [Builders in Static Analysis](#builders-in-static-analysis)
9. [Constraint Enforcement at Resolution Time](#constraint-enforcement-at-resolution-time)
10. [The array().constraints({ values }) Enum Pattern](#the-enum-pattern)
11. [Worked Examples](#worked-examples)
12. [What This Is Not: The Intentional Limits of the Type System](#intentional-limits)
13. [Conclusion](#conclusion)
14. [Further Reading](#further-reading)

---

## Why Requirements Need Type Descriptors

When a Seebo template says:

```
${ require({ id: 'customerName', type: string(), capability: 'crm' }) }
```

the engine needs to know more than just "give me a string." It needs to know:

- What is the minimum acceptable length? (A name should not be empty.)
- What is the maximum acceptable length? (It will be inserted into a limited-width field.)
- Is the value optional, or is it required for the template to complete?
- If there is a default value and the CRM cannot provide one, should the default be used?
- When rendering a form for human input, what format or label should the field carry?

A bare type name like `'string'` cannot carry any of this. A full `Value` record cannot carry it either: a `Value` represents a concrete value that already exists, not a specification of what an acceptable value should look like.

Seebo's solution is the **TypeDescriptor** and the **TypeBuilder** that produces it. A `TypeDescriptor` is a frozen record:

```js
{
  type: 'string',
  format: { ... },         // merged from DEFAULT_FORMATS
  constraints: { minLen: 1, maxLen: 255 },
  default: undefined,      // optional: present only when .default(d) was called
}
```

The `TypeBuilder` is the immutable fluent API for constructing a `TypeDescriptor` step by step.

---

## Descriptor vs Value: Two Different Things

This distinction is easy to conflate and important to get right.

A **Value** (`src/runtime/values.js`, `makeString(...)`) is a concrete runtime datum. `makeString('Alice')` is the string "Alice." It has a type, a canonical representation, a format, and constraints. It exists at a specific point in time during evaluation.

A **TypeDescriptor** is a specification. `string().constraints({ minLen: 1 })` describes what an acceptable string must look like. It contains no actual string. It is used at two distinct moments: when a `require()` declaration in the template is analyzed (to know what type the evaluator should expect), and when a capability provider returns a value (to validate that the value satisfies the declared constraints).

The relationship: a TypeDescriptor describes the expected shape; a Value is the concrete datum that either satisfies that shape or does not.

The `TypeBuilder` is the tool you use to construct a `TypeDescriptor`. The builder is produced by calling the type name as a zero-argument function in the Seebo template language (`string()`, `int()`, `datetime()`), or programmatically by importing `builder('string')` from `src/runtime/values.js`.

---

## The TypeBuilder API

The public API for type builders, defined in `src/runtime/values.js`:

```js
export function builder(type) {
  // ...
  function make(state) {
    return Object.freeze({
      type,
      format:      (f) => make({ ...state, format:      { ...state.format,      ...sanitizeOptions(f) } }),
      constraints: (c) => make({ ...state, constraints: { ...state.constraints, ...sanitizeOptions(c) } }),
      default:     (d) => make({ ...state, hasDefault: true, default: d }),
      toDescriptor: () => {
        const desc = {
          type,
          format:      deepFreeze({ ...DEFAULT_FORMATS[type],      ...state.format }),
          constraints: deepFreeze({ ...DEFAULT_CONSTRAINTS[type],  ...state.constraints }),
        };
        if (state.hasDefault) desc.default = state.default;
        return Object.freeze(desc);
      },
    });
  }
  return make({ format: {}, constraints: {}, hasDefault: false });
}
```

The key insight is the `make` function. Every call to `.format()`, `.constraints()`, or `.default()` produces a new builder via `make({ ...state, [key]: newValue })`. The original builder is not modified. This is structural sharing of immutable state.

There is also a dual-semantics constructor:

```js
export function makeTypeConstructor(type, value) {
  if (arguments.length < 2 || value === undefined) return builder(type);
  return construct(type, value);
}
```

When called with no arguments (or one argument that is `undefined`), it returns a builder. When called with a value argument, it constructs a concrete `Value`. This is how `string()` in a template becomes a builder (no argument means "descriptor mode"), while `string('hello')` in a template becomes a string value ("construction mode").

---

## Immutability in Builders

Builders are frozen with `Object.freeze`. This matters because builders are typically created once and shared. Consider a library that defines a reusable requirement descriptor:

```js
const nameType = string().constraints({ minLen: 1, maxLen: 100 });

// Template A
require({ id: 'firstName', type: nameType, capability: 'user' })
// Template B
require({ id: 'lastName',  type: nameType, capability: 'user' })
```

If `nameType` were mutable, a call like `nameType.constraints({ maxLen: 50 })` in one context could accidentally affect the other. With immutable builders, every method call produces a new independent builder. `nameType` is unchanged. Template A and Template B each have their own frozen descriptor derived from `nameType`, and modifying one's constraints requires creating a new builder, leaving the original intact.

This is the builder pattern implemented with persistent data structures rather than with cloning and mutation.

---

## Builder Methods in Detail

### `.constraints(obj)`

Merges additional constraint properties into the builder's constraint state. The argument must be a plain object (sanitized against prototype pollution). Returns a new builder.

Constraint keys vary by type:
- `string`: `minLen`, `maxLen` (character counts)
- `int`, `float`: `min`, `max` (numeric bounds)
- `datetime`, `duration`: `min`, `max` (epoch ms or seconds bounds); `precision` for datetime
- `array`: `minLen`, `maxLen` (element count); `values` (allowlist of permitted elements)

Constraints from the builder merge with defaults. A `float` builder always has `precision: 2` in its constraints by default; calling `.constraints({ min: 0 })` produces `{ precision: 2, min: 0 }`, not `{ min: 0 }` alone.

### `.format(obj)`

Merges display formatting properties. Format keys vary by type:
- `int`, `float`: `thousands` (separator character), `decimalSep` for float
- `bool`: `trueLabel`, `falseLabel`
- `datetime`: `pattern` (format string like `'YYYY-MM-DD'`)
- `duration`: `pattern`

Format options affect how a value is rendered to text but not its semantic value.

### `.default(value)`

Records a default value to be used when the capability cannot provide one. The default value is stored as-is (not type-checked at builder construction time). It will be converted to a `Value` via `fromJs` when actually used by the evaluator.

```js
const countType = int().default(0).constraints({ min: 0 });
```

If the capability for a requirement with `type: countType` returns `undefined`, the evaluator uses `fromJs(0)` = `int(0)` as the value. The `optional: true` flag (on the requirement, not the builder) is a separate mechanism — it produces the type's "empty value" rather than a specific default.

### `.toDescriptor()`

Finalizes the builder into an immutable `TypeDescriptor`. This is called automatically when a builder expression in a template is evaluated by `evalTypeExpr` in `src/eval/symbols.js`. Direct callers can use it programmatically:

```js
const desc = string().constraints({ minLen: 1, maxLen: 100 }).toDescriptor();
// {
//   type: 'string',
//   format: {},
//   constraints: { minLen: 1, maxLen: 100 },
// }
```

---

## The optional Flag and Empty Values

The `optional` flag is a property of the `RequirementDescriptor`, not of the `TypeBuilder`. It lives at the level of the `require({...})` call:

```js
require({ id: 'middleName', type: string(), capability: 'user', optional: true })
```

When `optional: true`, the resolution precedence in the evaluator is:

1. Already in `state.resolved` → use it.
2. Type builder has a `.default(...)` → use that default.
3. `optional: true` → use the type's empty value (`emptyValue(type)`).
4. Otherwise → emit `Susp(Need)`.

The "empty value" is defined per type:
- `string` → `''`
- `array`  → `[]`
- `object` → `{}`
- `int`    → `0`
- `float`  → `0.0`
- `bool`   → `false`
- `duration` → `makeDuration(0)`
- `datetime` → `makeDatetime(0)` (epoch)

The `??` (nullish coalesce) operator in the expression language tests for empty values (not for `null` — Seebo has no null). So `middleName ?? 'N/A'` returns `'N/A'` when `middleName` resolved to the empty string via `optional: true`.

---

## Builders as Form Field Descriptors

A key observation: the `TypeDescriptor` contains exactly the information needed to render a UI form field. This is not accidental — it is part of the design. Seebo's `analyze()` function extracts the full list of requirements from a template, each carrying its `TypeDescriptor`. An application that needs to build a form for user input can walk this list and render fields:

- A `string().constraints({ minLen: 1, maxLen: 100 })` descriptor → a text input with minlength=1, maxlength=100.
- An `int().constraints({ min: 0, max: 100 })` descriptor → a numeric input with min=0, max=100.
- An `array().constraints({ values: ['Gentile', 'Caro', 'Egregio'] })` descriptor → a dropdown with three options.
- A `datetime().constraints({ precision: 'day' })` descriptor → a date picker with day granularity.
- An `optional: true` requirement → a field that may be left blank.

The `label` and `description` fields on the `RequirementDescriptor` (not the TypeDescriptor) provide human-readable hints that can be used as form labels and tooltips.

This bidirectional flow — template declares requirements, form renders fields, user fills fields, values flow back to engine — is the primary use case for the type builder API. The builder is both a validator and a UI specification.

---

## Builders in Static Analysis

The `validate()` function uses type descriptors during static analysis. It can detect:

- A call to a type constructor with an argument of the wrong type: `datetime(42.5)` where the spec requires an integer-compatible input.
- A constraint that will obviously be violated by a literal: `string().constraints({ maxLen: 3 })` applied to a literal `'hello'` (length 5) can be flagged statically.
- Enum constraints: if a template references `status in ['a', 'b']` and the requirement for `status` declares `array().constraints({ values: ['a', 'b'] })`, the validator can confirm consistency.

The inferencer in `src/validate/infer.js` does conservative type inference. When the type of a `require(...)` is statically known from the descriptor (which it always is — descriptors are constant expressions), the validator can propagate the type through the expression tree.

---

## Constraint Enforcement at Resolution Time

When a capability provider returns a value, the async driver enforces constraint validation before accepting it:

```js
value = withConstraints(withFormat(value, need.type?.format), need.type?.constraints);
const violation = validate(value);
if (violation) return { kind: ProviderOutcome.INVALID_VALUE, message: violation.message };
```

The `validate` function from `values.js` checks the value's constraints:
- `minLen`/`maxLen` for strings and arrays.
- `min`/`max` for numbers, datetimes, and durations.
- `values` for array element membership.

A constraint violation from a capability provider produces `CAPABILITY_INVALID_VALUE` — a distinct error code from a runtime type error — making it clear that the problem is in the provider's output, not in the template's logic.

Also important: the type check is enforced first. If a requirement declares `type: int()` and the provider returns `'forty-two'` (a string), the driver catches the type mismatch before constraint validation even runs:

```js
const wantType = need.type?.type;
if (wantType && value.type !== wantType) {
  return { kind: ProviderOutcome.INVALID_VALUE, message: `expected ${wantType}, got ${value.type}` };
}
```

This enforcement boundary is the primary security guarantee for the type system: template authors cannot be surprised by unexpected types from capabilities.

---

## The Enum Pattern

The pattern `array().constraints({ values: ['yes', 'no'] })` deserves its own treatment. In Seebo, there is no dedicated `enum` type. Instead, enums are modeled as arrays with a `values` constraint that restricts the allowable elements.

This might seem roundabout, but it has practical advantages:

1. **A single value from an enum set is still a string**, not a special type. The `in` operator checks membership: `answer in ['yes', 'no']`. The stringifier handles it naturally.

2. **The `values` allowlist is checked at resolution time** (when the capability provides the value) and also accessible to form generators (to render a dropdown with the given options).

3. **Enum sets can be dynamically composed** within the constraint declaration, since `values` is just an array literal in the template's object literal syntax.

The `validate` function in `values.js` handles the check:

```js
case 'array': {
  const arr = value.value;
  if (Array.isArray(c.values)) {
    for (const el of arr) {
      if (!c.values.some((allowed) => jsonEqual(allowed, el))) {
        return violation('values', el);
      }
    }
  }
  return null;
}
```

However, the enum pattern is commonly used with a single `string` value rather than an `array`. In that case, the `require` type would be `string()` and the validation against the set is handled in the template expression via the `in` operator or a `match` construct, not via array constraints.

---

## Worked Examples

### String with Length Constraints

```js
// Programmatic (in application code)
import { builder } from './src/runtime/values.js';
const nameType = builder('string')
  .constraints({ minLen: 1, maxLen: 255 })
  .toDescriptor();
// { type: 'string', format: {}, constraints: { minLen: 1, maxLen: 255 } }

// In a template
require({ id: 'fullName', type: string().constraints({ minLen: 1, maxLen: 255 }),
          capability: 'user', label: 'Full name' })
```

### Integer with Range and Default

```js
const retryType = builder('int')
  .default(3)
  .constraints({ min: 0, max: 10 })
  .toDescriptor();
// { type: 'int', format: { thousands: '' },
//   constraints: { min: 0, max: 10 }, default: 3 }
```

If no capability provides a value for this requirement, `fromJs(3)` = `int(3)` is used.

### Float with Precision

```js
const priceType = builder('float')
  .constraints({ precision: 4, min: 0 })
  .toDescriptor();
// { type: 'float', format: { decimalSep: ',', thousands: '' },
//   constraints: { precision: 4, min: 0 } }
```

`precision: 4` overrides the default of 2, so prices render with four decimal places.

### Datetime with Day Precision

```js
const dateType = builder('datetime')
  .constraints({ precision: 'day' })
  .format({ pattern: 'DD/MM/YYYY' })
  .toDescriptor();
// { type: 'datetime',
//   format: { pattern: 'DD/MM/YYYY' },
//   constraints: { precision: 'day' } }
```

The `precision: 'day'` tells both the stringifier and any form date-picker that time-of-day components are irrelevant.

### Enum via Array Constraint

```js
// In a template
require({
  id: 'salutation',
  type: array().constraints({ values: ['Gentile', 'Caro', 'Egregio'] }),
  capability: 'user',
  label: 'Salutation'
})
```

A form generator reads `constraints.values` and renders a dropdown with three options. The driver validates that the returned value is one of those three.

---

## Intentional Limits

It is worth being explicit about what Seebo's type system does not do, and why.

**No type inference chains.** In a full type system like TypeScript or ML, the type of `x + y` can be inferred from the declared types of `x` and `y` transitively through arbitrarily deep expression trees. Seebo's static inferencer (`src/validate/infer.js`) does perform shallow type inference for the validator, but it is conservative: any expression whose type cannot be determined from literal structure or direct requirement declarations collapses to `'unknown'`, which suppresses checks rather than producing false positives.

**No generic types.** There is no `Array<string>` in Seebo — just `array`. An array constraint specifies a fixed set of allowed values for the entire array, not a parameterized element type. This is intentional: template authors work with concrete data, not type variables.

**No type aliases or user-defined types (beyond `defineType`).** You cannot create `type Email = string().constraints({ minLen: 5 })` and refer to it by name inside a template. You repeat the builder expression. This keeps the template language simple and eliminates a source of naming conflicts.

**No null or undefined.** The `optional` flag produces a type's empty value, not null. The `??` operator handles the empty-to-default pattern. This avoids the billion-dollar mistake while keeping the model tractable.

These are choices, not limitations. The type system is sized to the problem: providing enough structure to enable form generation, constraint validation, and useful static analysis, without the overhead of a full type-theoretic apparatus.

---

## Conclusion

Type builders in Seebo are the mechanism by which a template author specifies not just what type a requirement has, but what constraints it must satisfy, what default to use if no value is provided, and what format to use when rendering it. The builder API is fluent and immutable: each method call returns a new frozen builder, allowing builders to be shared and reused safely.

Builders serve three roles simultaneously: as validators (constraints are enforced at resolution time), as form field descriptors (the `analyze()` output exposes them to application code), and as static analysis inputs (the validator reads them to detect type errors at analysis time). This unification — one descriptor, three uses — is what makes the design economical.

---

## Further Reading

- `src/runtime/values.js` — the `builder` function and `TypeDescriptor`/`TypeBuilder` typedefs.
- `src/eval/symbols.js` — `evalTypeExpr` and `evalTypeBuilder`, which parse builder expressions from AST nodes.
- `src/driver/async_driver.js` — `callProvider`, which enforces type and constraint validation on provider output.
- `src/validate/validate.js` — how constraint descriptors are used in static validation.
- The Builder pattern in object-oriented design, and persistent data structures in functional programming — both inform the immutable builder design.

---
