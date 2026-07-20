# Troubleshooting

Diagnostics carry a stable `code` (the contract — never switch on `message`). Where a
problem surfaces depends on whether the cause is structural (static) or value-dependent
(runtime): structural problems appear in `validate`/`parse`, value-dependent ones in
`run`/`driver`.

## Common errors

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

## Gotchas

!!! warning "No implicit coercion"

    `1 + 'a'` is a `TYPE_ERROR`; concatenate with `string(...)`: `string(1) + 'a'`.

!!! warning "\"Empty\" is `''` / `[]` / `{}`"

    For the `??` fallback operator, `0` and `false` are **not** empty — so `0 ?? 9` is `0`
    and `'' ?? 'fallback'` is `'fallback'`.

Other frequent stumbling blocks:

- **`cap('id')` needs a registered capability.** The capability sugar only exists for names
  registered under `capabilities`; an unknown name is `UNKNOWN_FUNCTION`/`UNKNOWN_CAPABILITY`.
- **A `bind` name is read plain.** Declare with `bind('vat', float().default(0.22))`, read
  with `${ vat }` — not `${ bind('vat') }` or `${ var('vat') }` (`var`/`require` were
  removed in 0.3.0; see the [changelog](../changelog.md)).
- **`prepare(...)` emits nothing.** A prepared need/action activates only where its id is
  referenced; if the reference sits in an untaken branch, it is never requested.
- **Custom transformers never shadow builtins.** A custom `upper` on `string` is unreachable;
  builtin methods always win.

## How a limit breach surfaces

- **Parse-time limits** (`INPUT`/`TOKEN`/`NODE`/`NESTING`) make `engine.parse` **throw** a
  coded `SeeboError`; through `engine.run` the same becomes `status: 'failed'` with that
  code in `diagnostics` (and likewise for `validate`, which never throws).
- **`maxSteps`** is checked per `evaluate` call; on breach the pass yields
  `STEP_LIMIT_EXCEEDED` and `run` returns `status: 'failed'`.
- **`maxDepth`** (inclusion) is enforced by `expand`; `stebo` turns it into a failed state.
- **`maxOutputBytes`** is checked on the emitted text (UTF-8 bytes) when a pass completes.
- **`maxPhases`/`timeoutMs`** are enforced by the async driver.

The full limit table and defaults are in the
[security model](../security/security.md#configurable-limits).

## Known limitations (v1)

- **Static passes see the raw template.** `validate`/`analyze` do not expand
  `ABSORB`/`MERGE` first, so requirements imported by aggregators are not visible to them
  (the inclusion cycle itself is still caught at `expand`/`run`).
- **No streaming output.** `steboStream` is not exposed; `optimizations.stream` is accepted
  but inert.
- **Only `astCache` is implemented** among the optimization flags; `lazyParse` and
  `objectPool` are accepted but inert.
- **No shipped `fake.*` library.** `defineLibrary` is the mechanism; the library itself is
  an example, not a builtin.
- **Timeouts bound awaited promises.** A capability provider that blocks the event loop
  synchronously is the host's responsibility (see
  [out of scope](../security/security.md#out-of-scope-v1)).

## Debugging workflow

Work through the pipeline with the static, pure methods (`tokenize` → `parse` → `validate`
→ `analyze`) before running anything — see [Debugging](../development/debugging.md) for the
full walkthrough.

## Still stuck?

Open an issue at
[github.com/BoniFederico/seebo/issues](https://github.com/BoniFederico/seebo/issues) with
the template, the config (minus secrets) and the `diagnostics` array of the failed state.
