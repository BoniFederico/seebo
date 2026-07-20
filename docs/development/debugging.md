# Debugging

The static, pure methods are the fastest way to understand a template without running it —
each one isolates a pipeline stage, so you can see exactly where things go wrong.

## Inspect the pipeline stage by stage

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

## Reading a failed or waiting state

When `stebo`/`run` returns `status: 'failed'`, the cause is in `state.diagnostics` (each
with `code`, `message`, optional `position` and `data`). A `waiting` state exposes the open
requirements in `state.pending`. The whole `PublicState` is JSON-serializable, so you can
log it or persist it between turns:

```js
const state = engine.run(engine.start('${ int(5).constraints({ max: 3 }) }'));
state.status; // 'failed'
state.diagnostics[0].code; // 'CONSTRAINT_VIOLATION'
JSON.parse(JSON.stringify(state)); // round-trips losslessly
```

!!! tip "Switch on `code`, never on `message`"

    Diagnostic `code`s are a frozen, stable contract (they are never renamed). Messages
    are human-readable and may change, be localized or redacted. The full symptom → code
    table is in [Troubleshooting](../troubleshooting/troubleshooting.md#common-errors).

## Observing capability resolution

To make capability outcomes observable, set `policy.audit` (a hook called per resolution,
without the value in clear); to mask sensitive values in diagnostics and audit, list the
capability ids in `policy.redact`:

```js
const engine = createEngine({
  capabilities: { secrets: () => readSecret() },
  policy: {
    audit: (event) => log.push(event), // per-resolution hook, no value in clear
    redact: ['secrets'], // masked in diagnostics/audit
  },
});
```

## Determinism for reproducible sessions

Non-deterministic producers (`now()`) read the injected `clock`, so a frozen clock gives
byte-stable output — invaluable when bisecting a template:

```js
const engine = createEngine({ clock: () => new Date('2026-06-26T10:00:00Z') });
(await engine.stebo({ template: '${ now().year() }' })).output; // '2026'
```

## See also

- [Troubleshooting](../troubleshooting/troubleshooting.md) — the full diagnostic-code table
  and common gotchas.
- [Testing & conformance](../testing/testing.md) — running and writing tests.
