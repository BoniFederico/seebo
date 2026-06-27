# Why Template Engines Are Not Enough: The Problem Space

## Table of Contents

1. [The Comfortable Assumption](#the-comfortable-assumption)
2. [What Simple Templating Does Well](#what-simple-templating-does-well)
3. [Where Simple Templating Breaks Down](#where-simple-templating-breaks-down)
4. [The Problem of Missing Inputs](#the-problem-of-missing-inputs)
5. [Why Requirements Should Be Explicit](#why-requirements-should-be-explicit)
6. [Why Side Effects Must Be Separated from Rendering](#why-side-effects-must-be-separated-from-rendering)
7. [Why Static Analysis Is Valuable](#why-static-analysis-is-valuable)
8. [Why a Pure Core Is Useful](#why-a-pure-core-is-useful)
9. [Three Concrete Examples](#three-concrete-examples)
   - [Example 1: HTTP Request Body with Conditional Fields](#example-1-http-request-body-with-conditional-fields)
   - [Example 2: Email Generation with CRM-Sourced Order Data](#example-2-email-generation-with-crm-sourced-order-data)
   - [Example 3: Configuration File with Environment-Specific Values](#example-3-configuration-file-with-environment-specific-values)
10. [How Existing Tools Handle These Problems](#how-existing-tools-handle-these-problems)
11. [The Gap Seebo Fills](#the-gap-seebo-fills)
12. [Conclusion](#conclusion)
13. [Further Reading](#further-reading)

---

## The Comfortable Assumption

Every template engine ever written makes a quiet assumption: that all the data needed to render the template is present before rendering begins.

This assumption is so deeply embedded in the design of these tools that most of them provide no language-level mechanism for expressing what happens when it is violated. The template is a function from context to string. You provide the context. You get the string. If the context is incomplete, you get an error, or a blank interpolation, or a crash.

For a significant fraction of real document-generation problems, this assumption does not hold. The data arrives in pieces, from different sources, over time, and often in an order that depends on what the data says.

This article examines precisely where the assumption breaks, why it breaks, and what a better model requires.

---

## What Simple Templating Does Well

It is worth being precise about what simple template engines do well, because the critique of their limitations should not obscure their genuine strengths.

JavaScript's template literals are excellent for short, inline string composition where all values are in scope:

```javascript
const greeting = `Hello, ${user.name}. Your order #${order.id} ships on ${order.shippingDate}.`;
```

This is readable, fast, and requires no framework. The JavaScript runtime interpolates the values directly.

Mustache and Handlebars are excellent for separating HTML from application logic. They accept a context object and a template string and produce a rendered string. The logic-less design of Mustache is a deliberate constraint that keeps templates readable by non-programmers.

Jinja2 (Python) and Liquid (Ruby) add more expressiveness — conditionals, loops, filters, template inheritance — while still keeping the mental model of a function from context to string.

All of these tools are good for what they do. The problem is not that they are bad at their intended use. The problem is that their intended use is narrower than the problem domain of document generation in real operational workflows.

---

## Where Simple Templating Breaks Down

Consider a common operational pattern: a business process generates a document — an order confirmation, a contract, a notification — that requires data from multiple sources. Some of that data is immediately available. Some must be fetched from a database. Some must be provided interactively by a user. Some depends on other data: you cannot look up the customer's loyalty tier until you know the customer's ID, and you cannot format the discount paragraph until you know the loyalty tier.

The breakdown of simple templating in this scenario is not a bug. It is a consequence of the fundamental design. When you write:

```jinja
{% if customer.tier == 'gold' %}
Your exclusive discount: {{ discount_rate }}%
{% endif %}
```

you are assuming that `customer.tier` and `discount_rate` are both present in the rendering context. If either is absent, Jinja2 renders an empty string for undefined variables (by default) or raises a `UndefinedError` depending on the environment. Either way, the rendering attempt has consumed an unknowable amount of computation before encountering the missing value, and the partial result — however much rendered before the failure — is discarded.

More fundamentally, the template has no way to communicate to the outside world what it needs. The caller of the template engine must know, from some external source of information (typically the code that constructs the context object), which fields are required. The template cannot tell you. There is no API to ask a Jinja2 template "what variables do you use, and which of them are required versus optional?" The only way to find out is to try to render it and observe what errors arise.

---

## The Problem of Missing Inputs

Let us make the problem concrete with numbers. Suppose you are building a system that generates personalized offer letters. The letter template references fifteen different pieces of information: the recipient's name, their account tier, the current date, four different numeric thresholds that vary by tier, a promotional code that depends on which campaign is running, and several formatting details pulled from the brand configuration.

Some of these values are present immediately (the current date, the brand configuration). Some must be fetched from a CRM (the recipient's name and account tier). Some are computed from the CRM data (the tier-specific thresholds). The promotional code depends on the campaign, which is determined at runtime.

With a conventional template engine, the workflow is:

1. Make all necessary database and API calls to assemble the complete context object.
2. Pass the context to the template engine.
3. Get the rendered letter.

This works, but it has a significant drawback: step 1 is monolithic. You must decide upfront, from knowledge about the template, which fields to fetch. If the template changes — someone adds a new section that requires a new field — the context-assembly code must also change. The template and the context assembly code are coupled through an informal interface: the set of variables the template uses.

The better model inverts this. Instead of the caller knowing what the template needs, the template declares what it needs. The caller's only job is to provide a mechanism to satisfy those declarations. This is what Seebo's `require` form does:

```
Dear ${ require({ id: 'recipient_name', type: { type: 'string' }, capability: 'crm' }) },

${ require({ id: 'account_tier', type: { type: 'string' }, capability: 'crm' }) == 'gold' ? 'Congratulations on your Gold membership.' : '' }
```

The template declares two requirements. The engine can enumerate them statically, before rendering begins. If the system already has the values, they are injected directly. If not, the engine suspends and emits the requirements as pending needs. The caller resolves them through the registered `crm` capability and feeds the values back. Rendering continues.

Critically, the `account_tier` requirement is used in a conditional. The text "Congratulations on your Gold membership." is only needed if `account_tier` is `'gold'`. This is significant: Seebo uses lazy evaluation for conditional branches, which means that requirements gated behind an unresolved condition are not emitted until the condition can be evaluated. The engine will not ask for a gold-specific value if the account is not gold.

---

## Why Requirements Should Be Explicit

There is an alternative design: infer requirements from undefined variables. Observe which names the template references, mark the ones not in the current context as needs, and let the system provide them.

This design is superficially simpler but has three problems in practice.

First, it conflates the name of a variable with the declaration of a requirement. A requirement has semantics beyond its name: it has a type, an optional flag, a label for display to a human user, a capability (which provider should satisfy it), and potentially constraints on the valid range of values. If requirements are inferred from undefined names, none of this metadata is expressible in the template.

Second, implicit inference makes static analysis significantly harder. To infer requirements, you need to know, for every name reference in the template, whether the name is locally defined or externally required. For names that are locally defined (through a `var` declaration or through the result of an expression), the inference system must determine this at parse time without executing the template. For names that are conditionally used, the system must handle the branching structure. This is solvable but complex.

Third, explicit requirements are better documentation. When you read a template and see `require({ id: 'order_total', type: { type: 'float' }, capability: 'orders', label: 'Order total amount' })`, you know immediately what external dependency exists, what type it has, where it comes from, and what it means. When you read `${ order_total }` and rely on implicit inference, you must consult the context-assembly code to understand where this value originates.

Seebo's design takes the position that explicit is better than implicit when the thing being declared is a contract with an external system.

---

## Why Side Effects Must Be Separated from Rendering

Template engines that execute arbitrary code during rendering — Jinja2's filter chains, Liquid's tag system, ERB's embedded Ruby — create a class of problem that is difficult to reason about: rendering has side effects.

When rendering a template modifies database state, sends emails, increments counters, or logs audit events, the rendering function is no longer a pure function. It becomes impure in the technical sense: calling it twice with the same input may produce different results or cause unwanted effects.

This matters for several reasons. First, it makes it impossible to validate a template by rendering it against sample data, because validation might trigger real side effects. Second, it makes it difficult to implement resumable evaluation: if a partial render has side effects, and rendering must be restarted from the beginning when a need is satisfied, those side effects will execute multiple times. Third, it makes the behavior of the template hard to test: tests must mock or suppress the side effects, which adds complexity.

Seebo's design eliminates this class of problem by decree: the pure core performs no I/O. The evaluator is a pure function. It can read from the resolved values map, perform computations, and emit needs, but it cannot write to anything external. All I/O happens in the driver layer, outside the core, and is clearly separated.

This means a Seebo template is safe to analyze, validate, and even partially execute against synthetic data without concern for side effects.

---

## Why Static Analysis Is Valuable

The `validate` function accepts a template and a config and returns an array of diagnostics. It does this without executing the template, without providing any capability providers, and without fetching any external data. It tells you, statically, whether the template is well-formed.

The diagnostics it produces include:
- References to undeclared names (`UNDECLARED_NAME`)
- Calls to unknown functions (`UNKNOWN_FUNCTION`)
- Uses of capabilities not registered in the config (`UNKNOWN_CAPABILITY`)
- Type errors provable from the declared types of requirements (`TYPE_ERROR`)
- Non-exhaustive `match` expressions with no default arm (`NON_EXHAUSTIVE_MATCH`)
- Policy violations: types or capabilities forbidden by the engine's policy rules

The `analyze` function goes further. It builds the requirement dependency graph — which requirements depend on which other requirements — and computes an execution plan: a sequence of phases, each listing which requirements become active in that phase. This information lets the caller know, before any capability has been invoked, how many round-trips to external systems the template will require in the worst case.

This is not academic. If you are building a UI that presents requirements to a human user one phase at a time (asking for name, then address, then tier-specific options in sequence), the execution plan tells you exactly how many screens the user will see and in what order.

---

## Why a Pure Core Is Useful

A pure synchronous core — a set of functions with no I/O, no global state, and deterministic output — has properties that impure code does not have.

The most immediate is testability. Testing a pure function requires no mocks, no stubs, no dependency injection, no setup and teardown. You call the function with an input, you observe the output, you check that they match. This is why Seebo's test suite for core functionality is straightforward: the lexer, parser, validator, analyzer, and evaluator can all be tested by constructing input directly and inspecting output directly.

The second property is isomorphism: the same pure core can run in a browser and in Node.js. The lexer and parser produce the same output regardless of environment. The evaluator produces the same result. This enables client-side validation and analysis of templates — you can provide editor integration that validates a template as the user types, using the same code that will validate it server-side.

The third property is serializability. Because the evaluator's state is a plain POJO with no closures or function references, it can be serialized to JSON, stored in a database, transmitted over a network, and deserialized later. The conversation between the engine and its capability providers can span multiple HTTP requests, multiple user turns, even restarts of the server process, because the state carries everything needed to resume from where it left off.

---

## Three Concrete Examples

### Example 1: HTTP Request Body with Conditional Fields

Suppose you are generating JSON request bodies for a third-party payment processing API. The API has a required `amount` field, an optional `currency` field that defaults to `USD`, and a conditional `tax_exempt_id` field that must be present if and only if the customer has tax-exempt status.

With a simple template literal:

```javascript
const body = JSON.stringify({
  amount: context.amount,
  currency: context.currency ?? 'USD',
  ...(context.taxExempt ? { tax_exempt_id: context.taxExemptId } : {}),
});
```

This works fine when all values are in scope. But now consider: how does the payment processing subsystem know which customer's data to fetch? If the template is invoked for a batch of customers, each customer object must be pre-fetched before the template can be filled. If the amount must be confirmed by a human before processing, the entire flow must wait for that confirmation before the template can be rendered.

With Seebo, the template expresses its own dependencies:

```
{
  "amount": ${ require({ id: 'payment_amount', type: { type: 'float' }, capability: 'user' }) },
  "currency": ${ require({ id: 'currency', type: { type: 'string' }, capability: 'config', optional: true }) ?? 'USD' },
  ${ require({ id: 'is_tax_exempt', type: { type: 'bool' }, capability: 'crm' }) ? '"tax_exempt_id": "' + require({ id: 'tax_exempt_id', type: { type: 'string' }, capability: 'crm' }) + '",' : @{ REMOVE_LINE } }
}
```

The engine will first ask for `payment_amount` (from the `user` capability, meaning a human must confirm it) and `currency` and `is_tax_exempt`. Once `is_tax_exempt` is known, it will either ask for `tax_exempt_id` (if true) or not (if false, and the `REMOVE_LINE` macro will clean up the empty line). The conditional need for `tax_exempt_id` is expressed directly in the template, and the static analyzer will detect this dependency and include it in the execution plan.

### Example 2: Email Generation with CRM-Sourced Order Data

Consider a template for generating an order confirmation email in `.eml` format. The email requires:
- The recipient's name and email address (from CRM)
- The order number and total (from the orders system)
- A custom message body supplied by the user (interactive)
- The current date (from the engine's clock)

With a conventional template engine, you would need to write a function that fetches the customer data, fetches the order data, waits for the user to supply the message body, and assembles the context object. This logic is written in the application layer, outside the template, and is tightly coupled to the template's structure.

With Seebo, the template declares its own dependency structure:

```
From: orders@example.com
To: ${ require({ id: 'recipient_email', type: { type: 'string' }, capability: 'crm' }) }
Subject: Order #${ require({ id: 'order_number', type: { type: 'string' }, capability: 'orders' }) } Confirmed
Date: ${ now() }

Dear ${ require({ id: 'recipient_name', type: { type: 'string' }, capability: 'crm' }) },

${ require({ id: 'message_body', type: { type: 'string' }, capability: 'user', label: 'Custom message' }) }

Your order total: ${ require({ id: 'order_total', type: { type: 'float' }, capability: 'orders' }) }

Thank you for your business.
```

The `analyze` call on this template would return an execution plan showing that `crm` and `orders` requirements (phase 1) can be satisfied in parallel, then `user` (phase 2) requires a human interaction, and the final render can proceed once all three phases complete. The caller does not need to understand the template's structure to drive this process correctly.

### Example 3: Configuration File with Environment-Specific Values

A deployment pipeline generates configuration files from templates. The template has a core structure that is identical across all environments, but certain values — database hosts, API keys, feature flags — differ by environment. Some of those values are in a secrets management system that requires authentication. Some are in a configuration database that must be queried by environment name. Some can be set directly from environment variables at the time of generation.

```
[database]
host = ${ require({ id: 'db_host', type: { type: 'string' }, capability: 'secrets' }) }
port = ${ require({ id: 'db_port', type: { type: 'int' }, capability: 'config', optional: true }) ?? 5432 }
name = ${ require({ id: 'db_name', type: { type: 'string' }, capability: 'config' }) }

[features]
new_ui_enabled = ${ require({ id: 'feature_new_ui', type: { type: 'bool' }, capability: 'flags' }) }
${ require({ id: 'feature_new_ui', type: { type: 'bool' }, capability: 'flags' }) ? '[new_ui]\ntheme = ${ require({ id: \'ui_theme\', type: { type: \'string\' }, capability: \'config\' }) }' : @{ REMOVE_LINE } }
```

The template can be validated statically against the registered capabilities before deployment begins. The execution plan tells the CI system in advance how many capability invocations the template requires. If a capability is unavailable (say, the secrets management system is down), the failure is isolated: the engine emits a `CAPABILITY_ERROR` diagnostic with the capability name, and the caller can decide how to proceed without the template engine needing to know anything about retry logic or fallback strategies.

---

## How Existing Tools Handle These Problems

None of the scenarios above are impossible to implement with existing tools. The point is not that they cannot be done, but that they must be done by the application code surrounding the template engine rather than by the template engine itself. The template is not the right place to express dependency structure in these tools, so the dependency structure lives in code that is harder to inspect, harder to test independently, and harder to change without coordinating multiple files.

**Mustache** has no expression language at all. Every dynamic value is a lookup in the context object. Missing values produce empty strings. The only way to express conditional inclusion is through section tags, which check for truthy values. There is no type system, no capability model, no static analysis.

**Handlebars** adds helpers (custom functions callable from templates) and block helpers (custom control structures). This is more expressive, but helpers can have side effects, and their behavior is opaque to any static analysis tool. The context must still be fully assembled before rendering.

**Jinja2** has a rich expression language including filters, macros, template inheritance, and custom extensions. Its static analysis story is limited: Jinja2 can parse a template and enumerate the variables it uses through the `Environment.parse` API, but this is not type-aware and does not capture the conditional dependency structure.

**Liquid** is more constrained than Jinja2 by design. It is intended for use in untrusted contexts (it was developed for Shopify themes) and deliberately limits what can be expressed. The constraint is a security feature but also limits what the engine can do.

**JSON Schema form builders** (React JSON Schema Form, and similar) solve a related but different problem: they render UI forms from a schema and collect data. They understand data shapes and validation, but their output is a form, not a document, and they have no template language.

None of these tools has a mechanism for expressing that a requirement is conditionally active (only needed if another value satisfies some condition), for building an execution plan from the dependency structure, or for suspending and resuming document generation across multiple turns.

---

## The Gap Seebo Fills

Seebo occupies the intersection of three properties that no existing tool combines: it is typed (values carry explicit types with constraints and format metadata), it is suspendable (evaluation pauses on missing data and resumes when the data arrives), and it is statically analyzable (the dependency structure of a template can be computed from the template source without executing it).

These three properties together enable a class of application that is difficult to build otherwise. You can write a template that describes a multi-turn interaction — asking a user for information in a structured sequence determined by conditional dependencies between requirements — and the engine handles the execution mechanics. Your application code provides capability implementations, not orchestration logic.

You can validate a template against your registered capabilities before deploying it, catching missing capability registrations, type mismatches, and policy violations at development time. You can analyze the execution plan and display it to developers as documentation of the template's requirements. You can store the state between turns, reload it later, and resume from exactly where the conversation left off.

The engine is also designed to be safe for untrusted templates. The resource limits prevent any template from consuming unbounded memory or execution time. The capability policy rules prevent untrusted templates from accessing capabilities they have not been granted. The separation of the pure core from the driver means that the pure core can execute in restricted environments without access to file systems or networks.

The next article begins the technical part of the series by examining the design of the Seebo template language: the constructs it provides, the trade-offs in each design decision, and the principles that guided those decisions.

---

## Conclusion

The comfortable assumption underlying all conventional template engines — that all data is present before rendering begins — is violated by a large class of real document-generation problems. The violation is not exotic: it occurs every time a document's content depends on data from multiple sources, arrives in a specific order, or requires human input at intermediate steps.

The appropriate response is not to work around the limitation in application code. It is to design an engine that makes explicit data dependency a first-class concept, that can suspend evaluation when a dependency is unmet and resume when it is satisfied, and that can analyze the dependency structure of a template without executing it.

Seebo is an attempt to build that engine. The rest of this series explains how.

---

## Further Reading

- Fowler, M. (2003). *Patterns of Enterprise Application Architecture.* Addison-Wesley. Chapter on "Template View." — A catalog-level discussion of template-based rendering in enterprise contexts.
- Mustache specification: https://mustache.github.io/mustache.5.html — The formal specification of the Mustache template language; useful context for understanding what "logic-less" means and costs.
- Jinja2 documentation, "Template Designer Documentation": https://jinja.palletsprojects.com/en/3.x/templates/ — A good reference for the state of the art in Python template engines.
- Hutton, G. (2016). *Programming in Haskell* (2nd ed.). Cambridge University Press. — The chapter on parsing introduces monadic parser combinators, a functional alternative to the imperative recursive descent approach used in Seebo.
