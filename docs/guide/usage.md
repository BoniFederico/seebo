# Usage & Extensibility

This guide takes you from a working engine to a fully customized one. It builds up in
order: first the **declarations** a template uses to name its data, then each
**extension point** (functions, libraries, capabilities, macros, types), and finally
**realistic end-to-end patterns** — interactive multi-turn forms, template composition
and deterministic rendering. If you have not run a template yet, start with
[First run](../getting-started/first-run.md).

## Creating an engine

```js
import { createEngine, builtins } from 'seebo';

const engine = createEngine({
  ...builtins.all,
  capabilities: {
    user: () => undefined, // interactive: its Needs are returned to the caller
    crm: (req) => ({ order: { id: 42 } })[req.id], // a "data" capability
  },
  locale: 'it-IT',
});

const res = await engine.stebo({
  template: "Order ${ crm({ id:'order', type:object() }).id }",
});
console.log(res.output); // "Order 42"
```

`createEngine` binds the vocabulary once and **fails fast** on an invalid name (see
[Name governance](#name-governance)). The returned engine exposes the full method surface
(`tokenize`, `parse`, `validate`, `analyze`, `start`, `run`, `expand`, `finalize`, `drive`,
`stebo`).

## Declarations: `need`, `bind`, `prepare`

A template declares the data, values and effects it depends on, and references them **plain** by
name afterwards (`${ name }`). A reference to an undeclared name is an `UNDECLARED_NAME` error.

Three declaration forms cover every case:

| Form                   | Declares                          | Use it when                                                                  |
| ---------------------- | --------------------------------- | ---------------------------------------------------------------------------- |
| `need({...})` inline   | Missing external data (**eager**) | You want the value requested and rendered right where it appears.            |
| `bind(name, type)`     | A pure value with a default       | You need a constant/derived value (e.g. a VAT rate) referenced by name.      |
| `prepare(need/action)` | A need or action (**lazy**)       | You will reference the id elsewhere — possibly in a branch that may not run. |

In detail:

- `need({ id, capability, type?, ... })` — missing data resolved by a capability. The **capability
  sugar** `cap('id')` is the short form: `input('amount')` ≡ `need({ id:'amount', capability:'input' })`,
  inheriting the capability's contract. Used **inline**, a need is **eager** — it asks for the value
  and renders it where it appears.
- `bind(name, type)` — names a **pure value** (a type-builder). The name is its id, read plain.
- `prepare(need(...) | action(...))` — declares a need/action **lazily** for reuse by its own `id`
  (carried by the descriptor). It emits nothing and is **not** activated at the `prepare` site —
  only where its id is referenced (`${ id }`). An `action(...)` so declared activates where its id
  appears (see [Actions](actions.md)).

The distinction between **eager use** and **lazy declaration** matters:

```js
const engine = createEngine({ capabilities: { input: () => undefined } });

// Eager: the inline need asks for `amount` here and renders it.
engine.run(engine.start("${ input('amount') }")); // status 'waiting', pending ['amount']

// Lazy: prepare declares `amount`; it is requested only if/where it is referenced.
const tpl =
  "${ prepare(input('amount')) }" + // declared, not yet requested
  "${ bind('vat', float().default(0.22)) }" + // a pure value
  '${ 1 == 2 ? amount : "n/a" }'; // amount is in an untaken branch ⇒ never requested
engine.run(engine.start(tpl)); // status 'completed' — no pending
```

A capability `args` value may depend on another binding; the dependency is resolved **first** and
its value forwarded to the provider (`need.args`), with `analyze` ordering the two into phases:

```js
// region resolves in phase 1; city's provider receives the resolved region via args in phase 2.
"${ prepare(input('region')) }" +
  "${ prepare(need({ id:'city', capability:'geo', args:{ region: region } })) }${ city }";
```

## Extensibility

All extensions are created with a `define*` factory that returns a **frozen descriptor**, then
passed to `createEngine`. Names are validated/reserved when the engine is built.

Pick the extension point from what you want to add to the template language:

| I want to…                                                      | Use                | Invoked in a template as                         |
| --------------------------------------------------------------- | ------------------ | ------------------------------------------------ |
| Add a computation (`slugify`, `vatOf`, …)                       | `defineFunction`   | `${ fn(...) }` or `${ value.fn(...) }`           |
| Group several functions under a namespace                       | `defineLibrary`    | `${ ns.fn(...) }`                                |
| Feed **external data** into templates (DB, API, user input)     | `defineCapability` | `${ cap('id') }` / `need`                        |
| Post-process the rendered text (banners, cleanup)               | `defineMacro`      | `@{ NAME(...) }`                                 |
| Add a **value type** with its own validation and formatting     | `defineType`       | `${ money(12.5) }`                               |
| Perform an **external effect** (create a ticket, send an email) | `defineAction`     | `${ action({...}) }` — see [Actions](actions.md) |

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

A capability resolves a `need`. Place the `defineCapability(...)` descriptor (or a bare resolver
function) under the matching key of `capabilities` (the driver's wiring point). The capability
name automatically becomes a producer (the `need` sugar).

A capability may declare its own **contract** (`type`/`constraints` via a type builder, plus
`label`/`description`). A `need('cap')` then inherits it, so the template need not repeat the type;
the template still wins on any field it overrides.

```js
import { defineCapability } from 'seebo';

const engine = createEngine({
  capabilities: {
    // With a contract: need('weather') inherits type string().
    weather: defineCapability('weather', {
      type: string(),
      label: 'Daily forecast',
      resolve: async (req) => fetchForecast(req.args?.city),
    }),
    // A bare function still works (no contract; type defaults to string()).
    user: () => undefined,
  },
});

// Template (capability sugar):  ${ weather('today') }
// Or declared lazily, read plain:  ${ prepare(weather('today')) }Forecast: ${ today }
```

> The data a capability needs comes from the descriptor's `args` (forwarded opaquely to
> `resolve`); an `args` value may reference another binding (resolved first — see _Bindings_ below).

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

await engine.stebo({ template: "${ need({ id:'k', type:string(), capability:'secrets' }) }" });
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

## Realistic examples

### Multi-turn (interactive) resolution

When some capabilities are interactive (e.g. asking a human), drive to the first point where
their input is needed, hand the pending requirements back to your UI, then resume with
`stopOn` so the engine returns rather than blocking on those capabilities.

```js
const engine = createEngine({
  capabilities: {
    crm: (req) => ({ order: { id: 42 } })[req.id], // non-interactive (data)
    user: () => undefined, // interactive: resolved by the host UI
  },
});

const template =
  "Order ${ crm({ id:'order', type:object() }).id } for " +
  "${ user({ id:'name', label:'Customer name', type:string() }) }.";

// First turn: resolve everything except `user`, which is returned to us.
let state = await engine.drive(template, { stopOn: ['user'] });
state.status; // 'waiting'
state.pending; // [{ id:'name', capability:'user', label:'Customer name', type:{…} }]

// Render the pending requirements as a form, collect the answer, then resume.
state = await engine.drive(
  { ...state, resolved: { ...state.resolved, name: 'Ada' } },
  { stopOn: ['user'] }
);
state.status; // 'completed'
state.output; // 'Order 42 for Ada.'
```

A requirement's `type.constraints.values` is surfaced by `analyze` as `options`, so a UI can
render a select box without hard-coding choices:

```js
const a = engine.analyze(
  "${ user({ id:'plan', type: array().constraints({ values:['Free','Pro'] }) }) }"
);
a.requirements.find((r) => r.id === 'plan').options; // ['Free', 'Pro']
```

### Composition with aggregator macros

`ABSORB` inlines one template; `MERGE` concatenates templates whose name matches an anchored
glob (`*`/`?`), in stable sorted order. Imported requirements flow into the same resolution.

```js
const res = await engine.stebo({
  template: "@{ABSORB('header')}\nBody for ${ name }\nFooter: @{MERGE('foot_*', ' | ')}",
  templates: {
    header: '=== Report ===',
    foot_1: 'Page 1',
    foot_2: 'Page 2',
  },
  values: { name: 'Ada' },
});
// === Report ===
// Body for Ada
// Footer: Page 1 | Page 2
```

### Conditional layout with `@{REMOVE_LINE}`

Layout macros let a formula remove its own line when a value is empty:

```js
const res = await engine.stebo({
  template: ['From: noreply@acme.io', "${ note != '' ? 'Note: ' + note : '@{REMOVE_LINE}' }"].join(
    '\n'
  ),
  values: { note: '' },
});
res.output; // 'From: noreply@acme.io'  (the empty-note line is removed)
```

### Deterministic output (clock injection)

Non-deterministic producers (`now()`) read a clock from the config; fix it for reproducible
previews and tests:

```js
const engine = createEngine({ clock: () => new Date('2026-06-26T10:00:00Z') });
(await engine.stebo({ template: '${ now().year() }' })).output; // '2026'
```

## See also

- [Troubleshooting](../troubleshooting/troubleshooting.md) — the symptom → diagnostic-code
  table and the gotchas to know about (no implicit coercion, the meaning of "empty").
- [Debugging](../development/debugging.md) — inspecting a template with the static, pure
  methods (`tokenize`, `parse`, `validate`, `analyze`) and reading a failed state.
- [Actions](actions.md) — declaring and executing external effects.
- [API reference](../api/overview.md) — the full public surface and configuration tables.
