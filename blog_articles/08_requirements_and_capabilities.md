# Requirements and Capabilities: Declarative Data Dependencies

## Table of Contents

1. [The Fundamental Idea](#the-fundamental-idea)
2. [RequirementDescriptor: the Full Structure](#requirementdescriptor)
3. [Capabilities: Named Providers](#capabilities)
4. [The Four Provider Outcomes](#the-four-provider-outcomes)
5. [User-Provided Values and Pre-Population](#user-provided-values)
6. [Resolution Precedence](#resolution-precedence)
7. [Requirements as a Bridge to UI Forms](#requirements-as-a-bridge-to-ui-forms)
8. [Capability-Based Design vs Dependency Injection](#capability-based-design)
9. [The stopOn Option: Pausing at Capabilities](#the-stopon-option)
10. [Worked Examples](#worked-examples)
11. [Why Capabilities Are Not Pure Functions](#why-capabilities-are-not-pure-functions)
12. [Conclusion](#conclusion)
13. [Further Reading](#further-reading)

---

## The Fundamental Idea

In a conventional template language, data is passed in from outside as a flat dictionary. The template assumes all its variables are present and fails obscurely if they are not. There is no mechanism for the template to say "I need this, and here is who should provide it."

Seebo inverts this. A template does not receive a pre-populated dictionary; it declares what it needs. Each `require(...)` expression is an explicit declaration of a missing datum, complete with its identifier, its type, which named provider should supply it, and optionally a human-readable label, a default value, and whether the datum is optional.

```
Dear ${ require({ id: 'name', type: string(), capability: 'user', label: 'Customer name' }) },
your invoice total is ${ require({ id: 'total', type: float(), capability: 'crm' }) }.
```

When this template is evaluated without `name` or `total` in the resolved set, the evaluator does not fail. It emits two `Susp(Need)` results, one for each requirement. The engine transitions to `waiting` status and surfaces the pending requirements. The driver then calls the registered capability providers (`user` and `crm`) to obtain the values, adds them to the resolved set, and re-evaluates. On the second pass, both requirements are satisfied, and the template completes.

This is not "templates with error messages." It is a deliberate suspension-and-resumption model where missing data is expected, not exceptional.

---

## RequirementDescriptor: the Full Structure

A `RequirementDescriptor` is the runtime representation of a `require(...)` call after it has been extracted from the AST by `src/eval/symbols.js`:

```js
/**
 * @typedef {Object} RequirementDescriptor
 * @property {string} id                  Unique identifier within the template.
 * @property {TypeDescriptor} type        Type builder descriptor.
 * @property {string} capability          Which named provider supplies this value.
 * @property {string} [label]             Human-readable hint for UI.
 * @property {string} [description]       Longer descriptive text.
 * @property {boolean} [optional]         Whether the value is required.
 * @property {number} [priority]          Relative priority hint for the provider.
 * @property {string} [group]             Grouping hint for form generation.
 * @property {Record<string, unknown>} [resolverHints]  Extra metadata for the provider.
 * @property {number} [phase]             Analyze-derived phase annotation.
 * @property {unknown[]} [options]        Analyze-derived options annotation.
 */
```

The `extractRequirement` function in `src/eval/symbols.js` reads this from the AST's `ObjectLit` node:

```js
export function extractRequirement(call) {
  const obj = call.args[0];
  if (!obj || obj.kind !== 'ObjectLit')
    throw syntax('require(...) expects a descriptor object', call);
  const d = readDescriptorObject(obj);
  if (typeof d.id !== 'string')
    throw syntax("require descriptor needs a string 'id'", call);
  if (typeof d.capability !== 'string')
    throw syntax(`require '${d.id}' needs a 'capability'`, call);
  if (!d.type) d.type = builder('string').toDescriptor();
  return d;
}
```

The `id` and `capability` fields are required. The `type` defaults to `string()` if omitted. All other fields are optional and are passed through to the provider when the capability is invoked. The `resolverHints` field is an open-ended metadata bag: a CRM capability might use `resolverHints: { entity: 'customer', field: 'fullName' }` to know precisely which database field to query.

---

## Capabilities: Named Providers

Capabilities are registered at engine creation time. They are functions keyed by name in the `config.capabilities` map:

```js
const engine = createEngine({
  capabilities: {
    user:    async (req) => { /* read from session or form */ },
    crm:     async (req) => { /* query database */           },
    secrets: async (req) => { /* read from vault */          },
    env:     (req) => process.env[req.id],
  }
});
```

The provider function signature is:

```
(req: RequirementDescriptor) => Value | unknown | Promise<Value | unknown>
```

The provider receives the full `RequirementDescriptor` — including `id`, `type`, `label`, `resolverHints`, and any other metadata the template declared. It returns either:

- A `Value` (a pre-built typed value).
- A raw JavaScript value (`string`, `number`, `boolean`, `Date`, plain object, array), which will be converted via `fromJs`.
- `undefined`, meaning "I cannot or will not provide this value."
- A `Promise` of any of the above.
- An exception (thrown or rejected promise), classified as a provider error.

Providers are fully asynchronous. This is intentional: capability providers are the I/O boundary, and I/O in JavaScript is naturally async. The evaluator core is synchronous; the driver layer (`src/driver/async_driver.js`) is where the async/await happens.

---

## The Four Provider Outcomes

The driver classifies every provider invocation into one of four normative outcomes:

```js
export const ProviderOutcome = Object.freeze({
  RESOLVED:     'Resolved',
  UNRESOLVED:   'Unresolved',
  PROVIDER_ERROR: 'ProviderError',
  INVALID_VALUE:  'InvalidValue',
});
```

**Resolved**: the provider returned a non-undefined, type-compatible, constraint-satisfying value. This value is added to `state.resolved` and the engine re-runs.

**Unresolved**: the provider returned `undefined`. This means "I don't handle this requirement." The requirement stays in `pending`. Another provider might handle it in a future turn, or the `stopOn` mechanism might have paused the relevant capability. An unresolved requirement does not produce an error.

**ProviderError**: the provider threw an exception (or returned a rejected promise). This is a fatal error: the engine transitions to `failed` with `CAPABILITY_ERROR`. The template cannot complete.

**InvalidValue**: the provider returned a value that failed either the type check or the constraint validation. This is also a fatal error: `CAPABILITY_INVALID_VALUE`. The template cannot complete. This outcome exists to make provider bugs visible immediately rather than silently producing malformed output.

The classification logic in the driver:

```js
const raw = await withTimeout(Promise.resolve(provider(need)), timeoutMs);
if (raw === undefined) return { kind: ProviderOutcome.UNRESOLVED };

let value;
try { value = fromJs(raw); }
catch (e) { return { kind: ProviderOutcome.INVALID_VALUE, message: message(e) }; }

const wantType = need.type?.type;
if (wantType && value.type !== wantType) {
  return { kind: ProviderOutcome.INVALID_VALUE,
           message: `expected ${wantType}, got ${value.type}` };
}
value = withConstraints(withFormat(value, need.type?.format), need.type?.constraints);
const violation = validate(value);
if (violation) return { kind: ProviderOutcome.INVALID_VALUE, message: violation.message };
return { kind: ProviderOutcome.RESOLVED, value };
```

The timeout is configurable via `config.limits.timeoutMs` (default 2000ms). A provider that does not respond within the timeout produces a `ProviderError`.

---

## User-Provided Values and Pre-Population

The `values` argument to `start()` or to `stebo()` pre-populates `state.resolved` before the first evaluation pass:

```js
const state = start(template, {
  name:    'Alice',
  accountId: '12345',
}, config);
```

These values are converted via `fromJs` at `start()` time:

```js
for (const [id, raw] of Object.entries(initialValues ?? {})) {
  if (raw === undefined) continue;
  safeSet(resolved, id, fromJs(raw));
}
```

When the evaluator resolves a requirement, it first checks `state.resolved`. If the id is already there, the capability is never called. This is the mechanism by which user-submitted form data is fed back into the engine: the form collects values for the ids listed in the pending requirements, the application passes those values to the next `start()` or `drive()` call, and the engine uses them without invoking any provider.

The `safeSet` helper uses `Object.defineProperty` rather than simple assignment to guard against prototype-polluting requirement IDs:

```js
export function safeSet(obj, key, value) {
  Object.defineProperty(obj, key, {
    value, writable: true, enumerable: true, configurable: true
  });
}
```

---

## Resolution Precedence

The evaluator's `resolveRequirement` function applies a fixed priority order when handling a requirement:

```js
function resolveRequirement(d, ctx) {
  // 1. Already resolved (from state.resolved or a previous turn)
  if (Object.prototype.hasOwnProperty.call(ctx.resolved, d.id)) {
    return ok(asValue(ctx.resolved[d.id]));
  }
  // 2. Type descriptor has a default value
  const type = d.type ?? { type: 'string' };
  if (type.default !== undefined) return ok(fromJs(type.default));
  // 3. Optional: use the type's empty value
  if (d.optional === true) return ok(emptyValue(type.type));
  // 4. Emit a Need (suspend)
  ctx.needs.set(d.id, d);
  return susp(d);
}
```

In words:

1. **Pre-resolved** values (from user input or a previous capability invocation) are used without calling any provider again.
2. **Default values** declared in the type builder (`.default(value)`) are used when no resolved value exists.
3. **Optional requirements** without a default use the type's empty value (`''`, `0`, `false`, etc.).
4. **Everything else** emits a `Susp(Need)`, which is collected in the `pending` set and eventually handed to the driver for resolution.

This ordering ensures that user-provided values always win, defaults serve as fallbacks, optional requirements degrade gracefully, and only genuinely missing data triggers capability invocations.

---

## Requirements as a Bridge to UI Forms

The `analyze()` function extracts every requirement from the template statically:

```js
const analysis = engine.analyze(template);
analysis.requirements; // RequirementDescriptor[]
analysis.capabilitiesUsed; // string[]
analysis.executionPlan; // ExecutionPhase[]
```

The `requirements` array contains one entry per unique `id` declared in the template, regardless of which branch it appears in. The `executionPlan` describes which requirements become active in each phase (phase 1, phase 2, etc.), reflecting the lazy evaluation semantics: a requirement inside an untaken branch never becomes a Need, so its phase depends on what data triggers its branch.

An application building an interactive form can:

1. Call `analyze()` to get all requirements.
2. Filter by capability: `requirements.filter(r => r.capability === 'user')` gives the fields that need human input.
3. For each user-input requirement, render a form field using the `type` descriptor (for input type, constraints), `label` (for the field label), `description` (for help text), `optional` (for required/optional marking).
4. When the user submits the form, pass the values back as `values` to the next call.

The `executionPlan` can guide a multi-phase form: phase 1 fields are shown first; after those are filled, phase 2 fields become visible (because they depend on phase 1 values to determine which branch is taken).

---

## Capability-Based Design vs Dependency Injection

The capability system is analogous to dependency injection (DI), but there are important differences.

In a DI container, dependencies are resolved at object construction time, wired together before any execution begins. The set of dependencies is fixed for the lifetime of the object.

In Seebo, capabilities are resolved lazily, one requirement at a time, in response to the evaluator encountering an unsatisfied `require()`. The set of active requirements can change per phase because lazy evaluation means some requirements only become visible after earlier ones are satisfied. You cannot know statically which requirements will be active in phase 2 without knowing the values from phase 1 (though `analyze()` provides a static upper bound).

A DI container typically provides objects (services, repositories, configurations). A Seebo capability provides values: plain data that the evaluator uses to continue. The capability itself does not participate in the evaluation; it is called by the driver, which is outside the evaluator.

The analogy holds in one sense: both approaches make dependencies explicit. In DI, a class declares its constructor parameters. In Seebo, a template declares its `require()` calls. Both make it easy to see what a component needs without reading its implementation.

---

## The stopOn Option: Pausing at Capabilities

The `drive()` function accepts a `stopOn` option: an array of capability names that the driver should not resolve automatically. When a requirement's capability is in `stopOn`, the driver leaves it in `pending` and returns to the caller without waiting for a provider response.

```js
const state = await engine.drive(template, { stopOn: ['user'] });
if (state.status === 'waiting') {
  const userRequirements = state.pending.filter(r => r.capability === 'user');
  // render a form for userRequirements
  // user fills the form
  const userValues = { name: 'Alice', email: 'alice@example.com' };
  const finalState = await engine.drive({ ...state, resolved: { ...state.resolved, ...userValues } });
}
```

This is the mechanism for interactive multi-turn workflows: the driver handles non-interactive capabilities (CRM lookups, environment variables, secrets) automatically, and pauses for user-interactive capabilities, returning the pending requirements so the application can collect user input.

The `stebo` convenience function wraps the full pipeline (expand → drive → finalize) and also accepts `stopOn`:

```js
const state = await engine.stebo({
  template: myTemplate,
  values:   prefilledValues,
  stopOn:   ['user'],
});
```

---

## Worked Examples

### User Input Requirement (Interactive)

```
${ require({
     id: 'customerEmail',
     type: string().constraints({ minLen: 5, maxLen: 254 }),
     capability: 'user',
     label: 'Your email address',
     optional: false
   }) }
```

The `user` capability is in `stopOn`. The driver pauses and returns this requirement in `pending`. The application renders an email input field. The user types `alice@example.com`. The application calls `drive` again with `values: { customerEmail: 'alice@example.com' }`.

### CRM Capability (Database Lookup)

```
${ require({
     id: 'accountBalance',
     type: float().constraints({ precision: 2, min: 0 }),
     capability: 'crm',
     resolverHints: { entity: 'account', field: 'balance', currency: 'EUR' }
   }) }
```

The `crm` capability is not in `stopOn`. The driver calls `config.capabilities.crm(req)` where `req` is the full descriptor including `resolverHints`. The CRM provider reads `resolverHints` to know which entity and field to query. It returns `1234.56` (a JavaScript number). `fromJs(1234.56)` = `float(1234.56)`. The type check passes (`float` was declared). The constraint check passes (`min: 0` is satisfied). The value is resolved.

### Secrets Capability (Environment or Vault)

```
${ require({
     id: 'apiKey',
     type: string().constraints({ minLen: 20 }),
     capability: 'secrets',
     resolverHints: { secretName: 'PAYMENT_API_KEY' }
   }) }
```

The `secrets` capability reads from a vault or environment:

```js
capabilities: {
  secrets: async (req) => {
    const name = req.resolverHints?.secretName;
    return name ? await vault.read(name) : undefined;
  }
}
```

The `apiKey` value never appears in `state.output` because the template using it presumably does not interpolate it directly — it is used in a conditional or passed to a system call. The audit hook logs that the `secrets` capability was invoked, the outcome, but not the value itself (which is redacted by `config.policy.redact`).

### Environment-Specific Values

```js
capabilities: {
  env: (req) => process.env[req.id],
}
```

A simple synchronous provider. If `process.env['DB_HOST']` exists, the requirement `require({ id: 'DB_HOST', capability: 'env', ... })` resolves immediately. If not, the provider returns `undefined` (Unresolved). No async needed.

---

## Why Capabilities Are Not Pure Functions

Capabilities perform I/O: they query databases, call HTTP services, read from environment variables, prompt the user, or access hardware. I/O is inherently impure — calling the same capability twice with the same requirement descriptor may produce different values (the CRM balance may have changed; the user may type a different email).

This impurity is exactly why capabilities must not live inside the evaluator. The evaluator is pure: `evaluate(expr, ctx) → EvalResult` has no side effects and no I/O. It is a function of its AST and its resolved values only. This purity is what makes full re-evaluation safe (no side effects are duplicated) and what makes the state machine testable (you can test the evaluator by providing a `resolved` map without any async plumbing).

Capabilities live in the driver (`src/driver/async_driver.js`), which is the only async layer. The driver mediates between the pure synchronous core and the impure async world:

```
pure core: start() → run() → run() → ...
                ↕           ↕
async driver: calls capabilities, collects values, re-runs
```

This architecture is intentional and carefully maintained. Any time you are tempted to add a capability-like call inside an evaluator function, the right approach is to declare a `require()` in the template instead, let the evaluator emit a `Susp(Need)`, and handle it in the driver.

---

## Conclusion

Requirements and capabilities form a declarative dependency system for template data. A template does not assume its data exists; it declares what it needs and who should provide it. The engine's driver resolves those needs asynchronously, enforcing type and constraint checks on every provider response. The resolution precedence — pre-resolved values first, then defaults, then empty values for optional requirements, then suspension — ensures predictable, deterministic behavior.

This system enables several important patterns: multi-turn interactive workflows (via `stopOn`), form generation (via `analyze().requirements`), separation of concerns between template logic and data sourcing (via capability names), and security isolation (via policy allowlists and trusted/untrusted capability rules). The evaluator stays pure; the capabilities stay async; the boundary between them is the `Need`.

---

## Further Reading

- `src/eval/evaluator.js` — `resolveRequirement`, `evalCall` for `'require'`.
- `src/eval/symbols.js` — `extractRequirement`, `collectDeclarations`.
- `src/driver/async_driver.js` — `drive`, `stebo`, `resolvePending`, `callProvider`.
- `src/run/run.js` — `start`, `run`, `safeSet`.
- Martin Fowler's *Patterns of Enterprise Application Architecture*, chapter on Service Layer — the capability pattern is related to the Service Locator pattern, with explicit per-requirement invocation rather than global resolution.

---
