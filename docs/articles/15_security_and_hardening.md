# Security and Hardening: Running Untrusted Templates Safely

## Table of Contents

1. [The Threat Model](#1-the-threat-model)
2. [The Pure Core as a Security Boundary](#2-the-pure-core-as-a-security-boundary)
3. [Non-Turing Completeness and What It Buys You](#3-non-turing-completeness-and-what-it-buys-you)
4. [Resource Limits: The First Line of Defense](#4-resource-limits-the-first-line-of-defense)
5. [Prototype Pollution: The JavaScript-Specific Hazard](#5-prototype-pollution-the-javascript-specific-hazard)
6. [Policy Enforcement: Capabilities and Trust Levels](#6-policy-enforcement-capabilities-and-trust-levels)
7. [The Audit and Redact Hooks](#7-the-audit-and-redact-hooks)
8. [Retry Policy and Failure Classification](#8-retry-policy-and-failure-classification)
9. [The No-Console-Output Invariant](#9-the-no-console-output-invariant)
10. [The Trust Boundary Between Client and Server](#10-the-trust-boundary-between-client-and-server)
11. [What Seebo Does Not Protect Against](#11-what-seebo-does-not-protect-against)
12. [Conclusion](#conclusion)
13. [Further Reading](#further-reading)

---

## 1. The Threat Model

A security analysis begins by identifying what you are protecting, what you are protecting it from, and which agents you choose to trust. Without a clear threat model, security measures become either insufficient or paranoid — both are expensive in different ways.

In Seebo, three distinct categories of input exist, each with a different trust level.

**Untrusted templates** are the primary attack surface. In a low-code platform, templates are authored by end users, operations staff, or customer support agents — people who are not developers, whose intentions may vary, and whose templates arrive over a network. An untrusted template might attempt to exhaust memory by generating an enormous output, cause an infinite loop to lock a thread, exfiltrate data by constructing side-channel expressions, or inject malformed content into the resolved output. Seebo treats every template string as adversarial input by default.

**Untrusted data** is the capability-resolved payload: values returned by a CRM lookup, typed into a form by a user, or fetched from an external API. This data passes through a sanitization boundary on entry. It is never allowed to influence the evaluator's control flow in unintended ways.

**Trusted extensions** are the `define*` registrations: `defineFunction`, `defineCapability`, `defineType`, `defineMacro`, `defineLibrary`. These are host code, written by the application developer who configures the engine. They receive plain JavaScript values and can do anything a normal JavaScript function can do. This is intentional — the extension API is an escape hatch from the controlled environment, and it requires trust by design.

The trust boundary is therefore not drawn around the entire engine. It is drawn around the **pure core**: the lexer, parser, and evaluator. Everything inside that boundary is controlled, bounded, and verifiable. Everything outside it — capability providers, extension implementations — is trusted host code.

---

## 2. The Pure Core as a Security Boundary

The lexer, parser, and evaluator share one crucial property: they are **pure functions**. Given the same template string and configuration, they return exactly the same result. They do not read from the network. They do not write to the file system. They do not call `setTimeout`. They do not emit console output. They have no side effects beyond producing their return value.

This purity is not just a convenience for testing. It is a security property. A pure function cannot be used to exfiltrate data — there is no channel through which data can leave. A pure function cannot be influenced by ambient state — there is no global mutable environment a template author can read. A pure function cannot cause I/O to happen during evaluation — the template engine cannot be weaponized as a proxy for network requests.

The evaluator (`src/eval/evaluator.js`) enforces this explicitly. The `EvalContext` passed to each expression evaluation contains only the information derived from the template itself: `resolved` values already in scope, `symbols` collected from declarations, `needs` being accumulated, a `clock` function, and a step counter. No file handles. No network objects. No database connections. An expression can only return `Ok(Value)`, `Susp(Need)`, or `Err(Diagnostic)`. It cannot produce side effects.

When an expression needs external data — a CRM lookup, a user-typed value — it returns `Susp(Need)`. The driver layer, which lives outside the pure core and is explicitly allowed to perform I/O, receives the need and satisfies it asynchronously. The evaluator then runs again from scratch with the new value in scope. This full re-evaluation strategy means the evaluator never holds a partial continuation that could be corrupted by a slow or malicious provider.

---

## 3. Non-Turing Completeness and What It Buys You

Template engines often evolve toward general-purpose languages. The desire to compute conditionals leads to if/else. Conditionals lead to loops. Loops lead to recursion. Recursion leads, eventually, to an accidental Turing-complete language where no static bound on execution time is possible.

Seebo deliberately stops short of that cliff. The expression language has no loops, no recursion, no user-defined functions, and no mutable variables. A template author can compute arithmetic, apply string transformations, navigate object members, apply conditional logic with the ternary operator, and declare requirements. That is enough to describe almost any document structure. It is not enough to write a busy-wait loop or an infinite recursion.

The implications for security are concrete. Because the language is not Turing-complete, the evaluator's halting problem is trivially solved: every well-formed expression terminates. There exists a finite upper bound on the number of evaluator steps required to evaluate any expression of a given parse size. That bound does not depend on runtime values. This means resource limits on evaluation steps can be set conservatively — and if they are ever exceeded, it is a sign of either a bug in the engine or a pathological input, not a legitimate use case.

It also means the static analyzer can determine the evaluation plan without running the evaluator. The execution phase for each requirement — which phase it becomes active in, which other requirements it depends on — can be computed purely from the AST. No abstract interpretation, no type inference, just a graph traversal. This would be impossible in a Turing-complete language where execution order can depend on arbitrary values.

---

## 4. Resource Limits: The First Line of Defense

Even a non-Turing-complete engine needs resource limits. A template author can write an expression that tokenizes into 50,000 tokens, builds a 50,000-node AST, and produces a megabyte of output — without writing anything that an exhaustion-aware validator would flag as malicious. The defense-in-depth answer is configurable, fail-closed limits at every phase.

All limits are collected in `src/util/limits.js` as a single `DEFAULT_LIMITS` object, which is explicitly documented as the single source of truth shared by the lexer, parser, evaluator, and driver. Every limit can be overridden per-engine via `config.limits`.

### Parse-phase limits

**`maxInputBytes` (default: 1,048,576)** — The lexer checks the byte length of the template string before processing a single character. If it exceeds this threshold, a `INPUT_LIMIT_EXCEEDED` diagnostic is produced and parsing halts. This prevents the allocations that would otherwise accompany a very large token stream.

**`maxTokens` (default: 100,000)** — After the lexer runs, the parser checks the token count. A very long arithmetic expression might be small in bytes but expand into many tokens. This limit catches that case before the parser allocates an AST.

**`maxNodes` (default: 50,000)** — During parsing, each time a node is constructed the counter is incremented. A deeply nested object literal with many entries can produce many nodes even from moderate token counts. This limit bounds the total parse-time allocation.

**`maxNestingDepth` (default: 200)** — Expression parsers are often implemented with recursive descent or Pratt parsing, both of which consume a call-stack frame per nesting level. A template like `${ ((((((...))))))}` with 10,000 pairs of parentheses would overflow the JavaScript call stack without this limit. Each time the parser descends into a sub-expression, it checks the depth counter and returns `NESTING_LIMIT_EXCEEDED` before the stack exhausts.

### Evaluation-phase limits

**`maxSteps` (default: 1,000,000)** — At the start of each expression evaluation, the evaluator increments `ctx.steps` and compares it to `ctx.maxSteps`. If the budget is exceeded, it returns `Err(STEP_LIMIT_EXCEEDED)` immediately. This bounds the evaluation time for very complex expressions, even though the language is non-Turing-complete.

### Output limits

**`maxOutputBytes` (default: 1,048,576)** — After evaluation produces the final output string, its UTF-8 byte length is computed and compared to this limit. The check uses a manual byte-counting loop that handles ASCII in one branch and multi-byte UTF-8 sequences in others, without allocating a `Buffer`. If the limit is exceeded, the engine returns `OUTPUT_LIMIT_EXCEEDED` rather than returning a truncated or partial output. This is a hard stop: there is no "output the first megabyte and truncate" mode.

### Driver-phase limits

**`maxPhases` (default: 10)** — Each time the driver resolves a batch of needs and calls `run()` again, the phase counter increments. If a template's requirement graph has too many phases — or if the driver is somehow caught in a cycle — this limit stops the loop with `MAX_PHASES_EXCEEDED`.

**`timeoutMs` (default: 2,000ms)** — Each capability provider call is wrapped in a `withTimeout` function that races the provider promise against a `setTimeout`. If the provider does not respond within the budget, the race resolves to an error, which the driver classifies as `CAPABILITY_ERROR`. This prevents a single slow external service from blocking the engine indefinitely.

**`maxDepth` (default: 20)** — Template inclusion depth via the `ABSORB` macro. Each recursive include increments a counter; exceeding `maxDepth` produces `DEPTH_EXCEEDED` and halts the expansion.

The design principle underlying all these limits is **fail-closed semantics**: any limit exceeded causes the engine to halt with a structured `Diagnostic` carrying the relevant code. There is no partial output, no silent truncation, no degraded mode. The host receives a clean error it can act on. A conformance test demonstrates this directly:

```js
test('IMPL §13 — output over maxOutputBytes ⇒ OUTPUT_LIMIT_EXCEEDED', () => {
  const engine = realEngine({ limits: { maxOutputBytes: 4 } });
  const state = engine.run(engine.start('Hello, world')); // 12 bytes > 4
  assert.equal(state.status, Status.FAILED);
  assertHasCode(state.diagnostics ?? [], DiagnosticCode.OUTPUT_LIMIT_EXCEEDED);
});
```

The limit is measured in UTF-8 bytes. A template that emits only ASCII characters can reach the limit quickly; a template emitting multi-byte Unicode sequences reaches it more slowly per character. The measurement is correct either way because the engine counts bytes, not code units.

---

## 5. Prototype Pollution: The JavaScript-Specific Hazard

Prototype pollution is a JavaScript-specific attack that exploits the language's prototype chain. In JavaScript, every object inherits from `Object.prototype`. If an attacker can cause `Object.prototype.__proto__` to be written, or cause a property assignment to run through a setter inherited from `Object.prototype`, they can inject properties into every plain object in the program. In a server-side JavaScript application, this can bypass access controls, corrupt data structures, or enable remote code execution.

The attack surface is real: any code that does `obj[key] = value` where `key` is attacker-controlled is potentially vulnerable. In a template engine, requirement IDs, object literal keys, and deserialized JSON values are all attacker-controlled.

Seebo addresses prototype pollution at three distinct points.

### sanitize.js: dropping `__proto__` on JSON input

When a value arrives as a JavaScript object from external code — via `makeObject`, `makeArray`, or `fromJs` — it passes through `sanitizeJson` in `src/runtime/sanitize.js`. This function performs a deep clone of the input, and during that clone it explicitly skips any key named `__proto__`:

```js
for (const key of Object.keys(obj)) {
  // Drop `__proto__` (the only key whose assignment hits the prototype setter)
  if (key === '__proto__') continue;
  Object.defineProperty(out, key, {
    value: clone(obj[key], depth + 1),
    writable: true,
    enumerable: true,
    configurable: true,
  });
}
```

Two things are noteworthy here. First, `__proto__` is simply skipped — not mapped to a different name, not flagged as an error, just dropped. Second, all other keys are written using `Object.defineProperty` with an explicit property descriptor, not `out[key] = value`. This is important because `Object.defineProperty` bypasses the prototype chain entirely: it writes directly to the own property of `out` without consulting any inherited setter. Even if a hostile ancestor prototype had installed a setter on some other key, `defineProperty` would not trigger it.

The function also rejects non-plain objects (class instances, `Date`, `Map`, `Set`), non-finite numbers (`Infinity`, `NaN`, `-Infinity`), circular references (tracked via a `WeakSet`), and values of types that have no JSON representation (`function`, `symbol`, `bigint`, `undefined`). It enforces depth and node count limits to prevent deeply nested inputs from consuming disproportionate CPU.

### objectGet: refusing dangerous keys in member access

When a template expression reads a member from an object value — `${ order.customer }` — the evaluator calls `objectGet` from `src/runtime/values.js`. This function checks the key before accessing the object:

```js
export function objectGet(value, key) {
  if (value.type !== 'object') throw typeError(`cannot read a member of '${value.type}'`);
  if (typeof key !== 'string') throw typeError('object key must be a string');
  const obj = value.value;
  if (key === '__proto__' || !Object.prototype.hasOwnProperty.call(obj, key)) {
    throw typeError(`missing object key '${key}'`);
  }
  return fromJs(obj[key]);
}
```

The check `key === '__proto__'` is explicit. Even though `sanitizeJson` already dropped `__proto__` from the object during construction, `objectGet` refuses to read it regardless. This defense-in-depth means that even if a hypothetical future code path produced an object without going through `sanitizeJson`, member access would still refuse to read the prototype chain.

The guard on `constructor` and `prototype` is implicit here: the `hasOwnProperty` check ensures that only own properties are readable, which excludes `constructor`, `prototype`, `toString`, `valueOf`, and any other property inherited from `Object.prototype`. You cannot access `obj.constructor.name` through the template expression language.

### safeSet: using Object.defineProperty for requirement ID maps

When a requirement is satisfied and its value is stored, or when initial values are placed into `resolved`, the engine uses `safeSet` from `src/run/run.js`:

```js
export function safeSet(obj, key, value) {
  Object.defineProperty(obj, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}
```

This is the same pattern as `sanitizeJson`: use `Object.defineProperty` to write to an own property, bypassing any setter that might be installed on the prototype chain. Since requirement IDs come from templates (and are thus attacker-controlled), a malicious template could declare a requirement with the id `__proto__` and attempt to pollute the prototype when that requirement is satisfied. The `safeSet` call makes this impossible.

A conformance test demonstrates that this protection works end-to-end:

```js
test('a requirement declared as __proto__ never pollutes Object.prototype', async () => {
  const engine = realEngine({ capabilities: { user: () => ({ polluted: true }) } });
  await engine.stebo({
    template: "${ require({ id:'__proto__', type:object(), capability:'user' }) }",
  });
  assert.equal(({}).polluted, undefined);
});
```

The template attempts to satisfy a requirement named `__proto__` with the value `{ polluted: true }`, which would pollute `Object.prototype` if the assignment went through `obj.__proto__ = ...`. With `safeSet`, it creates an own property named `__proto__` on `resolved` instead, leaving `Object.prototype` untouched.

---

## 6. Policy Enforcement: Capabilities and Trust Levels

Resource limits and prototype-pollution guards protect against accidental or malicious resource exhaustion and memory corruption. Policy enforcement protects against a different class of threat: a template author using a capability they are not supposed to use, or a capability provider running for an untrusted template.

### allowedCapabilities

The simplest policy gate is a whitelist. If `config.policy.allowedCapabilities` is set to a list of strings, the driver checks each pending need's capability against that list:

```js
const allowed = cfg.policy?.allowedCapabilities;
if (allowed && !allowed.includes(cap)) {
  return {
    satisfied,
    failure: diag(DiagnosticCode.CAPABILITY_FORBIDDEN, { capability: cap })
  };
}
```

This is a **hard stop**: if the capability is not in the list, the driver returns a `failed` state immediately with `CAPABILITY_FORBIDDEN`. It does not continue resolving other needs. It does not warn. It does not fall through.

```json
{
  "policy": {
    "allowedCapabilities": ["user", "crm"]
  }
}
```

With this configuration, a template that references a capability named `email_sender` would fail immediately when the driver encounters that need, before the provider is ever called.

### capabilityRules and trust levels

A more nuanced policy uses `capabilityRules` to associate a minimum trust level with each capability:

```js
const rule = cfg.policy?.capabilityRules?.[cap];
if (rule?.allowFrom === 'trusted' && (cfg.policy?.trustLevel ?? 'untrusted') !== 'trusted') {
  return {
    satisfied,
    failure: diag(DiagnosticCode.CAPABILITY_FORBIDDEN, { capability: cap })
  };
}
```

A capability with `allowFrom: 'trusted'` can only be used by a trusted template. If the engine's policy sets `trustLevel: 'untrusted'` (the default), any use of that capability is immediately forbidden. This allows the host to run untrusted templates with access to a subset of capabilities while reserving high-impact capabilities (sending emails, modifying records) for templates that have been reviewed and approved.

The policy configuration might look like:

```js
const engine = createEngine({
  capabilities: { crm: crmProvider, emailSender: emailProvider },
  policy: {
    trustLevel: 'untrusted',
    allowedCapabilities: ['crm'],
    capabilityRules: {
      emailSender: { allowFrom: 'trusted' },
    },
  },
});
```

An untrusted template can use `crm` but not `emailSender`. A trusted template (engine configured with `trustLevel: 'trusted'`) could use both.

The policy check happens in the driver, **before** the provider function is called. This means the provider is never invoked for a forbidden capability. There is no way for the template to cause the provider to run and then have its result discarded.

---

## 7. The Audit and Redact Hooks

Policy enforcement prevents capabilities from running when they should not. The audit hook records what capabilities did run, producing an immutable log of every capability invocation.

```js
function auditEvent(cfg, need, outcome) {
  const audit = cfg.policy?.audit;
  if (typeof audit !== 'function') return;
  const rule = cfg.policy?.capabilityRules?.[need.capability];
  if (rule && rule.audit === false) return; // per-capability opt-out
  audit({ capability: need.capability, id: need.id, outcome });
}
```

The audit event contains the capability name, the requirement ID, and the outcome (`Resolved`, `Unresolved`, `ProviderError`, `InvalidValue`). Crucially, it does not contain the resolved value. The host receives a record of what happened, not what the values were. Sensitive values — API keys, personal data returned from a CRM — never appear in audit logs unless the host explicitly adds them.

For diagnostics that do contain potentially sensitive data, the redact hook allows the host to mask values:

```js
function redacted(cfg, cap, value) {
  return cfg.policy?.redact?.includes(cap) ? '«redacted»' : value;
}
```

If the capability is in the `redact` list, any error message or diagnostic data involving that capability's output is replaced with the literal string `«redacted»`. This prevents, for example, an `CAPABILITY_INVALID_VALUE` diagnostic from leaking a raw database value into a log stream.

An audit log entry structure:

```js
{
  capability: 'crm',
  id: 'customer_name',
  outcome: 'Resolved'
}
```

A complete policy configuration integrating both hooks:

```js
const engine = createEngine({
  capabilities: { crm: crmProvider, password_hash: hashProvider },
  policy: {
    audit: (event) => auditLogger.log(event),
    redact: ['password_hash'],
    capabilityRules: {
      crm: { audit: true },
      password_hash: { audit: false }, // also suppress from audit entirely
    },
  },
});
```

---

## 8. Retry Policy and Failure Classification

Capability providers can fail for transient reasons: a network timeout, a momentarily unavailable service, a rate limit. The driver supports a configurable retry policy:

```js
const attempts = Math.max(0, cfg.policy?.retry?.attempts ?? 0);
const backoffMs = Math.max(0, cfg.policy?.retry?.backoffMs ?? 0);
```

By default there are zero additional attempts — the driver calls the provider once and classifies the result. When `retry.attempts` is greater than zero, the driver retries on exceptions, with an optional inter-attempt delay controlled by `retry.backoffMs`.

The driver classifies each provider invocation into one of four normative outcomes:

- **Resolved**: the provider returned a non-undefined value, the value was convertible to a Seebo type, and it satisfies the requirement's declared type and constraints. The value is stored in `satisfied`.
- **Unresolved**: the provider returned `undefined`. This means "not me — try again later" or "I can't answer this right now." The need remains in `pending`.
- **ProviderError**: the provider threw an exception, or timed out. The engine returns a `failed` state with `CAPABILITY_ERROR`. No partial output is produced.
- **InvalidValue**: the provider returned a value that cannot be converted to the declared type, or a value that violates the requirement's constraints. The engine returns a `failed` state with `CAPABILITY_INVALID_VALUE`. This prevents a capability from smuggling wrong-typed data into the evaluation.

This four-way classification means the driver never silently swallows errors or produces incorrect output. Every deviation from the expected path results in a named diagnostic.

---

## 9. The No-Console-Output Invariant

The Seebo core — every file under `src/` — never calls `console.log`, `console.warn`, `console.error`, or any other console method. This is an explicit architectural invariant, not an accident.

The reason is observability and security. In server-side JavaScript, `console.log` writes to stdout, which is often connected to a log aggregation pipeline. If the engine emitted diagnostic information via console, that information would flow into logs without the host's knowledge or control. The host would have no way to redact sensitive values, suppress verbose output, or route diagnostics to the appropriate sink.

Instead, every piece of diagnostic information is returned as a structured `Diagnostic` object. The host decides what to do with it. The host can log it, suppress it, forward it to a monitoring system, or display it to the user. The engine remains silent.

This invariant also simplifies testing. A test that expects a certain diagnostic can assert against the returned array. It does not need to intercept `console.log` calls or capture stdout. The diagnostic contract is observable without side effects.

---

## 10. The Trust Boundary Between Client and Server

In a web application, the Seebo engine can run both in the browser and on the server. The browser runs the engine for UX purposes: instant preview as the user types, form validation, wizard step computation. The server runs the engine as the authoritative evaluator before delivering output.

These two execution environments have different trust implications. The browser environment is user-controlled. Any policy configuration set in the browser can be bypassed by the user. The browser's `allowedCapabilities` list can be changed. The browser's limit overrides can be removed. The browser's registry can be extended with custom functions.

The server is the authority. The server's engine configuration is under the host's control. The server's policy is enforced before any output reaches its final destination. The server's limit configuration cannot be overridden by a user.

This means the correct architecture is: run the engine on the client for responsiveness, but treat the client's output as untrusted preview. Run the engine again on the server before any output is committed, sent, or acted upon. The pure synchronous core makes this trivial — the same `run()` call, the same `stebo()` call, work identically in both environments. The only difference is what capability providers are registered and what policy is configured.

A template that behaves differently between client and server — because a client-side capability provider returns a different value than the server's authoritative provider — will produce different output. The server's output is what matters.

---

## 11. What Seebo Does Not Protect Against

A clear threat model includes explicit statements about what is out of scope. Seebo does not protect against:

**Malicious extension code.** Extensions registered via `defineFunction`, `defineType`, `defineCapability`, `defineLibrary`, and `defineMacro` are trusted host code. They receive plain JavaScript values and can do anything a JavaScript function can do: call external services, read environment variables, write to disk, or launch child processes. If an extension does something dangerous, that is the host's responsibility, not the engine's.

**Capability providers that return incorrect data.** A CRM provider that returns the wrong customer's data, or a database provider that returns data the requesting user should not see, is an authorization failure in the capability layer, not in the engine. The engine enforces that the returned value matches the declared type and constraints, but it cannot enforce semantic correctness.

**Host misconfiguration.** If the host sets `maxInputBytes` to 100 billion, or sets `allowedCapabilities` to include every capability including sensitive ones, or fails to set `trustLevel` correctly, the engine will comply. The limits are configurable for good reason — different use cases have different requirements — but they can be misconfigured.

**Side-channel attacks through timing.** Because the evaluator has a step counter, an attacker who can measure the time a template takes to evaluate might be able to infer information about the values in scope (e.g., by constructing expressions that take longer to evaluate when a value is in a certain range). This is a theoretical attack and mitigating it would require constant-time evaluation semantics, which are not in scope for v1.

---

## Conclusion

Seebo's security posture rests on a small number of reinforcing principles. The pure core is a natural security boundary: no I/O, no side effects, no external communication. Non-Turing completeness eliminates the halting problem and makes resource limits both meaningful and sufficient. Resource limits at every phase — input, tokens, nodes, nesting, steps, output, phases, time — provide defense in depth against exhaustion attacks. Prototype-pollution guards at three separate points — `sanitize.js`, `objectGet`, `safeSet` — prevent a class of JavaScript-specific attacks that would otherwise allow template content to corrupt the host process's memory. Policy enforcement provides a capability whitelist, trust levels, and audit hooks that give the host fine-grained control over what templates are allowed to do.

These are not independent features. They form a coherent system where each layer assumes the layers before it may fail, and compensates accordingly. The fail-closed semantics that run through every limit, every policy check, and every type validation ensure that when something goes wrong, the engine produces a clean diagnostic rather than a wrong answer.

---

## Further Reading

- `src/util/limits.js` — the single source of truth for all resource limits
- `src/runtime/sanitize.js` — the JSON sanitization boundary with prototype-pollution guards
- `src/run/run.js` — `safeSet` and the state machine's fail-closed error handling
- `src/driver/async_driver.js` — capability enforcement, policy checks, audit hooks, retry logic
- `src/runtime/values.js` — `objectGet` and the prototype-pollution guards on member access
- `test/conformance/limits.test.js` — conformance tests for every resource limit
- IMPL §13 — the specification section on resource limits and hardening
- SPEC §1.11 — the normative output size limit
