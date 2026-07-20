# Configuration

An engine is built once with `createEngine(config)`; the config binds the vocabulary,
policy and environment, and every engine method is pre-bound to the resolved config.
`createEngine` **fails fast** with an `EngineConfigError` on an invalid or duplicate name.

```js
import { createEngine, builtins } from 'seebo';

const engine = createEngine({
  ...builtins.all, // explicit standard vocabulary (optional; always available)
  capabilities: {
    user: () => undefined, // interactive: its Needs are returned to the caller
    crm: (req) => fetchFromCrm(req.id), // a "data" capability (sync or Promise)
  },
  locale: 'it-IT',
  clock: () => new Date('2026-06-26T10:00:00Z'), // deterministic now()
  limits: { timeoutMs: 5000 },
});
```

All fields are optional. The full field-by-field tables live in the
[API reference](../api/overview.md#configuration); this page is the guided tour.

## Vocabulary

| Field          | Purpose                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------ |
| `types`        | Custom types from `defineType` (construction, validation, stringification).                      |
| `functions`    | Custom producers/transformers from `defineFunction`.                                             |
| `macros`       | Custom aggregator/layout macros from `defineMacro`.                                              |
| `libraries`    | Namespaced function groups from `defineLibrary` (a plain string only enables the namespace).     |
| `capabilities` | The whole capability set — resolver functions or `defineCapability` descriptors with a contract. |
| `actions`      | Action handlers from `defineAction`, executed only via `seebo/actions`.                          |

Every introduced name is validated at construction (**name governance**): reserved words are
rejected (`RESERVED_NAME`) and each namespace enforces uniqueness (`NAME_CONFLICT`). See
[Usage & extensibility](../guide/usage.md#extensibility-spec-26) for worked examples of
every `define*` factory.

## Environment

| Field    | Default            | Purpose                                                            |
| -------- | ------------------ | ------------------------------------------------------------------ |
| `locale` | `'en-US'`          | BCP-47 locale used when stringifying numbers, dates and durations. |
| `clock`  | `() => new Date()` | Injected clock read by `now()` — fix it for deterministic output.  |
| `seed`   | —                  | Reserved (unused in v1).                                           |

## Delimiters

The three slot sigils are configurable (SPEC §1.2). Defaults:

```js
delimiters: { formula: '$', comment: '#', macro: '@', open: '{', close: '}' }
```

| Slot    | Default syntax | Meaning                                            |
| ------- | -------------- | -------------------------------------------------- |
| Formula | `${ expr }`    | Evaluated and stringified at emission.             |
| Comment | `#{ ... }`     | Removed from the output.                           |
| Macro   | `@{ NAME(…) }` | Aggregator (pre-pass) or layout (post-pass) macro. |

## Limits

Every phase is bounded; a breach fails with a specific diagnostic code — never a silent
truncation. Defaults (override via `limits`):

| Limit             | Default   | Phase  | Code                     |
| ----------------- | --------- | ------ | ------------------------ |
| `maxInputBytes`   | 1 000 000 | parse  | `INPUT_LIMIT_EXCEEDED`   |
| `maxTokens`       | 100 000   | parse  | `TOKEN_LIMIT_EXCEEDED`   |
| `maxNodes`        | 50 000    | parse  | `NODE_LIMIT_EXCEEDED`    |
| `maxNestingDepth` | 200       | parse  | `NESTING_LIMIT_EXCEEDED` |
| `maxSteps`        | 1 000 000 | run    | `STEP_LIMIT_EXCEEDED`    |
| `maxOutputBytes`  | 1 000 000 | run    | `OUTPUT_LIMIT_EXCEEDED`  |
| `maxDepth`        | 20        | expand | `DEPTH_EXCEEDED`         |
| `maxPhases`       | 10        | driver | `MAX_PHASES_EXCEEDED`    |
| `timeoutMs`       | 2000      | driver | `TIMEOUT`                |

See the [security model](../security/security.md#configurable-limits) for what each limit
guards against and how a breach surfaces.

## Policy

`policy` governs what a template may use and which capabilities it may invoke:

- `allowedTypes` / `allowedFunctions` / `allowedCapabilities` — allow-lists enforced
  statically by `validate` (and, for capabilities, by the driver).
- `trustLevel` (`'untrusted'` by default) + `capabilityRules[cap].allowFrom` — per-capability
  trust gating, checked **before** a provider runs.
- `redact` / `audit` — mask sensitive values in diagnostics and observe capability
  resolutions via a hook.
- `retry` — provider retry policy (`{ attempts, backoffMs }`; default: no retry).
- `action` — allow/deny action types, environment rules, forced confirmation
  (see [Actions](../guide/actions.md)).

```js
const engine = createEngine({
  capabilities: { secrets: () => readSecret() },
  policy: {
    trustLevel: 'untrusted',
    capabilityRules: { secrets: { allowFrom: 'trusted', audit: true } },
    redact: ['secrets'],
  },
});
```

## Optimizations

All optimizations are **off by default**. The only one implemented in v1 is
`optimizations.astCache` — a transparent, opt-in parse/analysis memoization worth enabling
for long-lived engines that render the same templates repeatedly. `lazyParse`, `stream` and
`objectPool` are accepted but inert. See [Performance](../guide/performance.md).

```js
const engine = createEngine({ optimizations: { astCache: true } });
```

## Next steps

- [First run](first-run.md) — the suspend/resolve/resume loop in practice.
- [API reference](../api/overview.md) — every config field and its exact shape.
