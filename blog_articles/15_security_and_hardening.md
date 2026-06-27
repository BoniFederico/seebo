# Security and Hardening: Running Untrusted Templates Safely

## Table of Contents

1. [The Threat Model](#the-threat-model)
2. [The Pure Core as a Security Boundary](#the-pure-core-as-a-security-boundary)
3. [Non-Turing Completeness and Security](#non-turing-completeness-and-security)
4. [Resource Limits: The First Line of Defense](#resource-limits-the-first-line-of-defense)
5. [Prototype Pollution: What It Is and How Seebo Prevents It](#prototype-pollution)
6. [Policy Enforcement](#policy-enforcement)
7. [The Audit Hook](#the-audit-hook)
8. [The Redact Hook](#the-redact-hook)
9. [No Console Output](#no-console-output)
10. [No Implicit External I/O](#no-implicit-external-io)
11. [The Client/Server Trust Boundary](#the-clientserver-trust-boundary)
12. [Sandboxing Principles](#sandboxing-principles)
13. [Worked Examples](#worked-examples)
14. [What Seebo Does Not Protect Against](#what-seebo-does-not-protect-against)
15. [Conclusion](#conclusion)
16. [Further Reading](#further-reading)

---

## The Threat Model

Security analysis begins with a threat model: a precise statement of what is trusted, what is untrusted, and what property we are trying to preserve.

In Seebo's threat model, there are three categories of input with different trust levels:

**Untrusted templates**: A template string received from an external source — user-generated content, a third-party integration, a database record written by an untrusted party. The engine must process this template without allowing it to escape its sandbox, consume unbounded resources, access unauthorized data, or corrupt the host process.

**Untrusted data**: Values provided as inputs to the template, including values returned by capability providers. These must be sanitized before entering the engine's value model, regardless of their source.

**Trusted extensions**: The `defineType`, `defineFunction`, `defineCapability`, `defineMacro`, and `defineLibrary` factories register host-provided code. This code is trusted — it is written by the engine operator, not by the template author. Extensions receive plain JavaScript values and can do whatever they like (including I/O), but they are not called from untrusted template expressions directly without mediation.

The property we want to preserve is: **a malicious or buggy template cannot cause the engine to do more than it is authorized to do** — it cannot consume unlimited CPU or memory, cannot access data outside its declared capabilities, cannot corrupt host process state, and cannot produce output that the host doesn't explicitly request.

---

## The Pure Core as a Security Boundary

The most important security property of Seebo's architecture is one that follows from its design for testability and correctness: the evaluator is pure.

A pure evaluator has no access to the file system, the network, process globals, or any other external resource. It is a function from (AST, resolved values, registry) to (output text, pending needs, diagnostics). The evaluator cannot exfiltrate data, because it has no channel through which to do so. It cannot corrupt shared state, because it doesn't write shared state.

This is not a security feature that was added to the evaluator — it is a consequence of the purity requirement. The security benefit comes for free. But it is a real and significant benefit: it means that evaluating a template, however maliciously constructed, cannot make network calls, write files, or spawn processes. The only power a template has is the power to produce a string, emit needs, and emit diagnostics.

The driver layer (which is impure and async) is where capabilities execute. The driver is controlled by the host application, not by the template. A template can request data from a named capability, but it cannot directly call the capability's `resolve` function — the driver mediates all capability invocations, enforcing policy, timeouts, and type validation.

---

## Non-Turing Completeness and Security

Seebo's template language is intentionally not Turing-complete. There are no loops, no recursion (templates can absorb other templates, but ABSORB is bounded by `maxDepth`), and no arbitrary control flow. The available control structures are ternary expressions, `match` expressions, `and`/`or`/`??` short-circuits — all of which terminate in bounded time.

This has a direct security implication: **no template can run forever**. In a Turing-complete template language (e.g., Jinja2's loops, Twig's macros), an adversarial template author can construct a template that runs indefinitely, consuming 100% CPU. This is a denial-of-service vector.

In Seebo, the `maxSteps` limit (default: 1,000,000) provides a backstop, but the more fundamental guarantee is the language design: the template language does not have the expressive power to encode an infinite computation. A `maxSteps` counter that never overflows because the language is bounded is better than a `maxSteps` counter that is the only thing standing between you and an infinite loop.

The bounded macro inclusion system (`maxDepth`) extends this property to the EXPAND phase: template composition is also finite.

---

## Resource Limits: The First Line of Defense

Even a non-Turing-complete language can consume excessive resources with sufficiently large inputs. Seebo enforces resource limits at every pipeline stage, each with a corresponding diagnostic code.

| Limit | Default | Phase | Diagnostic Code |
|-------|---------|-------|----------------|
| `maxInputBytes` | 1,048,576 (1MB) | lexer | `INPUT_LIMIT_EXCEEDED` |
| `maxTokens` | 100,000 | lexer | `TOKEN_LIMIT_EXCEEDED` |
| `maxNodes` | 50,000 | parser | `NODE_LIMIT_EXCEEDED` |
| `maxNestingDepth` | 200 | parser | `NESTING_LIMIT_EXCEEDED` |
| `maxSteps` | 1,000,000 | evaluator | `STEP_LIMIT_EXCEEDED` |
| `maxDepth` | 20 | EXPAND | `DEPTH_EXCEEDED` |
| `maxPhases` | 10 | driver | `MAX_PHASES_EXCEEDED` |
| `maxOutputBytes` | 1,048,576 (1MB) | evaluator | `OUTPUT_LIMIT_EXCEEDED` |
| `timeoutMs` | 2,000ms | driver | `TIMEOUT` |

Each limit is checked inline during its phase. When exceeded, the phase stops immediately with the corresponding diagnostic. The engine never silently produces incorrect or truncated output — it either produces the complete, correct output, or it fails with a diagnostic.

**`maxInputBytes`**: Checked before tokenization. A 2MB template string doesn't even get tokenized. This is the cheapest possible check — a simple byte count before any processing.

**`maxTokens`**: Checked during tokenization. A template that is within byte limit but contains pathologically many short tokens (e.g., `${ 1 }${ 1 }${ 1 }...` repeated 200,000 times) is caught here.

**`maxNodes`**: Checked during parsing. A deeply nested expression tree (`((((((1+2)+3)+4)+5)+6)...)`) may have many nodes even with few tokens.

**`maxNestingDepth`**: The parser tracks the current nesting depth (parentheses, function calls, member accesses) and fails if it exceeds this limit. This prevents stack overflows in recursive descent parsers.

**`maxSteps`**: The evaluator counts every expression evaluation and every operator application. This prevents evaluation of very large ASTs from consuming unbounded CPU.

**`maxDepth`**: The EXPAND phase tracks macro inclusion depth. This prevents ABSORB cycles and deeply nested template compositions.

**`maxPhases`**: The driver counts how many resolution cycles have been completed. This prevents pathological templates from requiring many rounds of capability resolution.

**`maxOutputBytes`**: The evaluator tracks the accumulated output size and fails before the output exceeds this limit. This prevents a template that generates gigabytes of output from consuming unbounded memory.

**`timeoutMs`**: Applied to each individual capability provider invocation. A provider that takes longer than `timeoutMs` milliseconds is killed with a `TIMEOUT` diagnostic and its Need is marked failed.

All limits are configurable. For untrusted templates in a multi-tenant system, you might use much smaller limits than the defaults. For trusted, large internal templates, you might increase them. The important thing is that every limit has a hard ceiling and a diagnostic code.

---

## Prototype Pollution: What It Is and How Seebo Prevents It

Prototype pollution is a class of JavaScript-specific vulnerability where an attacker can add or modify properties on `Object.prototype`, the root of JavaScript's prototype chain. Once `Object.prototype` is modified, every object in the process inherits the modified property, potentially causing unexpected behavior in unrelated code.

A classic prototype pollution attack looks like:

```js
// Malicious JSON input
JSON.parse('{"__proto__": {"isAdmin": true}}')
```

If the parsed object is used to extend another object with naive spreading (`Object.assign(target, parsed)`), the `__proto__` key causes `Object.prototype.isAdmin` to be set to `true`. Now every object in the process responds `true` to `obj.isAdmin`.

Seebo faces this risk in three places:

### sanitize.js: JSON Sanitization

When external JSON data enters the engine as an `object` or `array` value (via capability providers or the `values` parameter), it is sanitized by `src/runtime/sanitize.js`. The sanitizer:

1. Walks the entire JSON tree recursively
2. Skips any key that is `'__proto__'`, `'constructor'`, or `'prototype'`
3. Creates a new clean object using `Object.defineProperty` for each safe key

This ensures that no incoming JSON can poison the prototype chain, regardless of how it was constructed.

### objectGet: Member Access in the Evaluator

When a template expression accesses an object property (`${ customer.address }`), the evaluator calls an `objectGet` helper rather than using `obj[key]` directly. The helper explicitly refuses access to prototype-polluting keys:

```js
function objectGet(obj, key) {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
    return undefined;  // or emit Err(TYPE_ERROR_RUNTIME)
  }
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}
```

By using `hasOwnProperty`, the function ensures it only accesses properties directly on the object, not inherited properties. A template cannot use member access to traverse the prototype chain.

### safeSet: Requirement ID Maps

The engine maintains maps from requirement IDs to values. If requirement IDs come from templates (and they do — the `id` field of `require()` is a template-authored string), a malicious template could try to use `__proto__` as a requirement ID to pollute the map object.

`safeSet` prevents this by using `Object.defineProperty` rather than `obj[key] = value`:

```js
function safeSet(obj, key, value) {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
    throw new Error('Unsafe key: ' + key);
  }
  Object.defineProperty(obj, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true
  });
}
```

`Object.defineProperty` with an explicit descriptor bypasses any setter installed on the object or its prototype chain, preventing prototype-pollution attacks via setter hijacking.

---

## Policy Enforcement

Policy is the mechanism for controlling which capabilities a template is allowed to use. This is distinct from which capabilities are registered: a capability can be registered (so the engine knows about it) but blocked by policy (so specific templates cannot use it).

```js
const engine = createEngine({
  capabilities: {
    user: userProvider,
    crm: crmProvider,
    billing: billingProvider,   // registered but potentially restricted
    secrets: secretsProvider
  },
  policy: {
    allowedCapabilities: ['user', 'crm'],   // billing and secrets are blocked
    trustLevel: 'untrusted',
    capabilityRules: {
      secrets: { allowFrom: 'trusted' }     // secrets only for trusted templates
    }
  }
});
```

Policy is enforced at two points:

**At validate() time**: The validator checks `require()` calls against `policy.allowedCapabilities` and reports `POLICY_FORBIDDEN` for blocked capabilities. This catches policy violations statically, before any evaluation.

**At driver time**: The driver checks each pending Need against policy before calling the provider. A blocked capability produces `CAPABILITY_FORBIDDEN` in the diagnostics and does not call the provider. This is a hard stop — the provider function is never invoked.

The trust level mechanism allows different templates to run with different policies against the same engine:

```js
// High-trust template: can use all registered capabilities
await engine.stebo({
  template: '...',
  policy: { trustLevel: 'trusted' }
});

// Low-trust template: can only use 'user'
await engine.stebo({
  template: '...',
  policy: { allowedCapabilities: ['user'], trustLevel: 'untrusted' }
});
```

This allows a single engine instance to serve both internal (trusted) and user-submitted (untrusted) templates with appropriate capability restrictions.

---

## The Audit Hook

The audit hook provides a record of all capability invocations without exposing the resolved values.

```js
const engine = createEngine({
  ...config,
  policy: {
    audit: (event) => {
      logger.info('capability_invoked', {
        capability: event.capability,
        requirementId: event.id,
        outcome: event.outcome,     // 'resolved' | 'unresolved' | 'error' | 'invalid'
        timestamp: Date.now()
      });
    }
  }
});
```

The `event` object contains:
- `capability`: the name of the capability that was invoked
- `id`: the requirement ID
- `outcome`: what happened (resolved, unresolved, error, invalid value)
- No value: the resolved value is deliberately not included in the audit event

This last point is critical: the audit hook logs access patterns, not data. If the data itself should be logged, the `redact` hook (see below) can be used to conditionally include it for non-sensitive capabilities. But by default, audit logs do not contain resolved values.

The audit hook is called by the driver after each provider invocation, regardless of outcome. It is synchronous and should complete quickly — the driver does not await the audit hook.

---

## The Redact Hook

The redact hook allows sensitive values to be masked in diagnostic output and audit events.

```js
policy: {
  redact: (event) => {
    if (['ssn', 'credit_card', 'password'].includes(event.id)) {
      return { ...event, value: '[REDACTED]' };
    }
    return event;
  }
}
```

The redact hook receives the full event (including the resolved value, if any) and returns a modified event. By replacing the value with a placeholder, sensitive data is excluded from log output.

Note that redaction happens at the audit/diagnostic layer, not at the evaluation layer. The template still receives and processes the actual value — the redaction only affects what appears in logs and diagnostic messages.

---

## No Console Output

The engine's core — the evaluator, parser, validator, and all pure pipeline stages — never calls `console.log`, `console.warn`, `console.error`, or any other output function. This is a strict invariant.

The reason is simple: in production systems, unexpected console output is either:
1. A debugging artifact left in the code that wasn't removed — noise
2. An information leak — a security risk if logs are accessible to untrusted parties

The engine communicates entirely through its return values: the `PublicState` object (which contains `diagnostics`), the `Analysis` object, and exceptions from configuration errors (`EngineConfigError`). Nothing else. No side-channel communication through the console.

This makes the engine usable in environments where console output is captured and forwarded to monitoring systems, where it could cause noise or leakage. It also makes unit tests cleaner — tests don't need to suppress or capture console output.

---

## No Implicit External I/O

Closely related to the no-console invariant: the evaluator (and all other pure pipeline stages) never make network requests, file system calls, database queries, or any other external I/O. All I/O is explicit and confined to the driver layer, mediated through capability providers.

This is enforced by architecture, not by a runtime sandbox. The evaluator is written to not import any I/O modules (no `fs`, no `http`, no `fetch`). There is no way for a template expression to trigger a network call — the language does not have a construct for it.

The closest thing to I/O in a template is a capability call (`require({ capability: 'crm', ... })`), but this does not trigger I/O during evaluation. It emits a `Susp(Need)` that is collected by the state machine and later resolved by the driver. By the time the driver calls the capability provider, `run()` has completed and returned.

---

## The Client/Server Trust Boundary

Seebo is designed to be isomorphic — the same engine code runs on both the client (browser) and the server (Node.js). This is intentional and has a specific security implication.

**The client runs the engine for UX purposes**: preview rendering, form validation, static analysis. This is useful for fast, interactive experiences. But the client is not trusted — a malicious user can modify the client-side code or the data it sends.

**The server is the authority**: before any template output is acted upon (sent as an email, submitted as an API body, stored in a database), the server re-runs the template with the server-side capability providers and policy. The server does not trust the client's output.

This means:
- Client-side rendering is for display only. The server always re-validates.
- User-provided values are re-validated by the server's capability providers and type constraints.
- Policy enforcement happens on the server, where it cannot be bypassed.
- Capability providers that call external services run only on the server.

The isomorphic engine makes it easy to share the same template processing logic between client and server. The security guarantee comes from always re-running on the server before acting on any output.

---

## Sandboxing Principles

Seebo embodies several classical sandboxing principles:

**Least privilege**: Each template runs with the minimum capabilities it needs. The `allowedCapabilities` policy ensures that templates can only access data sources they are authorized to use.

**Fail closed**: When a limit is exceeded, a policy is violated, or a capability fails, the engine stops with a diagnostic rather than attempting to continue with potentially incorrect output. It is better to produce no output than to produce wrong output.

**Defense in depth**: Security does not rely on a single mechanism. Resource limits protect against denial of service. Prototype pollution guards protect against data corruption. Policy enforcement protects against unauthorized access. The pure core protects against side effects. Each layer provides independent protection.

**Deterministic failure modes**: When the engine fails, it fails in a predictable way. A `CONSTRAINT_VIOLATION` diagnostic always means the same thing. An `OUTPUT_LIMIT_EXCEEDED` diagnostic always means the output exceeded 1MB. There are no "it depends" failure modes.

---

## Worked Examples

### Example 1: Blocked Capability

```js
const engine = createEngine({
  capabilities: { user: userProvider, crm: crmProvider },
  policy: { allowedCapabilities: ['user'] }   // crm is blocked
});

engine.validate('${ crm({ id: "order", type: object() }) }');
// Returns:
// [{ code: 'POLICY_FORBIDDEN', message: "Capability 'crm' is not allowed by policy.", ... }]
```

### Example 2: Unsafe Object Key Rejected

```js
// Incoming JSON with __proto__ pollution attempt
const maliciousInput = JSON.parse('{"__proto__": {"isAdmin": true}, "name": "Alice"}');

// sanitize.js drops __proto__; only { name: 'Alice' } enters the engine
const value = engine.fromJs(maliciousInput);
// value.value === { name: 'Alice' }
// Object.prototype.isAdmin is NOT set
```

### Example 3: Output Limit Exceeded

```js
// Template that generates enormous output
const hugeTemplate = '${ string("x").repeat(2000000) }';  // 2MB of x's

const state = engine.run(engine.start(hugeTemplate, {}));
// state.status === 'failed'
// state.diagnostics === [{ code: 'OUTPUT_LIMIT_EXCEEDED', ... }]
```

### Example 4: Audit Log Entry

```js
policy: {
  audit: (event) => console.log(JSON.stringify(event))
}
// Produces log entries like:
// {"capability":"crm","id":"order_data","outcome":"resolved","timestamp":1750000000000}
// {"capability":"user","id":"saluto","outcome":"resolved","timestamp":1750000000001}
```

### Example 5: Policy Configuration

```js
const engine = createEngine({
  capabilities: { user: u, crm: c, billing: b },
  policy: {
    allowedCapabilities: ['user', 'crm'],  // billing blocked
    trustLevel: 'untrusted',
    audit: (e) => auditLog.write(e),
    redact: (e) => e.id === 'password' ? { ...e, value: '[REDACTED]' } : e
  }
});
```

---

## What Seebo Does Not Protect Against

Honesty requires stating what Seebo's security model does not cover.

**Malicious extension code**: Extensions registered via `defineType`, `defineFunction`, etc. are trusted. If a `defineFunction` implementation does something malicious (exfiltrates data, corrupts state), Seebo cannot prevent it. Extensions are operator-provided code and are trusted by design.

**Malicious capability providers**: Capability providers are similarly trusted. A `crm` provider that returns incorrect data, logs template contents, or makes unauthorized API calls is not constrained by Seebo's security model.

**Template logic errors**: Seebo can catch structural and type errors, but it cannot verify that the template's business logic is correct. A template that generates a fraudulent invoice with correct syntax is syntactically valid and will pass all security checks.

**Side effects in extension functions**: The purity requirement is enforced by convention, not by a runtime sandbox. A `defineFunction` implementation that makes a network call will not be caught by the engine. The consequence is loss of idempotency guarantees, not a security violation — but it can cause duplicate actions.

**Host application vulnerabilities**: Seebo is a library. If the host application has SQL injection vulnerabilities, authentication bypasses, or other problems, Seebo cannot fix them.

---

## Conclusion

Seebo's security posture is built on a foundation of architectural choices that happen to be good for security: a pure core that cannot perform I/O, a non-Turing-complete language that cannot loop forever, explicit capability declarations that make data access auditable, and resource limits at every pipeline stage.

The prototype pollution protections in `sanitize.js`, `objectGet`, and `safeSet` address JavaScript-specific risks that arise whenever user-controlled data enters an object graph. The policy system provides fine-grained capability control. The audit and redact hooks provide observability without data exposure.

The result is an engine that can safely process templates from untrusted sources, with predictable, bounded resource consumption, and with all external data access explicitly declared and policy-controlled. This makes it suitable for production deployment in systems that handle sensitive operational data.

---

## Further Reading

- `src/runtime/sanitize.js` — prototype-pollution-safe JSON sanitization
- `src/util/limits.js` — all resource limit definitions and diagnostic codes
- `src/driver/async_driver.js` — policy enforcement, timeout handling, audit hook invocation
- `src/eval/evaluator.js` — `objectGet` implementation; `maxSteps` enforcement
- `docs/SECURITY.md` — the project's threat model document
- OWASP. (2021). *OWASP Top Ten*. — A10: Server-Side Request Forgery; A03: Injection
- Lekies, S., Kotowicz, K., & Johns, M. (2017). "Code-Reuse Attacks for the Web." — Prototype pollution attacks in depth
- Zalewski, M. (2011). *The Tangled Web: A Guide to Securing Modern Web Applications*. No Starch Press.
