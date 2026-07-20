# Actions

`action(...)` is Seebo's declarative construct for **external effects**. It is the
fourth peer of the data-flow vocabulary:

| Construct     | Role                                                   |
| ------------- | ------------------------------------------------------ |
| `need(...)`   | declares missing **input** data the template needs     |
| `capability`  | **resolves** external data into the engine             |
| `function`    | a **pure**, value-oriented computation                 |
| `action(...)` | declares an external **effect** the engine can prepare |

The cardinal rule: **the pure core never executes an action.** `run`/`analyze`/`validate`/preview
only ever _prepare_ an **action plan**. Execution happens solely through the explicit
`seebo/actions` layer, invoked by the host application:

```js
import { createEngine } from 'seebo';
import { executeActionPlan } from 'seebo/actions';
```

---

## Your first action, end to end

Five steps take an effect from declaration to execution. Each is small on purpose — the
point is to see where the pure/effectful boundary sits.

**1. Register a handler.** A handler implements an action _type_ — here a fake notifier:

```js
const engine = createEngine();

engine.defineAction('notify.send', {
  async execute(input) {
    console.log(`(sending) ${input.message}`);
    return { deliveredTo: input.channel };
  },
});
```

**2. Declare the action in a template.** An action slot emits nothing into the output —
an effect is not text:

```js
const template =
  "Deploy done.${ action({ id:'ping', type:'notify.send', input:{ channel:'ops', message:'Deployed!' } }) }";
```

**3. Run the template.** The pure core renders the text and _prepares_ the plan — nothing
is sent yet:

```js
const state = engine.run(engine.start(template));
state.output; // 'Deploy done.'
state.actions.map((a) => [a.id, a.status]); // [['ping', 'ready']]
```

**4. (Optional) dry-run.** Preview what would happen without side effects:

```js
import { dryRunActionPlan } from 'seebo/actions';
await dryRunActionPlan(state.actions, { engine }); // never calls execute()
```

**5. Execute the plan.** Only now, and only because the host asked, the effect happens:

```js
const result = await executeActionPlan(state.actions, { engine });
result.status; // 'completed'
result.receipts[0].output; // { deliveredTo: 'ops' }
```

The rest of this page fills in what each step can do: descriptor fields, the lifecycle,
confirmation, permissions, retry, audit and compensation.

---

## Declaring an action

An action is declared inside a formula slot. It evaluates to the **empty string** — it emits
nothing into the rendered document, because an effect is not text:

```text
@{ COMMENT — actions are usually placed in dedicated slots }
${ action({
  id: 'createIncidentTicket',
  type: 'jira.createIssue',
  input: {
    project: 'AM',
    summary: need({ id: 'summary', type: string(), capability: 'input' }),
    description: need({ id: 'description', type: string(), capability: 'input' })
  },
  confirm: true,
  environment: 'test'
}) }
```

A single template may declare **zero, one, or many** actions. The engine collects every action
that is **reachable** under the template's evaluation semantics — an action gated behind a
ternary/`and`/`or` branch that is not taken is simply never collected (the same lazy gating that
governs `need`).

### Descriptor fields

