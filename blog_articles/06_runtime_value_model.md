# The Runtime Value Model: Typed, Immutable, and Explicit

## Table of Contents

1. [Why Plain JavaScript Values Are Insufficient](#why-plain-javascript-values-are-insufficient)
2. [The Value Record](#the-value-record)
3. [Why Frozen POJOs](#why-frozen-pojos)
4. [The Eight Types](#the-eight-types)
5. [Normalization from JavaScript: fromJs](#normalization-from-javascript)
6. [Temporal Arithmetic Rules](#temporal-arithmetic-rules)
7. [Deterministic Conversion](#deterministic-conversion)
8. [Prototype-Pollution Hardening](#prototype-pollution-hardening)
9. [Worked Examples](#worked-examples)
10. [Conclusion](#conclusion)
11. [Further Reading](#further-reading)

---

## Why Plain JavaScript Values Are Insufficient

JavaScript's own type system was not designed for template engines. A bare JavaScript number carries no information about whether it represents an integer, a floating-point quantity, a duration measured in seconds, or an epoch timestamp. The string `'2026-06-27'` could be a date, or it could be the name of a product version. The number `0` might be the integer zero, the float 0.0, a duration of zero seconds, or the epoch itself (1970-01-01T00:00:00Z). Without additional metadata, these are indistinguishable.

This ambiguity matters because:

1. **Display behavior is type-dependent.** An integer `42` formats as `42`. A float `42.0` with `precision: 2` formats as `42.00`. A duration of 3600 seconds formats as `01:00:00`. You cannot format correctly without knowing the type.

2. **Arithmetic rules are type-dependent.** Adding two integers produces an integer. Dividing any two numbers produces a float (because the result may not be integral). Adding a datetime to a duration produces a datetime. Adding two datetimes is a type error.

3. **Constraint validation is type-dependent.** A string's constraint is `minLen`/`maxLen`. A numeric type's constraint is `min`/`max`. An array's constraint is `values` (an allowlist).

4. **Static analysis requires observable types.** The validator needs to know, at analysis time, what type a `+` operator's operands will have at runtime in order to detect `TYPE_ERROR` before the template is ever run.

Plain JavaScript values address none of these concerns. Seebo therefore defines an explicit value model: every runtime value is a typed record that carries its type name, its canonical JavaScript representation, its display format, and its validity constraints. The implementation lives in `src/runtime/values.js`.

---

## The Value Record

Every value flowing through Seebo's evaluation is an immutable record of this shape:

```js
{
  type:        string,                    // one of the eight type names
  value:       /* type-specific */,       // canonical JS representation
  format:      Record<string, unknown>,   // display options (frozen)
  constraints: Record<string, unknown>,   // validity rules (frozen)
}
```

The JSDoc typedef is:

```js
/**
 * @typedef {Object} Value
 * @property {string} type
 * @property {unknown} value
 * @property {Record<string, unknown>} format
 * @property {Record<string, unknown>} constraints
 */
```

No field is optional. Every value — even one constructed with no explicit format or constraint — receives the type's defaults merged in at construction time. The `makeValue` internal factory enforces this:

```js
function makeValue(type, value, opts = {}) {
  const format = deepFreeze({ ...DEFAULT_FORMATS[type], ...sanitizeOptions(opts.format) });
  const constraints = deepFreeze({
    ...DEFAULT_CONSTRAINTS[type],
    ...sanitizeOptions(opts.constraints),
  });
  return Object.freeze({ type, value, format, constraints });
}
```

The defaults for each type are:

```js
export const DEFAULT_FORMATS = Object.freeze({
  int:      { thousands: '' },
  float:    { decimalSep: ',', thousands: '' },
  bool:     { trueLabel: 'true', falseLabel: 'false' },
  string:   {},
  datetime: { pattern: 'YYYY-MM-DDTHH:mm:ssZ' },
  duration: { pattern: 'HH:mm:ss' },
  object:   {},
  array:    {},
});

export const DEFAULT_CONSTRAINTS = Object.freeze({
  int:      {},
  float:    { precision: 2 },
  bool:     {},
  string:   {},
  datetime: { precision: 'second' },
  duration: { precision: 'second' },
  object:   {},
  array:    { minLen: 0 },
});
```

So a `float` value always knows it has two decimal places by default; a `datetime` always knows its finest granularity is `'second'` by default; an `array` always knows its minimum length is 0 by default.

---

## Why Frozen POJOs

The choice to make every value a frozen POJO — `Object.freeze({ type, value, format, constraints })` — is deliberate and has two motivations.

The first is **correctness**. Values are passed freely through the evaluator, operator functions, method functions, and the stringifier. None of those functions should be able to mutate a value and inadvertently affect other consumers of the same value. Freezing turns accidental mutation into a silent no-op in non-strict mode and a TypeError in strict mode. Since Seebo's source files are all ESM modules (which are automatically strict), a mutation attempt will throw immediately, making bugs easy to find during development.

The second is **serializability**. A frozen POJO can be transmitted over any JSON channel, stored in a database, or persisted to disk. No class deserialization logic is needed. The `serialize` and `deserialize` functions in `values.js` handle the one case that requires care — `object` and `array` values contain nested data that must be deep-copied defensively on serialization:

```js
export function serialize(value) {
  const out = { type: value.type, value: value.value,
                format: value.format, constraints: value.constraints };
  if (value.type === 'object' || value.type === 'array') {
    out.value = sanitizeJson(value.value); // defensive deep copy
  }
  return out;
}
```

Immutability also pairs naturally with Seebo's pure functional state machine: `run(state) → newState` never mutates the old state. Values in `state.resolved` are simply referenced by the new state unchanged.

---

## The Eight Types

### int

Canonical representation: a JavaScript `number` that satisfies `Number.isInteger`. The factory rejects non-integer inputs:

```js
export function makeInt(n, opts) {
  if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n)) {
    throw typeError(`int requires an integer number, got ${describe(n)}`);
  }
  return makeValue('int', n, opts);
}
```

Seebo does not currently enforce 32-bit or 64-bit limits at the factory level, but the specification mentions them as constraints. JavaScript numbers are 64-bit IEEE 754 doubles, which represent integers exactly up to 2^53. Integers beyond that lose precision silently. For most document template use cases — counts, indices, quantities — this is not a concern.

Integer arithmetic: `int + int = int`, `int - int = int`, `int * int = int`. Division is always float, even `4 / 2 = float(2.0)`, because the result type of division cannot in general be known statically to be integral.

### float

Canonical representation: a JavaScript `number` that is finite. The default constraint is `precision: 2`, which the stringifier uses when rendering: a float value is rounded to 2 decimal places by default.

```js
export function makeFloat(n, opts) {
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw typeError(`float requires a finite number, got ${describe(n)}`);
  }
  return makeValue('float', n, opts);
}
```

The distinction between `int` and `float` in the type system — even though JavaScript uses the same underlying number type — matters for rendering and for operator overloading. `int + int` stays integral. `int + float` promotes to `float` (via the `num` helper in `operators.js`). This gives the template author explicit control over what kind of number they are working with.

### bool

Canonical representation: a JavaScript `boolean`. The format includes `trueLabel` and `falseLabel`, defaulting to `'true'` and `'false'`. An application might set `trueLabel: 'Yes'` and `falseLabel: 'No'` for user-facing output.

### string

Canonical representation: a JavaScript `string`. Seebo treats strings as immutable UTF-8 sequences. String concatenation is supported via `+`: `string + string = string`. There is no implicit coercion between string and non-string types: `'hello' + 42` is a TYPE_ERROR, not `'hello42'`. If you want that, you write `'hello' + string(42)`.

Constraints: `minLen` and `maxLen` (character count, not byte count).

### datetime

Canonical representation: a JavaScript integer — epoch milliseconds UTC, truncated at construction by `Math.trunc`. This is a deliberate choice of representation that avoids a class dependency. JavaScript's `Date` object is not used as the canonical form because it is mutable, not serializable as a POJO, and carries timezone ambiguity.

```js
export function makeDatetime(epochMs, opts) {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) {
    throw typeError(`datetime requires a finite epoch-ms number, got ${describe(epochMs)}`);
  }
  return makeValue('datetime', Math.trunc(epochMs), opts);
}
```

The `precision` constraint specifies the finest granularity that matters for this datetime: `'year'`, `'month'`, `'day'`, `'hour'`, `'minute'`, or `'second'`. This affects display (a `'day'` precision datetime shows only the date part) and comparison semantics.

The precision order is:
```js
export const PRECISION_ORDER = Object.freeze(
  ['year', 'month', 'day', 'hour', 'minute', 'second']
);
```

Coarser precisions appear earlier. When two datetimes are combined in arithmetic, the result's precision is the finer (higher index) of the two.

### duration

Canonical representation: a JavaScript number of seconds. The design decision to use seconds as the canonical unit deserves elaboration.

Why not milliseconds? That is what JavaScript's `Date` uses, and it would make conversion trivial. The answer is that seconds are the standard SI unit for time intervals, and they are readable: `3600` is recognizably one hour, `86400` is recognizably one day.

Why not days, weeks, or months? This is where the calendar ambiguity argument applies. A "month" is ambiguous: it could be 28, 29, 30, or 31 days depending on which month and which year. A "year" is similarly ambiguous (365 vs 366 days). These ambiguities make arithmetic non-deterministic in a way that is impossible to resolve without knowing a specific calendar context. Seebo's core is supposed to be pure and deterministic. Therefore durations are restricted to seconds, minutes, hours, days, and weeks — all of which have fixed conversions to seconds:

```js
export const DURATION_UNITS = Object.freeze({
  second: 1,
  minute: 60,
  hour:   3600,
  day:    86400,
  week:   604800,
});
```

A duration can be negative (representing a past offset). Duration arithmetic is closed under these rules.

### object

Canonical representation: a sanitized plain JavaScript object — a POJO with string keys and JSON-compatible values. The input is deep-cloned and sanitized by `sanitizeJson` (see the section on prototype-pollution hardening below).

Object member access is provided by `objectGet(value, key)`, which converts the raw JSON value at the key back into a typed `Value` via `fromJs`. This means reading `obj.count` where `count: 42` returns an `int` value, not a bare number.

### array

Canonical representation: a sanitized JavaScript array of JSON-compatible items. Like `object`, the input is deep-sanitized. Array index access is provided by `arrayGet(value, i)`, which similarly converts each element back into a typed `Value` on access.

Array constraints support `minLen`, `maxLen`, and `values` (an allowlist of permitted elements). The `values` constraint is the primary mechanism for enum-like semantics in Seebo.

---

## Normalization from JavaScript: fromJs

External data — from capability providers, from the `values` map passed to `start()`, from template literals in descriptors — is raw JavaScript. The `fromJs` function converts it to a typed `Value`:

```js
export function fromJs(input) {
  if (isValue(input)) return input;
  if (input === null || input === undefined) {
    throw typeError('cannot infer a value from null/undefined');
  }
  const t = typeof input;
  if (t === 'boolean') return makeBool(input);
  if (t === 'number') {
    const n = input;
    if (!Number.isFinite(n)) throw typeError('...');
    return Number.isInteger(n) ? makeInt(n) : makeFloat(n);
  }
  if (t === 'string') return makeString(input);
  if (input instanceof Date) return makeDatetime(input.getTime());
  if (Array.isArray(input)) return makeArray(input);
  if (t === 'object') return makeObject(input);
  throw typeError(`cannot infer a value from '${t}'`);
}
```

Several decisions are notable:

**Strings are strings, not datetimes.** If a capability returns the JavaScript string `'2026-06-27'`, `fromJs` produces a `string` value, not a `datetime`. This is intentional. Automatic parsing of date strings is a notorious source of bugs (which format? which timezone? which locale?). In Seebo, if you want a datetime from a string, you call `datetime('2026-06-27')` explicitly in the template, which invokes the ISO-8601 parser. The `fromJs` path remains naive by design.

**Integer vs float is determined by `Number.isInteger`.** A JavaScript `42` becomes an `int`; `42.5` becomes a `float`. This is consistent and predictable. If a capability provider wants to supply a float, it must return `42.0` from a computation that preserves the decimal (e.g., `42 / 1.0`), or it can return a pre-built `Value` record directly (which `fromJs` passes through unchanged).

**Existing Values pass through unchanged.** If the input is already a well-formed `Value` (detected by `isValue`), it is returned as-is. This allows providers and internal logic to build typed values directly using the factory functions and pass them through `fromJs` without double-wrapping.

**`null` and `undefined` are rejected.** There is no nullable type in Seebo. The `??` operator handles the "empty" case for `string`, `array`, and `object` (which have well-defined empty values: `''`, `[]`, `{}`). Numeric and boolean types have no meaningful "empty" value, so nulls must not silently coerce.

---

## Temporal Arithmetic Rules

The operator implementations in `src/eval/operators.js` implement a typed arithmetic over the eight base types. Temporal arithmetic is the most complex subset:

```
datetime + duration = datetime   (offset a point in time forward)
duration + datetime = datetime   (commutative)
datetime - duration = datetime   (offset a point in time backward)
datetime - datetime = duration   (elapsed time between two points)
duration + duration = duration   (total of two intervals)
duration - duration = duration   (difference of two intervals)
duration * int     = duration    (scale an interval)
duration * float   = duration    (scale an interval by a non-integer factor)
int      * duration = duration   (commutative)
duration / int     = duration    (shrink an interval)
duration / float   = duration    (shrink by a non-integer factor)
duration / duration = float      (dimensionless ratio)
```

Forbidden combinations (TYPE_ERROR):
```
datetime + datetime  (no meaning: what is "June + June"?)
int      + datetime  (implicit promotion would be unsound)
float    + datetime  (same)
```

The implementation:

```js
function add(a, b) {
  // temporal
  if (a.type === 'datetime' && b.type === 'duration')
    return makeDatetime(num2(a) + num2(b) * 1000);
  if (a.type === 'duration' && b.type === 'datetime')
    return makeDatetime(num2(b) + num2(a) * 1000);
  if (a.type === 'duration' && b.type === 'duration')
    return makeDuration(num2(a) + num2(b));
  if (a.type === 'datetime' && b.type === 'datetime')
    throw typeErr('+', 'cannot add two datetimes');
  // numeric
  if (isNumeric(a) && isNumeric(b)) return num(num2(a) + num2(b), a, b);
  throw typeErr('+', `${a.type} + ${b.type}`);
}
```

The conversion factor between the datetime representation (milliseconds) and the duration representation (seconds) appears here as the literal `1000`. When adding a duration to a datetime, the duration in seconds is multiplied by 1000 to convert to milliseconds before adding.

Subtracting two datetimes:

```js
function subtract(a, b) {
  if (a.type === 'datetime' && b.type === 'datetime')
    return makeDuration((num2(a) - num2(b)) / 1000);
  // ...
}
```

The result is divided by 1000 to convert from milliseconds to seconds, yielding a `duration` value.

**Precision propagation** is not currently enforced in the arithmetic operators at the value level — that is, the `precision` constraint on the result is not automatically set to the finer of the two operands' precisions. This is a display-layer concern: the stringifier reads the precision from the format/constraints of the value being rendered. In practice, precision tracking is a concern for the type builder API when constructing requirements, not for individual arithmetic results.

---

## Deterministic Conversion

Seebo's value model is fully specified. There are no "implementation-defined" or "locale-dependent" behaviors in the core value layer. Every `fromJs` conversion follows a fixed decision tree. Every operator produces a known output type for each valid input type combination. Every invalid combination throws a `SeeboError` with `TYPE_ERROR_RUNTIME` rather than producing a silently wrong result.

This determinism is not just a quality property — it is a design requirement. The `analyze()` function performs static type inference to predict, at analysis time, what types expressions will produce at runtime. If the runtime type rules were non-deterministic or locale-dependent, static analysis would be impossible. The value model is the ground truth that both runtime evaluation and static analysis must agree on.

---

## Prototype-Pollution Hardening

The `sanitizeJson` function in `src/runtime/sanitize.js` is called on every `object` and `array` value at construction time. It deep-clones the input, applying these rules:

1. **Drop `__proto__` keys.** Assignment to `__proto__` triggers the prototype setter, potentially replacing `Object.prototype` for all objects in the process. The sanitizer skips this key entirely:

   ```js
   if (key === '__proto__') continue;
   ```

2. **Reject non-plain objects.** Class instances, `Date` objects, `Map`s, `Set`s, and any object whose prototype is not `Object.prototype` or `null` are rejected. Only plain data is allowed.

3. **Reject functions, symbols, and bigints.** These types are not JSON-serializable and have no representation in Seebo's type system.

4. **Reject non-finite numbers.** `Infinity`, `-Infinity`, and `NaN` are not valid JSON values. They also cannot be serialized meaningfully.

5. **Detect circular references.** A `WeakSet` tracks objects currently being visited. If an object is seen again before its subtree is complete, the sanitizer throws.

6. **Enforce depth and node count limits.** `maxDepth: 100` and `maxNodes: 100_000` prevent pathologically deep or large inputs from consuming unbounded memory.

The clone is built using `Object.defineProperty` rather than direct assignment, so no inherited setter can intercept the key:

```js
Object.defineProperty(out, key, {
  value: clone(obj[key], depth + 1),
  writable: true, enumerable: true, configurable: true,
});
```

A similar guard appears in `run.js` for the `resolved` map — requirement IDs in templates are untrusted strings, and a requirement with `id: '__proto__'` could otherwise corrupt the prototype:

```js
export function safeSet(obj, key, value) {
  Object.defineProperty(obj, key, {
    value, writable: true, enumerable: true, configurable: true
  });
}
```

These protections are belt-and-suspenders: the sanitizer handles object values at construction time, and `safeSet` handles requirement IDs at resolution time.

---

## Worked Examples

### Creating Each Value Type

```js
import {
  makeInt, makeFloat, makeBool, makeString,
  makeDatetime, makeDuration, makeObject, makeArray
} from './src/runtime/values.js';

const i  = makeInt(42);
// { type: 'int', value: 42, format: { thousands: '' }, constraints: {} }

const f  = makeFloat(3.14159);
// { type: 'float', value: 3.14159, format: { decimalSep: ',', ... },
//   constraints: { precision: 2 } }

const b  = makeBool(true);
// { type: 'bool', value: true, format: { trueLabel: 'true', falseLabel: 'false' },
//   constraints: {} }

const s  = makeString('hello');
// { type: 'string', value: 'hello', format: {}, constraints: {} }

const dt = makeDatetime(Date.UTC(2026, 5, 27)); // June 27, 2026 UTC
// { type: 'datetime', value: 1782518400000, format: { pattern: 'YYYY-MM-DDTHH:mm:ssZ' },
//   constraints: { precision: 'second' } }

const dur = makeDuration(3600); // one hour in seconds
// { type: 'duration', value: 3600, format: { pattern: 'HH:mm:ss' },
//   constraints: { precision: 'second' } }

const obj = makeObject({ name: 'Alice', age: 30 });
// { type: 'object', value: { name: 'Alice', age: 30 }, format: {}, constraints: {} }

const arr = makeArray(['a', 'b', 'c']);
// { type: 'array', value: ['a', 'b', 'c'], format: {}, constraints: { minLen: 0 } }
```

### Temporal Arithmetic

```js
import { applyBinary } from './src/eval/operators.js';

const meeting   = makeDatetime(Date.UTC(2026, 5, 27, 9, 0, 0)); // 09:00 UTC
const twoHours  = makeDuration(7200);                            // 7200 seconds

const end = applyBinary('+', meeting, twoHours);
// { type: 'datetime', value: <11:00 UTC epoch ms>, ... }

const elapsed = applyBinary('-', end, meeting);
// { type: 'duration', value: 7200, ... }

const doubled = applyBinary('*', twoHours, makeInt(2));
// { type: 'duration', value: 14400, ... }  (4 hours)
```

### Invalid Combinations

```js
// datetime + datetime — TYPE_ERROR
applyBinary('+', meeting, meeting);
// throws SeeboError: type error in '+': cannot add two datetimes

// int + datetime — TYPE_ERROR
applyBinary('+', makeInt(1000), meeting);
// throws SeeboError: type error in '+': int + datetime

// string + int — TYPE_ERROR (no implicit coercion)
applyBinary('+', makeString('count: '), makeInt(5));
// throws SeeboError: type error in '+': no implicit coercion between string and int
```

### fromJs Behavior

```js
fromJs(42)          // → int(42)
fromJs(42.0)        // → int(42)  — JavaScript 42.0 satisfies Number.isInteger
fromJs(42.5)        // → float(42.5)
fromJs('2026-06-27')// → string('2026-06-27') — NOT a datetime
fromJs(new Date())  // → datetime(epochMs)      — Date instance IS converted
fromJs(null)        // → throws: cannot infer from null/undefined
fromJs(true)        // → bool(true)
```

---

## Conclusion

Seebo's value model is an explicit, typed, immutable layer between JavaScript's dynamic runtime and the engine's semantics. Every value carries its type, its canonical representation, its display format, and its constraints as a frozen POJO. The eight base types cover the full range of document data: numbers in two forms, booleans, strings, temporal quantities in two forms, structured objects, and ordered arrays.

The type rules are fully specified, allowing both the evaluator and the static analyzer to agree on what type each expression produces. Temporal arithmetic follows a complete algebra with no ambiguous cases. Prototype-pollution hardening is applied at every untrusted boundary. The `fromJs` inference function is intentionally conservative: it converts only what is unambiguous, refusing to silently parse date strings or coerce nulls.

---

## Further Reading

- `src/runtime/values.js` — the complete implementation: factories, `fromJs`, equality, comparison, constraint validation, serialization, and the type builder.
- `src/runtime/sanitize.js` — the `sanitizeJson` function and its security rationale.
- `src/eval/operators.js` — arithmetic and comparison operators, including the full temporal algebra.
- `src/runtime/stringify.js` — how values are converted to display strings, using the `format` field.
- IEEE 754 double-precision floating point — the underlying representation for `int` and `float` values in JavaScript.

---
