# Security model

How Seebo stays safe to run on **untrusted templates and untrusted data**, including on the
client. It documents the threat model, the configurable limits,
the prototype-pollution protections, and what is explicitly out of scope.

## Threat model

Seebo is designed so the engine can execute **untrusted template source** and **untrusted
resolved data** without compromising the host:

- **Termination is guaranteed.** The language is not Turing-complete (no user loops/recursion,
  bounded inclusion). Every limit below has a finite default, so evaluation always halts.
- **The core is pure and synchronous.** `tokenize`/`parse`/`validate`/`analyze`/`run` perform
  no I/O and touch no ambient authority (no `eval`/`Function`, no `globalThis`/`process`, no
  network or filesystem). The **only** asynchronous, outside-touching component is the driver,
  and it reaches the world solely through the **capabilities** the host registers.
- **Trust boundary.** The frontend may run the engine for UX, but the backend remains the
  authority that re-runs and re-validates the authoritative output. Because `run` is pure and
  `PublicState` is serializable, a conversation can be started on the client and finished and
  verified on the server with the same code.

Trusted vs untrusted:

| Surface                              | Trust       | Notes                                                     |
| ------------------------------------ | ----------- | --------------------------------------------------------- |
| Template source                      | untrusted   | bounded + validated; cannot reach globals or run code     |
| Resolved data / capability values    | untrusted   | sanitized, type/constraint-checked before entering state  |
| `define*` extensions, capabilities   | **trusted** | host code registered at `createEngine`; receives plain JS |
| `policy` / `limits` / `clock`/`seed` | **trusted** | host configuration                                        |

## Configurable limits