| Field            | Meaning                                                                            |
| ---------------- | ---------------------------------------------------------------------------------- |
| `id` (required)  | Unique id within a run/plan.                                                       |
| `type` (req.)    | Handler type name (e.g. `'jira.createIssue'`); dotted names allowed.               |
| `input`          | Object of resolved values; may reference `need(...)`.                              |
| `confirm`        | `true` ⇒ the action must be explicitly confirmed before it may run.                |
| `environment`    | Target environment (`'test'`, `'prod'`, …). Defaults via policy (`'test'`).        |
| `dryRun`         | Hint that the action prefers a dry-run.                                            |
| `idempotencyKey` | Override the derived key (see below).                                              |
| `permissions`    | Permissions the actor must hold (merged with the handler's `requiredPermissions`). |
| `retry`          | `{ attempts, backoffMs, strategy }` — execution-layer retry policy.                |
| `metadata`       | Free-form audit metadata; unknown descriptor fields fold in here.                  |

---

## The action lifecycle

The **core** emits only the first three states; the **execution layer** owns the rest.

```
                    core (prepares)               seebo/actions (executes)
unresolved input ─▶ blocked ─┐
                             ├─▶ ready ───────────▶ executing ─▶ succeeded
all inputs resolved ─────────┘     │                          └▶ failed ─(retry?)▶ failed
confirm / policy ────────▶ pendingConfirmation ─(confirmed)─▶ executing ─▶ …
policy denies / unconfirmed ─────────────────────▶ skipped (not executed)
                                                   succeeded ─▶ compensated / compensationFailed
```

- **blocked** — an input requirement is still unresolved. The requirement still flows out through
  the normal `Need`/`pending` mechanism, so the suspend/resume loop drives it. Re-running once the
  value is supplied transitions the action to `ready`/`pendingConfirmation`.
- **ready** — all inputs resolved; executable without confirmation.
- **pendingConfirmation** — ready, but `confirm: true` (or policy) requires explicit confirmation.

---

## Executing a plan

```js
const engine = createEngine();

engine.defineAction('jira.createIssue', {
  requiredPermissions: ['jira:issue:create'],
  allowedEnvironments: ['test', 'preprod', 'prod'],
  async dryRun(input) {
    return { preview: { project: input.project, summary: input.summary } };
  },
  async execute(input, context) {
    const issue = await context.clients.jira.createIssue(input);
    return { externalId: issue.key, url: issue.url };
  },
  async compensate(receipt, context) {
    await context.clients.jira.closeIssue(receipt.externalId);
    return { compensatedExternalId: receipt.externalId };
  },
});

const result = engine.run(engine.start(template));

const exec = await executeActionPlan(result.actions, {
  engine,
  dryRun: false,
  actor: currentUser,
  permissions: currentUser.permissions,
  environment: 'test',
  confirmedActions: ['createIncidentTicket'],
  clients: { jira: realJiraClient },
  audit(event) {
    /* persist audit event */
  },
  redact(value, ctx) {
    return value;
  },
});
```

`executeActionPlan` returns an `ActionExecutionResult` — one `ActionReceipt` per action, plus a
plan-level `status`:

| Plan status | Meaning                                         |
| ----------- | ----------------------------------------------- |
| `completed` | every action succeeded                          |
| `partial`   | some succeeded, others skipped/failed           |
| `failed`    | nothing succeeded and at least one failed       |
| `skipped`   | nothing ran (empty plan or all actions skipped) |

### API surface (`seebo/actions`)

| Function                              | Purpose                                        |
| ------------------------------------- | ---------------------------------------------- |
| `executeAction(action, ctx)`          | Execute one prepared action → `ActionReceipt`. |
| `executeActionPlan(plan, ctx)`        | Execute a plan in document order → result.     |
| `dryRunAction(action, ctx)`           | Dry-run one action (never calls `execute`).    |
| `dryRunActionPlan(plan, ctx)`         | Dry-run a plan.                                |
| `compensateAction(receipt, ctx)`      | Roll back one succeeded action.                |
| `compensateActionPlan(receipts, ctx)` | Roll back receipts in **reverse** order.       |

Also exported: the `ActionStatus`, `ActionErrorCode`, `ActionEventType`, `PlanStatus` enums; the
`nonRetryable`/`isFailureStatus` helpers; and the pure `computeIdempotencyKey`,
`normalizeActionInput`, `findDuplicateActionId`, `decideAction`, `checkPermissions`,
`checkHandlerEnvironment` utilities for host-side pre-flighting.

---

## Semantics

### Confirmation

No action that requires confirmation can be executed unless its `id` appears in
`context.confirmedActions`. In a multi-action plan, only the confirmed required actions run; the
rest are returned as `skipped` receipts with a `CONFIRMATION_REQUIRED` error. Policy can _force_
confirmation for some/all action types via `requireConfirmation` / `requireConfirmationFor`.

### Dry-run

`dryRun*` (and `executeActionPlan` with `dryRun: true`) calls the handler's `dryRun` method when
present and **never** the real `execute`. A handler without `dryRun` yields a deterministic
simulated receipt (no effect). Dry-run is distinct from template preview/rendering and from real
execution — three clearly separated phases.

### Idempotency

Every action carries a stable `idempotencyKey`. By default it is a SHA-256 (hex, 128-bit) over
the canonical JSON of `{ id, type, environment, input }`, so identical inputs across runs and
retries produce the **same** key (the input is key-sorted before hashing, so declaration order
does not matter). Supplying an explicit `idempotencyKey` overrides the default. The key is passed
to the handler and stays constant across retries.

### Retry

No automatic retry by default. `retry: { attempts, backoffMs, strategy }` applies **only** at the
execution layer (never core evaluation), keeps the idempotency key stable, emits
`action.retry_scheduled` audit events, and stops early when the handler marks an error
non-retryable (`throw nonRetryable(err)` or `err.retryable = false`). Retries apply per action;
one action's failure does not stop later actions unless `failFast` is set.

### Permissions & policy

Before any handler runs, the executor checks — fail-closed — in order: action-type allow/deny,
environment rules, handler `allowedEnvironments`, and the union of descriptor `permissions` and
handler `requiredPermissions` against `context.permissions`. A denial is returned as a structured
`skipped` receipt and emits an `action.policy_denied` audit event. Authorized actions still run
even when a sibling is denied (unless `failFast`).

### Audit & redaction

Audit is hook-based: pass `audit(event)` in the context. The core never writes to the console.
Events use the stable `ActionEventType` codes (`action.execution_started`,
`action.execution_succeeded`, `action.policy_denied`, …) and carry id, type, environment, actor,
timestamp, correlation id and idempotency key. The optional `redact(value, { actionId, type,
field })` hook sanitizes inputs/outputs before they appear in receipts/audit.

### Compensation (rollback)

Compensation is handler-provided: a handler may define `compensate(receipt, context)`. The host
calls `compensateAction(receipt, ctx)` (or `compensateActionPlan(receipts, ctx)` to undo a list in
reverse order). An action whose handler has no `compensate` yields a structured
`COMPENSATION_UNSUPPORTED` receipt; a throwing `compensate` yields `compensationFailed`. Seebo does
not implement a universal rollback engine — compensation is exactly what the handler provides.

---

## `analyze` and `validate`

`analyze(template).actions` lists every statically-detected action in document order with
best-effort metadata (`id`, `type`, `environment`, `requiresConfirmation`, `permissions`,
`dynamicInput`, `duplicateId`). Fields that are not syntactically constant are reported as
`undefined` so a host can tell what is statically known from what is run-time-only.

`validate(template)` reports `INVALID_ACTION` (missing/ill-typed `id`/`type`, bad flags/retry),
`DUPLICATE_ACTION_ID`, `UNKNOWN_ACTION_TYPE` (when no handler is registered for the type), and
`POLICY_FORBIDDEN` (denied type or environment).

---

## Security

- Action `input` is deep-sanitized like every other value: `__proto__` is dropped, non-JSON /
  cyclic inputs are rejected, depth/size are bounded — a hostile template cannot pollute the
  prototype through an action.
- An action handler can never run during parse/validate/analyze/preview/run.
- An unknown action type can never execute (it returns `HANDLER_NOT_FOUND`).
- Policy fails closed: an action type absent from a present `allowedActions`, or an environment
  outside a present `allowedEnvironments`, is denied.
- The pure core (`src/eval`, `src/run`, `src/analyze`, `src/validate`) never imports the execution
  layer — enforced by a conformance test.
