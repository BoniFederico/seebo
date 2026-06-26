# Usage & Extensibility

Practical examples for using Seebo and extending it (SPEC §2.6). For the internal design
see [`ARCHITECTURE.md`](ARCHITECTURE.md); the normative behaviour is in
[`initial_docs/spec.md`](initial_docs/spec.md) and [`initial_docs/impl.md`](initial_docs/impl.md).

## Creating an engine

```js
import { createEngine, builtins } from 'seebo';

const engine = createEngine({
  ...builtins.all,
  capabilities: {
    user: () => undefined, // interactive: its Needs are returned to the caller
    crm: (req) => ({ ordine: { id: 42 } })[req.id], // a "data" capability
  },
  locale: 'it-IT',
});

const res = await engine.stebo({
  template: "Order ${ crm({ id:'ordine', type:object() }).id }",
});
console.log(res.output); // "Order 42"
```

`createEngine` binds the vocabulary once and **fails fast** on an invalid name (see
[Name governance](#name-governance)). The returned engine exposes the SPEC §2.3–§2.5 methods
(`tokenize`, `parse`, `validate`, `analyze`, `start`, `run`, `expand`, `finalize`, `drive`,
`stebo`).

## Extensibility (SPEC §2.6)

All extensions are created with a `define*` factory that returns a **frozen descriptor**, then
passed to `createEngine`. Names are validated/reserved when the engine is built.

> **Security model.** Extension implementations are **trusted host code** registered at engine
> construction. Their `eval`/`resolve` functions receive **plain JS values** (never internal
> typed `Value`s) and their results are re-wrapped and sanitized by the engine via the runtime's
> `fromJs` inference. There is no `eval` of template text.

### Custom functions — `defineFunction`

A function is a **producer** (no `receiver`) or a **transformer/method** (on a `receiver`
type). The `eval` implementation works on plain JS values; for a transformer the receiver is
passed first.

```js
import { defineFunction } from 'seebo';

const Greeting = defineFunction('greeting', {
  arity: { min: 0, max: 0 },
  eval: () => 'Hello', // producer:  ${ greeting() }
});

const Slugify = defineFunction('slugify', {
  receiver: 'string', // transformer: ${ 'Hello World'.slugify() }
  arity: { min: 0, max: 0 },
  eval: (self) => self.toLowerCase().replace(/\s+/g, '-'),
});

const engine = createEngine({ functions: [Greeting, Slugify] });
engine.run(engine.start('${ greeting() }')).output; //=> "Hello"
engine.run(engine.start("${ 'Hello World'.slugify() }")).output; //=> "hello-world"
```

Builtin methods always win: a custom transformer named like a builtin (e.g. `upper`) is never
reached. A wrong argument count yields an `ARITY_MISMATCH` diagnostic and a `failed` state.

### Custom libraries — `defineLibrary`

A library groups producer functions under a namespace, invoked as `ns.fn()`.

```js
import { defineLibrary } from 'seebo';

const Geo = defineLibrary('geo', {
  functions: {
    zip: { arity: { min: 0, max: 0 }, eval: () => '00100' },
  },
});

const engine = createEngine({ libraries: [Geo] });
engine.run(engine.start('${ geo.zip() }')).output; //=> "00100"
```

A plain string in `libraries` (e.g. `libraries: ['fake']`) only **enables** the namespace for
parsing; calling an unregistered `ns.fn()` is an `UNKNOWN_FUNCTION` diagnostic.

### Custom capabilities — `defineCapability`

A capability resolves a `require`. Register its `resolve` under the matching key of
`capabilities` (the driver's wiring point). The capability name automatically becomes a
producer (the `require` sugar of SPEC §1.6).

```js
import { defineCapability } from 'seebo';

const Weather = defineCapability('weather', {
  resolve: async (req) => fetchForecast(req.resolverHints?.city),
});

const engine = createEngine({ capabilities: { [Weather.name]: Weather.resolve } });
// Template: ${ weather({ id:'today', type:string() }) }
```

### Custom macros — `defineMacro`

A macro is an **aggregator** (pre-pass, `expand`) or a **layout** macro (post-pass,
`finalize`). The family is taken from `family` (or derived from `phase`).

A **layout** macro may carry an `apply(slot, doc)` that FINALIZE runs on the macro's emitted
marker: `slot = { name, args, start, end }` (raw source `args`), `doc = { text }` is the full
document, and the return value (coerced to string) **replaces the marker span**.

```js
import { defineMacro } from 'seebo';

const Banner = defineMacro('BANNER', {
  phase: 'finalize',
  apply: (slot) => `*** ${slot.args[0]?.replace(/'/g, '') ?? ''} ***`,
});
const engine = createEngine({ macros: [Banner] });
// engine.stebo({ template: "@{ BANNER('Hi') }" }) → output "*** Hi ***"
```

### Custom types — `defineType`

`defineType` registers a type name (governed against builtins/extensions) and is **wired into
the evaluator**: `name(value)` constructs a value, `validate(value, constraints)` runs at
construction (a falsy result is a `CONSTRAINT_VIOLATION`), `stringify(value, format)` renders
it at slot emission, and `defaultFormat` seeds its `format`. Custom transformers
(`defineFunction` with `receiver: '<type>'`) apply to custom-typed receivers. Custom types do
not participate in builtin operators (`+`, `<`, …) — there is no operator hook in v1.

```js
import { defineType } from 'seebo';

const Money = defineType('money', {
  category: 'base',
  defaultFormat: { currency: 'EUR' },
  validate: (v) => typeof v === 'number' && v >= 0,
  stringify: (v, fmt) => `${v.toFixed(2)} ${fmt.currency}`,
});
const engine = createEngine({ types: [Money] });
// engine.stebo({ template: '${ money(1234.5) }' }) → output "1234.50 EUR"
```

## Name governance

Producers, builtin types, libraries and capabilities **share one namespace** (all invoked as
`name(...)`); macros are a separate namespace; transformers are keyed per receiver type.
`createEngine` throws an `EngineConfigError` when a name is invalid:

- **`RESERVED_NAME`** — the name is a language keyword (`and`, `match`, `array`, `now`,
  `ABSORB`, …, see `RESERVED_WORDS`).
- **`NAME_CONFLICT`** — the name is already taken in its namespace (e.g. a function and a
  capability both named `foo`, or a library and a type both named `geo`).

```js
createEngine({ functions: [defineFunction('match', { eval: () => 1 })] });
// throws EngineConfigError { code: 'RESERVED_NAME', data: { name: 'match' } }

createEngine({
  functions: [defineFunction('foo', { eval: () => 1 })],
  capabilities: { foo: () => 1 },
});
// throws EngineConfigError { code: 'NAME_CONFLICT', data: { name: 'foo', namespace: 'producer' } }
```

## Security: trusted vs untrusted capabilities

A template carries a `policy.trustLevel` (default `'untrusted'`). Per-capability rules
(`policy.capabilityRules`) govern who may invoke sensitive capabilities. The check happens in
the driver **before** the provider runs.

```js
const engine = createEngine({
  capabilities: { secrets: () => readSecret() },
  policy: {
    trustLevel: 'untrusted',
    capabilityRules: { secrets: { allowFrom: 'trusted', audit: true } },
    redact: ['secrets'], // secret values are masked in diagnostics/audit
  },
});

await engine.stebo({ template: "${ require({ id:'k', type:string(), capability:'secrets' }) }" });
// status 'failed' with a CAPABILITY_FORBIDDEN diagnostic (untrusted template)
```

Raising the template to `trustLevel: 'trusted'` allows the capability. Independently,
`policy.allowedCapabilities` is a hard allow-list: a capability not on the list is always
`CAPABILITY_FORBIDDEN`. Per-capability `audit: false` opts a capability out of the audit hook.

`policy.allowedTypes` and `policy.allowedFunctions` are static allow-lists enforced by
`validate`: a type constructor outside `allowedTypes`, or a function (producer, library
function, or custom transformer) outside `allowedFunctions`, is reported as `POLICY_FORBIDDEN`
(`data: { kind, name }`). Builtin methods are part of an allowed type's surface and are not
gated by `allowedFunctions`. When a list is omitted, no restriction applies.
