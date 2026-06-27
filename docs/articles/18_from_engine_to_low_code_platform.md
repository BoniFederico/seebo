# From Engine to Platform: How Static Analysis Enables Low-Code Tools

## Table of Contents

1. [The Key Insight: A Self-Describing Engine](#1-the-key-insight-a-self-describing-engine)
2. [How analyze() Output Maps to UI Components](#2-how-analyze-output-maps-to-ui-components)
3. [Template Hub: Governed, Pre-Analyzed Templates](#3-template-hub-governed-pre-analyzed-templates)
4. [Form Generation from Requirements](#4-form-generation-from-requirements)
5. [Multi-Phase Guided Forms](#5-multi-phase-guided-forms)
6. [The Workflow Runner](#6-the-workflow-runner)
7. [Use Case Walkthroughs](#7-use-case-walkthroughs)
8. [Connectors: Capabilities as Integration Points](#8-connectors-capabilities-as-integration-points)
9. [Governance, Approvals, and Audit](#9-governance-approvals-and-audit)
10. [Action Plans: Future Work](#10-action-plans-future-work)
11. [Conclusion](#conclusion)
12. [Further Reading](#further-reading)

---

## 1. The Key Insight: A Self-Describing Engine

Most template engines are opaque renderers. You give them a string and a data blob; they give you another string. The internal structure of the template — what data it needs, in what order, under what conditions — is invisible to the caller. The caller must read the template source to understand it, and even then, the understanding is informal: it requires human interpretation, not machine processing.

Seebo is different in a fundamental way: it can **analyze itself**. The `analyze()` function takes a template string and returns a machine-readable description of everything the template needs to run, how those needs are ordered, which external systems they require, and whether the output is deterministic. This description is the `Analysis` object, and it is as much a part of Seebo's public API as `run()` or `stebo()`.

The implication is profound for platform builders. If your engine can tell you what data a template needs, you can generate a UI to collect that data. If it can tell you the order in which data becomes available, you can generate a multi-step wizard. If it can tell you which external systems are involved, you can show an integration checklist. The template becomes a declarative specification that the platform interprets, not just a string that the engine renders.

This is not a coincidence of design. Seebo's `require()` construct is explicitly typed, labeled, described, and annotated with constraint information. A requirement like:

```
require({
  id: 'customer_name',
  type: string().constraints({ minLen: 1, maxLen: 100 }),
  capability: 'user',
  label: 'Customer name',
  description: 'Enter the full name of the customer',
  optional: false
})
```

is not just a request for a value. It is a form field specification. The type builder chain is a field descriptor. The `label` is the field label. The `description` is the tooltip text. The `constraints` determine validation rules. All of this comes from the template author, not from the platform code.

---

## 2. How analyze() Output Maps to UI Components

The `Analysis` object returned by `analyze()` has a direct correspondence to UI components in a low-code platform.

### requirements[] → form fields

Each requirement in `analysis.requirements` is a potential form field. The type descriptor embedded in each requirement provides everything needed to render and validate that field:

- `type.type` — the base type: `string`, `int`, `float`, `bool`, `datetime`, `array`
- `type.constraints` — validation rules: `minLen`, `maxLen`, `min`, `max`, `values` (enum)
- `type.format` — display options: decimal separator, date pattern, boolean labels
- `type.default` — pre-fill value
- `label` — form field label
- `description` — help text or tooltip
- `optional` — whether the field can be left empty
- `capability` — which provider supplies the data (which connector this field belongs to)
- `options` (from `analyze()`) — the allowed values for enum requirements

The `options` field deserves special mention. When a requirement's type has `constraints.values: ['A', 'B', 'C']`, the analyzer extracts this into the enriched requirement descriptor so that the UI layer receives it as `options: ['A', 'B', 'C']` without having to parse the constraint structure itself.

### executionPlan → wizard steps

The execution plan is an ordered list of phases, each containing the requirement IDs that become active in that phase. This maps directly to wizard steps in a multi-step UI:

```js
// analysis.executionPlan might look like:
[
  { phase: 1, requirements: ['country'] },
  { phase: 2, requirements: ['city'] },  // city is only asked if country == 'IT'
]
```

A platform that builds a wizard from this plan shows step 1 with the `country` field, waits for the user to answer, then conditionally shows step 2 with the `city` field. The platform does not need to know about the conditional logic in the template — the engine's analysis has already computed which questions appear in which order.

### capabilitiesUsed → integration checklist

`analysis.capabilitiesUsed` is an array of capability names used by the template. In a platform context, each capability name corresponds to a connector: `crm` maps to the CRM integration, `email` maps to the email service, `jira` maps to the ticketing system. Before a template can be executed, all its required connectors must be configured and available. The `capabilitiesUsed` array is the checklist.

A platform could display: "This template requires: CRM connector, Email connector. Please ensure both are configured before running." This information is static — computed from the template structure alone, before any execution.

### deterministic → preview behavior

`analysis.deterministic` is `false` when the template uses `now()` or other non-deterministic producers. A platform rendering a preview of the template output can use this flag to decide whether to show a "preview may change at execution time" warning. A deterministic template's preview is stable; a non-deterministic one may produce different output when actually executed.

---

## 3. Template Hub: Governed, Pre-Analyzed Templates

A template hub is a library of pre-authored templates. In a Seebo-based platform, each template in the hub is a validated, pre-analyzed artifact:

**Validation on save**: when a template author saves a template, `validate()` runs automatically. If there are diagnostics, the author sees them immediately — undeclared names, unknown capabilities, non-exhaustive matches. A template with errors cannot be published to the hub.

**Pre-computed analysis**: when a template is published, `analyze()` runs and the `Analysis` object is stored alongside the template. This means that when a user selects a template from the hub, the platform immediately has the form fields, execution plan, capabilities used, and determinism flag — without running the analysis at request time.

**Versioning and governance**: the `analysisVersion` field in the `Analysis` object allows the hub to detect when a stored analysis was produced by an older engine version. When the engine is upgraded, the hub can re-analyze templates that have a stale `analysisVersion` value. This is the mechanism by which the hub stays consistent with the engine.

**Template metadata**: beyond the analysis, templates carry metadata: name, description, category, tags, author, creation date, last modified date. This metadata supports search, filtering, and organization in the hub UI. The template body is the ground truth; the metadata is editorial.

---

## 4. Form Generation from Requirements

The mapping from requirements to form fields is concrete and mechanical. Consider a template for generating a sales email:

```
Dear ${ require({
  id: 'salutation',
  type: string().constraints({ values: ['Mr.', 'Ms.', 'Dr.', 'Prof.'] }),
  capability: 'user',
  label: 'Salutation',
  optional: false
}) } ${ require({
  id: 'customer_name',
  type: string().constraints({ minLen: 1, maxLen: 100 }),
  capability: 'user',
  label: 'Customer name',
  optional: false
}) },

We are pleased to offer you a discount of ${ require({
  id: 'discount_pct',
  type: int().constraints({ min: 1, max: 50 }),
  capability: 'user',
  label: 'Discount percentage',
  optional: false
}) }% on your next order...
```

The `analyze()` result for this template would include three requirements. The platform generates the form:

- **Salutation**: a select/radio with options `['Mr.', 'Ms.', 'Dr.', 'Prof.']` — because `constraints.values` is present, this is an enumeration field.
- **Customer name**: a text input with `minLength: 1`, `maxLength: 100`.
- **Discount percentage**: a number input with `min: 1`, `max: 50`, integer only.

This form was not hand-written. It was generated directly from the template's requirement declarations. When the template changes — perhaps a new salutation option is added, or the maximum discount is changed — the form regenerates automatically on next analysis. The template is the single source of truth.

The type builder chain `string().constraints({ values: ['Mr.', 'Ms.', 'Dr.', 'Prof.'] })` is not just validation — it is a field descriptor. The type builds a `TypeDescriptor` object that the platform can read:

```js
{
  type: 'string',
  constraints: { values: ['Mr.', 'Ms.', 'Dr.', 'Prof.'] },
  format: {},
}
```

The platform's form renderer inspects `constraints.values` and selects the appropriate input widget. This is the dual-semantics type builder pattern: the same expression that describes a requirement's type also describes the UI widget to use for collecting it.

---

## 5. Multi-Phase Guided Forms

The most powerful consequence of `executionPlan` is multi-phase guided forms — wizard-style UIs where later questions depend on earlier answers.

Consider a template for a shipping label that asks for a destination country, and then conditionally asks for a state (for the US) or a province (for Canada):

```
Country: ${ require({id:'country', type:string(), capability:'user', label:'Country'}) }
${ country == 'US'
  ? 'State: ' + require({id:'state', type:string(), capability:'user', label:'State'})
  : country == 'CA'
    ? 'Province: ' + require({id:'province', type:string(), capability:'user', label:'Province'})
    : '' }
```

The `analysis.executionPlan` for this template would be:

```js
[
  { phase: 1, requirements: ['country'] },
  { phase: 2, requirements: ['state', 'province'] },
]
```

Phase 1 contains `country` because it has no dependencies. Phase 2 contains both `state` and `province` because both are gated behind conditions that reference `country`. However, at runtime only one of them will become active depending on the value of `country`.

The platform wizard works as follows:

1. Show step 1 with the `country` field. Wait for the user's input.
2. Call `engine.run(engine.start(template, { country: 'US' }))`.
3. The engine returns `status: 'waiting'` with `pending: [{ id: 'state', ... }]` — only `state` is pending, not `province`, because `province` is in the non-taken branch.
4. Show step 2 with the `state` field (since `country == 'US'`). Wait for the user's input.
5. Call `engine.run({ ...state, resolved: { country: 'US', state: 'CA' } })`.
6. The engine returns `status: 'completed'` with the rendered label.

The platform never reads the conditional logic in the template. It relies entirely on the engine's suspension behavior to determine which fields to show. The lazy evaluation model — where requirements in non-taken branches are never emitted — is what makes this possible. The template author writes the condition once; the platform correctly implements the wizard without any additional configuration.

---

## 6. The Workflow Runner

The workflow runner is the platform component that orchestrates the multi-phase execution loop from a user perspective.

The runner's life cycle for a given template execution is:

1. **Template selection**: the user selects a template from the hub. The pre-computed `Analysis` is retrieved.
2. **Connector check**: the platform checks that all capabilities in `capabilitiesUsed` have configured providers. Missing providers are flagged before execution begins.
3. **Phase 1 execution**: the platform calls `engine.stebo()` with `stopOn: ['user']`. This runs until all non-user capabilities are satisfied (CRM lookups, API calls, system values) and pauses when user-input requirements are encountered.
4. **User input**: the platform displays the form fields for the current phase's pending requirements. The user fills them in.
5. **Continuation**: the platform calls `engine.drive(state, { stopOn: ['user'] })` with the user's values merged into `resolved`. This resolves the next batch of non-user needs and pauses again at the next user-input requirement.
6. **Completion**: when `state.status === 'completed'`, the platform delivers the rendered output.

The `stopOn` parameter is the key mechanism that separates automatic capability resolution from user interaction. The driver resolves everything it can — CRM lookups, system timestamps, calculated values — and yields control to the platform at the user-input boundary. The platform shows exactly the fields that are currently needed, no more and no less.

This model can be extended to other "human in the loop" patterns: approval gates, review steps, signature requests. Each would be implemented as a capability with a recognizable name (e.g., `approval`, `signature`) that the runner places in `stopOn`, pausing the workflow for human intervention.

---

## 7. Use Case Walkthroughs

### Use case 1: CRM-integrated email generation

An inside sales team needs to send personalized emails to customers. The template includes the customer's name (from CRM), their recent order details (from CRM), and a personalized note typed by the sales rep.

```
Template: emails/customer_followup.seebo
Capabilities used: crm, user
Execution plan:
  Phase 1: customer_id (user)
  Phase 2: customer_name (crm), order_total (crm), notes (user)
```

The workflow:
1. Runner shows step 1: "Enter customer ID."
2. User types the customer ID.
3. Driver resolves `crm` for `customer_name` and `order_total` using the customer ID. These arrive automatically.
4. Runner shows step 2: "Notes (optional)." The CRM values are already resolved and will not be asked about.
5. User types the personalized note. Output is delivered as a ready-to-send `.eml` file.

The CRM lookup happens automatically in the driver loop, invisible to the user. The user only sees the fields that require human input.

### Use case 2: API body generation

A backend developer needs to test an API endpoint. A template describes the request body with typed fields and optionally fetches an authentication token.

```
Template: api_tests/create_order.seebo
Capabilities used: auth_token, user
Execution plan:
  Phase 1: product_id, quantity, shipping_address (user)
  Phase 2: auth_token (auth_token) — resolved automatically after phase 1 fields are known
```

The form shows three fields to the developer. The auth token is fetched by a capability provider and injected into the request body automatically. The developer never types an auth token.

### Use case 3: JIRA ticket automation

An operations team needs to create JIRA tickets for customer-reported issues. The template includes a ticket title, description, and priority.

```
Template: ops/bug_ticket.seebo
Capabilities used: crm, jira_metadata, user
Execution plan:
  Phase 1: customer_id (user)
  Phase 2: customer_tier (crm), assignee (jira_metadata), title, description, priority (user)
```

The `customer_tier` from CRM determines whether the priority field appears at all (enterprise customers get a mandatory priority field; others do not). The `jira_metadata` capability pre-fills the `assignee` field with the on-call engineer from the ticketing system's rotation.

### Use case 4: Runbook generation

A site reliability engineer needs to generate runbooks for operational procedures. A template includes steps with live system values: current cluster size, active incident ID, estimated recovery time.

```
Template: runbooks/scale_out.seebo
Capabilities used: prometheus, pagerduty, user
Execution plan:
  Phase 1: current_replicas (prometheus), incident_id (pagerduty)
  Phase 2: target_replicas (user)
```

The runbook template automatically fetches live metrics and incident data in phase 1, then asks the engineer for the target replica count in phase 2. The output is a complete runbook with all the live context embedded, ready to be shared with the team.

### Use case 5: Case workspace

A customer support agent handles incoming cases using a guided workspace. Each case type is a template that collects different information and generates different output.

```
Template: support/refund_request.seebo
Capabilities used: crm, order_system, user
```

The workspace shows the agent a form that pulls customer data from CRM, order details from the order system, and asks the agent for the refund reason and amount. The output is a structured case record that is submitted to the refund processing queue.

The low-code aspect is that the support operations team can modify the template — add a new field, change the output format, adjust which CRM fields are included — without involving the development team. The platform re-analyzes the template on save and regenerates the workspace UI automatically.

---

## 8. Connectors: Capabilities as Integration Points

In the Seebo architecture, every external data source is a capability. In the platform context, capabilities are connectors: each capability name corresponds to an integration with an external system.

The mapping is direct:
- `crm` → Salesforce, HubSpot, or whatever CRM the company uses
- `email` → SendGrid, SES, or an internal email service
- `jira` → Jira, Linear, or another ticketing system
- `prometheus` → Prometheus metrics, or any time-series database
- `pagerduty` → PagerDuty, OpsGenie, or another on-call system
- `user` → the interactive input capability (always handled by the platform's UI layer)

A platform connector is a capability provider function that knows how to call the external system and return a typed value. The template declares which connectors it uses (`capabilitiesUsed`), and the platform checks that all connectors are configured before allowing the template to run.

The connector abstraction decouples templates from specific integrations. A template that uses the `crm` capability works with any CRM that has a `crm` connector registered. If the company switches CRM vendors, only the connector changes, not the templates. This is the same principle as dependency injection, applied to data sources.

---

## 9. Governance, Approvals, and Audit

As a platform scales, template governance becomes important. Who can create templates? Who can publish them? Who can run high-impact templates that trigger emails or modify customer records?

Seebo's policy system provides the primitives:

**Capability-based access control**: `allowedCapabilities` and `capabilityRules` with trust levels allow the platform to restrict which capabilities a template can use based on its trust level. A template authored by an external contractor might be limited to read-only capabilities. A template authored by the security team might have access to all capabilities.

**Audit trail**: the `audit` hook records every capability invocation. A platform can build an immutable audit log of all template executions: which template ran, when, who initiated it, which capabilities were invoked, and what outcomes were produced. This audit trail is useful for compliance, debugging, and change tracking.

**Approval workflows**: high-impact templates — those that send emails, modify records, or trigger financial transactions — can be placed in a review queue before publication. The platform uses `capabilitiesUsed` to identify which templates need review (any template using `email_sender` or `payment_processor` requires approval). The approval workflow is a platform feature, not an engine feature.

**Version control**: templates can be stored in version control with the same tooling as code. Each version is an immutable artifact. Rollback means deploying a previous version. The `analysisVersion` ensures that the stored analysis matches the engine version that produced it.

---

## 10. Action Plans: Future Work

The current Seebo model is entirely declarative: templates describe what data is needed, and the engine renders an output string. A natural extension is **action descriptors** — templates that describe not just what to render but what to do with the output.

Consider the email generation use case. Currently, the template renders the email body, and the platform separately calls the email service to send it. An action descriptor would allow the template to declare the send action explicitly:

```
action({
  kind: 'email.send',
  to: require({id:'recipient', type:string(), capability:'user'}),
  subject: require({id:'subject', type:string(), capability:'user'}),
  body: '«the rendered output»'
})
```

This is "require() in the opposite direction" — instead of declaring what the template needs (input), an action declares what the template produces (output). The execution plan would include action descriptors alongside requirement descriptors, and the driver would execute the actions in the correct order.

Action descriptors would enable:
- **Approval gates**: an action that requires a human signature before proceeding
- **Idempotency**: the driver can check whether an action has already been executed before re-executing it on retry
- **Rollback**: if a later step in the execution fails, earlier actions can be undone (for reversible actions)
- **Audit trail**: every action execution is logged with the same audit mechanism as capability invocations

This is a significant extension to the engine model — it moves Seebo from a document renderer toward a workflow orchestrator — and it is not part of v1. But the architecture is designed to accommodate it: the three-way `Ok | Susp | Err` result type could be extended with an `Action` case, and the driver loop already has the structure needed to process phases sequentially.

---

## Conclusion

The gap between "a template engine" and "a low-code platform" is narrower than it appears when the engine is designed with analysis in mind. Seebo's `analyze()` function transforms the template from a string into a machine-readable description of exactly what is needed to render it. That description maps directly to UI components: form fields, wizard steps, integration checklists, preview warnings.

The key architectural decisions that enable this are: typed requirements with declared constraints and labels, lazy evaluation that naturally partitions requirements into phases, capability names that map to connectors, and the `Analysis` structure that exposes all of this to the platform layer. None of these are afterthoughts; they are the reason `require()` has the signature it has.

The workflow runner, template hub, multi-phase forms, and governance features are all consequences of these decisions. The platform emerges naturally from the engine's design. This is the mark of a well-designed abstraction: the pieces compose cleanly without glue code, because the underlying model is coherent.

---

## Further Reading

- `src/analyze/analyze.js` — the full `Analysis` shape and how it is computed
- `src/driver/async_driver.js` — the `stebo()` pipeline and `stopOn` mechanism
- `src/eval/evaluator.js` — lazy evaluation and the three-way result
- `src/runtime/values.js` — the `TypeBuilder` and `TypeDescriptor` dual semantics
- SPEC §2.3 — the normative `analyze()` contract
- SPEC §2.5 — the `stebo()` pipeline specification
- IMPL §9 — the requirement graph, execution plan, and phase computation
