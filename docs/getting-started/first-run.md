# First run

In about five minutes you will render a static template, watch a template **suspend** on
missing data and resume it by hand, and then let a capability resolve the data
automatically. Along the way you will meet the three objects you will use every day:
the **engine**, the **state**, and the **requirement** (`Need`).

!!! note "Prerequisites"

    Node.js ≥ 20 and `npm install seebo` — see [Installation](installation.md). All
    snippets are ESM (`import`), runnable as-is in a `.mjs` file or an ESM project.

## Step 1 — Render a static template

Start with a template that needs no external data:

```js
import { createEngine } from 'seebo';

const engine = createEngine({ locale: 'it-IT' });

const res = await engine.stebo({ template: '${ 1 + 2 * 3 }' });
res.status; // 'completed'
res.output; // '7'
```

What happened:

- `createEngine(config)` builds an engine **once**; every method you call afterwards uses
  this configuration (locale, capabilities, limits, …).
- A template is plain text with slots. `${ … }` is a **formula slot**: the expression
  inside is evaluated and stringified into the output.
- `stebo(...)` is the all-in-one orchestrator: it expands composition macros, drives
  evaluation to the end, and applies layout macros. For a fully static template it
  completes in a single call.

## Step 2 — Suspend on missing data, resume by hand

Now reference a value the engine does not have. This is the defining feature of Seebo:
instead of throwing, evaluation **pauses** and tells you exactly what is missing.

```js
const engine = createEngine({
  capabilities: {
    // A capability resolves missing data; returning undefined means "not me".
    user: () => undefined,
  },
});

// 1. Create the initial state and run it (pure, synchronous).
let state = engine.start("Hello ${ user({ id:'name', type:string() }) }!");
state = engine.run(state);

state.status; // 'waiting'  — evaluation paused
state.pending; // [{ id: 'name', capability: 'user', type: {…}, … }]
```

What happened:

- `user({ id:'name', type:string() })` declares a **requirement**: "I need a value called
  `name`, typed `string`, resolved by the `user` capability".
- The `user` capability returned `undefined` ("not me"), so the requirement stayed open.
  `run` collected it into `state.pending` and set `status: 'waiting'`.
- Nothing failed: the state is a complete, serializable snapshot of the conversation so
  far.

Now play the role of the host: provide the value and run again.

```js
// 2. Merge the value into `resolved` and resume.
state = engine.run({ ...state, resolved: { ...state.resolved, name: 'World' } });

state.status; // 'completed'
state.output; // 'Hello World!'
```

!!! tip "The state is a plain, serializable object"

    `PublicState` round-trips through `JSON.parse(JSON.stringify(state))` losslessly.
    You can persist it between turns, ship it to a server, and resume there — `run` is
    pure, so the same code produces the same result anywhere.

## Step 3 — Let a capability resolve the data

Hand-feeding values is what a UI does. For data you can fetch programmatically, give the
capability a real resolver and let the async driver do the loop for you:

```js
const engine = createEngine({
  locale: 'it-IT',
  capabilities: {
    // Simulates a CRM lookup: resolves the requirement with id 'order'.
    crm: (req) => ({ order: { id: 42, total: 1234.5 } })[req.id],
  },
});

const res = await engine.stebo({
  template:
    "Order ${ crm({ id:'order', type:object() }).id } — " +
    '${ float(order.total).constraints({ precision: 2 }) } €',
});
res.output; // 'Order 42 — 1234,50 €'
```

What happened:

- `stebo` ran the same suspend/resolve loop you drove by hand in step 2, but asked the
  registered `crm` capability for each open requirement.
- Once declared, the value is referenced **plain by its id**: `order.total`, not
  `crm(...)` again.
- `float(...).constraints({ precision: 2 })` shows the type system at work: values carry
  their type and formatting rules, and stringification happens only when the value is
  emitted into the output — `1234.5` became `1234,50` because the locale is `it-IT`.

With a bare string the capability sugar is even shorter: `crm('order')` is the same as
`need({ id:'order', capability:'crm' })`, inheriting the capability's declared contract.

## Step 4 — Check a template before running it

The static methods let you inspect a template without executing anything:

```js
engine.validate('${ name }');
// [{ code: 'UNDECLARED_NAME', … }]  — `name` is never declared

engine.analyze("${ crm({ id:'order', type:object() }) }").capabilitiesUsed;
// ['crm']  — what the template will ask for, before running it
```

`validate` returns every static problem at once (and never throws); `analyze` tells you
which requirements and capabilities a template will use, and in which order. Both are
invaluable in editors, CI checks and pre-flight screens.

## A taste of the language

```js
const out = async (t, config) => (await createEngine(config).stebo({ template: t })).output;

await out('${ array([3,1,2]).min() }'); // '1'
await out('${ duration(50 * 3600).totalHours() }'); // '50'
await out("${ datetime('2026-06-20').truncate('month').day() }"); // '1'
await out("${ 2 match { 1 => 'one', 2 => 'two', * => '?' } }"); // 'two'
await out("${ '' ?? 'fallback' }"); // 'fallback'  (0/false are NOT empty)
```

## What you learned

| Concept        | Takeaway                                                                         |
| -------------- | -------------------------------------------------------------------------------- |
| Engine         | Built once with `createEngine(config)`; methods are pre-bound to that config.    |
| Formula slot   | `${ … }` evaluates a typed expression and stringifies it at emission.            |
| Requirement    | Missing data becomes a `Need` in `state.pending` instead of an exception.        |
| State          | A serializable snapshot; merge values into `resolved` and `run` again to resume. |
| Capability     | A host function that resolves requirements; `stebo`/`drive` loop it for you.     |
| Static methods | `validate`/`analyze` inspect a template without running it.                      |

## Next steps

- [Usage & extensibility](../guide/usage.md) — declarations (`need`/`bind`/`prepare`),
  every extension point, multi-turn interactive resolution.
- [Actions](../guide/actions.md) — declaring external effects and executing them safely.
- [Execution model](../architecture/execution-model.md) — how the conversation loop works
  under the hood.
