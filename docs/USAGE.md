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

## Bindings: `bind` and `need` (SPEC §1.6/§1.7)

A template declares the data, values and effects it depends on, and references them **plain** by
name afterwards (`${ name }`). A reference to an undeclared name is an `UNDECLARED_NAME` error.

- `need({ id, capability, type?, ... })` declares missing data resolved by a capability; the short
  form `need('cap')` inherits the capability's contract. Used inline it shows the value where it
  appears.
- `bind(name, descriptor)` introduces a **named** binding for reuse; the descriptor's kind decides
  its nature:
  - a **type-builder** (`int()`, `string().constraints({ min: 0 })`) → a pure value;
  - **`need(...)`** → missing data (the `name` becomes the requirement `id`);
  - **`action(...)`** → an effect, activated where the bound name is referenced (see
    [`ACTIONS.md`](ACTIONS.md)).

```js
const engine = createEngine({ capabilities: { input: () => undefined } });

const tpl = [
  "${ bind('vat', float().default(0.22)) }", // a pure value
  "${ bind('amount', need('input')) }", // missing data (capability contract supplies the type)
  'Total: ${ amount } + VAT ${ amount * vat }',
].join('');

let state = engine.run(engine.start(tpl));
state.pending.map((r) => r.id); // ['amount']  — declared once, read plain everywhere
```

A capability `args` value may depend on another binding; the dependency is resolved **first** and
its value forwarded to the provider (`need.args`), with `analyze` ordering the two into phases:

```js
// region resolves in phase 1; city's provider receives the resolved region via args in phase 2.
"${ bind('region', need('input')) }" +
  "${ bind('city', need({ capability:'geo', args:{ region: region } })) }${ city }";
```

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

A capability resolves a `need`. Place the `defineCapability(...)` descriptor (or a bare resolver
function) under the matching key of `capabilities` (the driver's wiring point). The capability
name automatically becomes a producer (the `need` sugar of SPEC §1.6).

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

// Template (capability sugar):  ${ weather({ id:'today' }) }
// Or via a binding, read plain:  ${ bind('today', need('weather')) }Forecast: ${ today }
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

Layout macros let a formula remove its own line when a value is empty (SPEC §2.7):

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

## Common errors

Diagnostics carry a stable `code` (the contract — never switch on `message`). Where they
surface depends on whether the cause is structural (static) or value-dependent (runtime).

| Symptom                                             | Code                                 | Where it surfaces                      |
| --------------------------------------------------- | ------------------------------------ | -------------------------------------- |
| Reference to an undeclared name                     | `UNDECLARED_NAME`                    | `validate`                             |
| Unknown producer / un-enabled library               | `UNKNOWN_FUNCTION`                   | `validate` (and `run`)                 |
| Method not on the inferred receiver type            | `UNKNOWN_METHOD`                     | `validate` (and `run`)                 |
| Wrong argument count                                | `ARITY_MISMATCH`                     | `validate` (and `run`)                 |
| Provable operator/argument type violation           | `TYPE_ERROR`                         | `validate`                             |
| `match` without `*` over an open domain             | `NON_EXHAUSTIVE_MATCH`               | `validate`                             |
| `need` cites an unregistered capability             | `UNKNOWN_CAPABILITY`                 | `validate`                             |
| Type/function/capability excluded by `policy`       | `POLICY_FORBIDDEN`                   | `validate`                             |
| Malformed syntax                                    | `SYNTAX_ERROR`                       | `parse` throws; `validate` returns one |
| Value violates its own `constraints`                | `CONSTRAINT_VIOLATION`               | `run` (failed state)                   |
| Type error only knowable from values                | `TYPE_ERROR_RUNTIME`                 | `run`                                  |
| Division by zero                                    | `DIVISION_BY_ZERO`                   | `run`                                  |
| Inclusion cycle / too-deep inclusion                | `INCLUSION_CYCLE` / `DEPTH_EXCEEDED` | `expand` → failed state                |
| A resource limit was exceeded                       | `*_LIMIT_EXCEEDED`, `TIMEOUT`        | parse / run / driver                   |
| Capability forbidden / errored / returned bad value | `CAPABILITY_*`                       | driver (failed state)                  |
| State from a newer engine                           | `UNSUPPORTED_STATE_VERSION`          | `run`                                  |

Two gotchas worth calling out:

- **No implicit coercion.** `1 + 'a'` is a `TYPE_ERROR`; concatenate with `string(...)`:
  `string(1) + 'a'`.
- **"Empty" is `''` / `[]` / `{}`** for `??` — `0` and `false` are **not** empty, so
  `0 ?? 9` is `0`.

## Debugging

The static, pure methods are the fastest way to understand a template without running it:

```js
// 1. Lexing (error-tolerant; never throws) — what the scanner sees.
engine.tokenize('Hi ${ name.upper() }');

// 2. Parsing — the AST, or a thrown SYNTAX_ERROR with a position.
try {
  engine.parse('${ 1 + }');
} catch (e) {
  e.code; // 'SYNTAX_ERROR'
  e.position; // { start, end } offsets into the source
}

// 3. Validation — all static diagnostics at once (never throws).
engine.validate('${ nome }').map((d) => d.code); // ['UNDECLARED_NAME']

// 4. Analysis — what the template needs and in what order.
const a = engine.analyze("${ user({ id:'x', type:string(), capability:'user' }) }");
a.requirements; // declared requirements (enriched with phase/options)
a.executionPlan; // requirements grouped by phase
a.capabilitiesUsed; // ['user']
a.deterministic; // false when now()/fake.* appear
```

When `stebo`/`run` returns `status: 'failed'`, the cause is in `state.diagnostics` (each with
`code`, `message`, optional `position` and `data`). A `waiting` state exposes the open
requirements in `state.pending`. The whole `PublicState` is JSON-serializable, so you can log
it or persist it between turns:

```js
const state = engine.run(engine.start('${ int(5).constraints({ max: 3 }) }'));
state.status; // 'failed'
state.diagnostics[0].code; // 'CONSTRAINT_VIOLATION'
JSON.parse(JSON.stringify(state)); // round-trips losslessly
```

To make capability outcomes observable, set `policy.audit` (a hook called per resolution,
without the value in clear); to mask sensitive values in diagnostics and audit, list them in
`policy.redact`.
