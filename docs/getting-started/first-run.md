# First run

Three short sessions: a fully-static template, a template that **suspends** on missing
data, and a capability that resolves data automatically.

## 1. A static template

For a template with no external data, one async orchestration call is enough:

```js
import { createEngine, builtins } from 'seebo';

const engine = createEngine({
  ...builtins.all, // explicit standard vocabulary (optional; always available)
  locale: 'it-IT',
});

const res = await engine.stebo({ template: '${ 1 + 2 * 3 }' });
res.status; // 'completed'
res.output; // '7'
```

`stebo` is the convenience orchestrator: `expand` (aggregator macros) → `drive` (the
suspend/resolve loop) → `finalize` (layout macros).

## 2. Suspension — a missing value becomes a requirement

The defining feature: when a value is missing, evaluation does not fail. It pauses, and the
open requirements are listed in `state.pending`:

```js
const engine = createEngine({
  capabilities: {
    // A capability resolves a `need`; returning undefined means "not me".
    user: () => undefined,
  },
});

let state = engine.start("Hello ${ user({ id:'name', type:string() }) }!");
state = engine.run(state); // pure, synchronous
state.status; // 'waiting'
state.pending.map((r) => r.id); // ['name']

// Provide the value (as a host or an external resolver would) and resume.
state = engine.run({ ...state, resolved: { ...state.resolved, name: 'World' } });
state.status; // 'completed'
state.output; // 'Hello World!'
```

!!! tip "The state is a plain, serializable object"

    `PublicState` round-trips through `JSON.parse(JSON.stringify(state))` losslessly. You
    can persist it between turns, ship it to a server, and resume there — `run` is pure,
    so the same code produces the same result anywhere.

## 3. Capabilities as producers (the `need` sugar)

A registered capability name can be used directly as a producer in the template. The
declared value is then referenced **plain** by its id:

```js
const engine = createEngine({
  locale: 'it-IT',
  capabilities: {
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

With a bare string the capability sugar is even shorter: `crm('order')` ≡
`need({ id:'order', capability:'crm' })`, inheriting the capability's declared contract.

## A taste of the language

```js
const out = async (t, config) => (await createEngine(config).stebo({ template: t })).output;

await out('${ array([3,1,2]).min() }'); // '1'
await out('${ duration(50 * 3600).totalHours() }'); // '50'
await out("${ datetime('2026-06-20').truncate('month').day() }"); // '1'
await out("${ 2 match { 1 => 'one', 2 => 'two', * => '?' } }"); // 'two'
await out("${ '' ?? 'fallback' }"); // 'fallback'  (0/false are NOT empty)
```

## Next steps

- [Usage & extensibility](../guide/usage.md) — declarations (`need`/`bind`/`prepare`),
  every `define*` extension point, multi-turn interactive resolution.
- [Actions](../guide/actions.md) — declaring external effects and executing them.
- [Execution model](../architecture/execution-model.md) — how the conversation loop works.