All limits live in `config.limits` and have reasonable defaults
([`src/util/limits.js`](https://github.com/BoniFederico/seebo/blob/master/src/util/limits.js)).
The four original normative limits are
kept; the rest are additive hardening guards. When a limit is
exceeded the engine fails with a **specific diagnostic code** — never a silent truncation or a
crash.

| Limit             | Default   | Enforced in | Diagnostic code                | Guards against                    |
| ----------------- | --------- | ----------- | ------------------------------ | --------------------------------- |
| `maxInputBytes`   | 1 000 000 | parse       | `INPUT_LIMIT_EXCEEDED`         | huge template source              |
| `maxTokens`       | 100 000   | parse       | `TOKEN_LIMIT_EXCEEDED`         | token-count blow-up               |
| `maxNodes`        | 50 000    | parse       | `NODE_LIMIT_EXCEEDED`          | AST-size blow-up                  |
| `maxNestingDepth` | 200       | parse       | `NESTING_LIMIT_EXCEEDED`       | deep nesting → stack overflow     |
| `maxSteps`        | 1 000 000 | run         | `STEP_LIMIT_EXCEEDED`          | expensive evaluation per pass     |
| `maxDepth`        | 20        | expand      | `DEPTH_EXCEEDED`               | deep/recursive template inclusion |
| `maxPhases`       | 10        | driver      | `MAX_PHASES_EXCEEDED`          | non-terminating conversation loop |
| `timeoutMs`       | 2000      | driver      | `TIMEOUT` / `CAPABILITY_ERROR` | slow/hung capability provider     |
| `maxOutputBytes`  | 1 000 000 | run         | `OUTPUT_LIMIT_EXCEEDED`        | oversized rendered output         |

How a breach surfaces:

- **Parse-time limits** (`INPUT`/`TOKEN`/`NODE`/`NESTING`) make `engine.parse` **throw** a
  coded `SeeboError`; through `engine.run` the same becomes `status: 'failed'` with that code
  in `diagnostics` (and likewise for `validate`, which never throws).
- **`maxSteps`** is checked per `evaluate` call; on breach the pass yields `STEP_LIMIT_EXCEEDED`
  and `run` returns `status: 'failed'`.
- **`maxDepth`** (inclusion) is enforced by `expand`; `stebo` turns it into a `failed` state.
- **`maxOutputBytes`** is checked on the emitted text (UTF-8 bytes) when a pass completes;
  on breach `run` returns `status: 'failed'` with `OUTPUT_LIMIT_EXCEEDED`.
- **`maxPhases`/`timeoutMs`** are enforced by the async driver.

Limits are off the hot path: a normal template parses and evaluates well under every default.

## Prototype-pollution protection

Untrusted data and untrusted requirement ids never reach `Object.prototype`:

- **JSON sanitization**
  ([`src/runtime/sanitize.js`](https://github.com/BoniFederico/seebo/blob/master/src/runtime/sanitize.js)):
  object/array
  values are deep-cloned into fresh JSON-only structures. `__proto__` keys are **dropped**, and
  every kept key is created with `Object.defineProperty` (data descriptor), so an inherited
  setter can never run. Non-plain objects (class instances, `Date`, `Map`), functions, symbols,
  bigint, non-finite numbers and circular references are rejected; depth/size are bounded.
- **Object literals** in templates skip `__proto__` and are re-sanitized by `makeObject`.
- **Requirement-id maps** (`PublicState.resolved`, the driver's satisfied set) are populated
  with a `safeSet` helper that uses `Object.defineProperty`, so a requirement declared as
  `__proto__` (or any reserved key) creates a plain own property instead of mutating the
  prototype — while keeping `PublicState` an ordinary serializable POJO.
- **Member access** (`objectGet`) refuses `__proto__` and only reads own properties.

The engine performs **no indiscriminate global access**: no `eval`/`new Function`, no
`globalThis`/`process`/`require`/dynamic `import` in the evaluation path. Extension code
(`define*`, capabilities) is trusted host code and receives only plain JS values; its results
are re-wrapped and sanitized via `fromJs`, so an extension cannot inject an untyped or
unsanitized value into the runtime.

## Name governance

`createEngine` validates every introduced name against the reserved words (`RESERVED_NAME`) and
for uniqueness in its namespace (`NAME_CONFLICT`), failing fast with `EngineConfigError`. This
prevents extensions from shadowing builtins or each other.

## Capability authorization

Capabilities are the only path to sensitive data, so their use is governed by `policy`, checked **before** a provider runs:

- `allowedCapabilities` — hard allow-list; an unlisted capability is `CAPABILITY_FORBIDDEN`.
- `allowedTypes` / `allowedFunctions` — static allow-lists checked by `validate`; a forbidden
  type constructor or function (producer, library fn, custom transformer) is `POLICY_FORBIDDEN`.
- `capabilityRules[cap].allowFrom: 'trusted'` — forbids the capability when the template's
  `policy.trustLevel` is not `'trusted'` (`CAPABILITY_FORBIDDEN`).
- `redact` — values of listed capabilities are masked in diagnostics/audit (incl. `InvalidValue`).
- `audit` — a hook invoked per capability resolution **without** the value in clear;
  `capabilityRules[cap].audit: false` opts a specific capability out of auditing.

A provider value is always validated against the requirement's declared type/constraints; an
invalid value never enters `resolved` (`CAPABILITY_INVALID_VALUE`).

## Action effects

Actions are the only path to outbound **effects**, and they are held to a stricter separation than
capabilities: the **pure core never executes them**. `run`/`analyze`/`validate`/preview only
prepare an `ActionPlan`; effects happen solely through the explicit `seebo/actions` layer.

- **No execution in the core.** The pure modules (`src/eval`, `src/run`, `src/analyze`,
  `src/validate`) never import the execution layer (`src/actions/execute.js`) — a conformance test
  enforces this. A handler cannot run during parse/validate/analyze/preview/run.
- **Fail-closed policy.** `policy.action` controls allow/deny by type, environment rules, and
  forced confirmation. An action type absent from a present `allowedActions`, or an environment
  outside a present `allowedEnvironments`, is **denied**. Denials never run the handler and emit
  `action.policy_denied`.
- **Confirmation & permissions.** An action requiring confirmation cannot run unless its id is in
  `confirmedActions`. Required permissions (descriptor + handler) are checked against the actor's
  granted permissions before any effect; a shortfall is `PERMISSION_DENIED`.
- **Unknown handler.** An action whose `type` has no registered handler can never execute
  (`HANDLER_NOT_FOUND`).
- **Input sanitization.** Action `input` is deep-sanitized like every value: `__proto__` dropped,
  non-JSON/cyclic rejected, depth/size bounded — no prototype pollution through an action.
- **Idempotency & redaction.** A stable idempotency key (SHA-256 over `{id,type,environment,input}`)
  is passed to handlers and constant across retries; the `redact` hook masks inputs/outputs before
  they reach receipts/audit. Audit is hook-based — the core never logs to the console.

## Out of scope (v1)

- **Per-capability `timeoutMs` of synchronous providers.** The timeout bounds awaited promises;
  a provider that blocks the event loop synchronously is the host's responsibility.
- **CPU/memory quotas beyond the documented limits.** The limits bound work proportionally but
  are not a hard sandbox; run untrusted templates in an appropriately isolated process if you
  need OS-level guarantees.
- **Secrecy of trusted extension code.** `define*`/capabilities are trusted by definition; the
  engine does not sandbox them.
