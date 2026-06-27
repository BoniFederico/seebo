# From Engine to Platform: How Static Analysis Enables Low-Code Tools

## Table of Contents

1. [The Key Insight: Self-Describing Templates](#the-key-insight)
2. [How analyze() Output Maps to UI Components](#how-analyze-maps-to-ui)
3. [Template Hub: A Governed Library](#template-hub)
4. [Form Generation from Requirements](#form-generation-from-requirements)
5. [Multi-Phase Guided Forms (Wizard)](#multi-phase-guided-forms)
6. [The Workflow Runner](#the-workflow-runner)
7. [Use Case Walkthroughs](#use-case-walkthroughs)
   - [CRM-Integrated Email Generation](#crm-integrated-email)
   - [API Body Generation](#api-body-generation)
   - [Ticket Automation](#ticket-automation)
   - [Runbook Generation](#runbook-generation)
   - [Case Workspace](#case-workspace)
8. [Connectors as Capability Abstractions](#connectors-as-capability-abstractions)
9. [Governance, Approvals, and Audit](#governance-approvals-and-audit)
10. [Action Descriptors: Future Work](#action-descriptors-future-work)
11. [Why This Is Technical, Not Marketing](#why-this-is-technical)
12. [Conclusion](#conclusion)
13. [Further Reading](#further-reading)

---

## The Key Insight: Self-Describing Templates

A conventional template engine renders: it takes a template and a data object, produces a string. The template is opaque to the system around it. The only way to know what data a template needs is to read it. The only way to know what it produces is to render it.

Seebo is different in a precise technical sense: because `analyze()` can describe a template's external dependencies, type constraints, conditional structure, and execution phases without running it, the template is **self-describing**. The engine can answer questions about the template without access to any data.

"What user input does this template require?" → `analysis.requirements.filter(r => r.capability === 'user')`

"What external systems does this template call?" → `analysis.capabilitiesUsed`

"How many interaction turns will this template need?" → `analysis.maxPhases`

"Can I stream the beginning of the output before I have all the data?" → `analysis.streamability`

"Does this template's output change based on the current time?" → `!analysis.deterministic`

These questions can be answered at template load time, before any user interaction, before any capability is called, before a single expression is evaluated. This is what makes it possible to build a UI system on top of the engine: the UI can be generated from the template's metadata, not from manual configuration.

---

## How analyze() Output Maps to UI Components

The correspondence between the `Analysis` object and UI elements is precise and mechanical. It is not a convention — it is derived from the type system.

### requirements[] → Form Fields

Each `RequirementDescriptor` in `requirements` with `capability === 'user'` corresponds to a form field that the user must fill in. The type builder on the requirement IS the form field specification:

| Type Builder | Form Field Type | Validation |
|---|---|---|
| `string().constraints({ minLen: 1, maxLen: 255 })` | Text input | Required, max 255 chars |
| `int().constraints({ min: 0, max: 100 })` | Number input | Integer, 0–100 |
| `float().constraints({ precision: 2 })` | Number input | Decimal, 2 places |
| `bool()` | Checkbox or toggle | — |
| `array().constraints({ values: ['A', 'B', 'C'] })` | Select or radio group | Must be one of A, B, C |
| `datetime().constraints({ precision: 'day' })` | Date picker | Date only (no time) |
| `string()` with `optional: true` | Text input | Not required |

The `label` field on each requirement is the form field's display label. The `resolverHints` can carry additional UI metadata (placeholder text, help text, validation error messages).

This is not an approximation: the type builder is both the schema for validation (used by the driver when a capability provides a value) and the schema for UI rendering. There is one source of truth, and it lives in the template.

### executionPlan → Wizard Steps

The execution plan from `analysis.executionPlan` maps directly to wizard steps:

```js
// executionPlan:
[
  { phase: 1, requirements: ['country'] },
  { phase: 2, requirements: ['city'] }  // only needed if country == 'IT'
]

// Maps to:
// Step 1: show "Country" field
// Step 2: show "City" field (only reached after country is provided)
```

The UI wizard renders one step per phase. The number of steps is known statically from `maxPhases`. This means the wizard can show a progress indicator ("Step 2 of 3") without running the template.

Note that phase 2 may or may not be reached depending on runtime values. The wizard shows "Step 2 of max 2" — it acknowledges that some steps may be skipped. This is the correct behavior: the static analysis gives an upper bound, not a fixed count.

### capabilitiesUsed → Integration Checklist

When a new template is added to the system, `capabilitiesUsed` tells the operator which integrations must be configured for the template to work:

```js
// capabilitiesUsed: ['user', 'crm', 'secrets']
// → Before this template can be deployed:
//    ✓ user interaction capability (built into all instances)
//    ✓ CRM integration (check configuration)
//    ✓ Secrets vault integration (check configuration)
```

### deterministic → Preview Warning

If `!analysis.deterministic` (i.e., the template uses `now()`), the UI should warn: "This template's output changes based on current time. The preview shown here may differ from the final rendered output."

For testing and QA, the engine can be configured with a fixed clock:

```js
const previewEngine = createEngine({
  ...config,
  clock: () => new Date('2026-06-27T12:00:00Z')
});
```

This makes the preview deterministic for comparison purposes.

---

## Template Hub: A Governed Library

A template hub is a repository of pre-authored templates with metadata, governance, and version control. It is the operational layer above the engine.

At the point where a template is saved to the hub, the system runs `validate()` and `analyze()`:

- **Validation**: Reject templates with errors. A template that references an unknown capability or has a type error cannot be saved.
- **Analysis**: Store the `Analysis` object alongside the template. The analysis metadata is pre-computed and available without re-analyzing on every use.

The stored analysis metadata enables:

- **Browse by capability**: "Show me all templates that use the CRM integration."
- **Browse by phase count**: "Show me all templates that require only one interaction turn."
- **Impact analysis**: "Which templates will be affected if I change the 'crm' capability interface?"
- **Dependency visualization**: A graph of which templates absorb which other templates.

The hub can also enforce governance:

- Templates require review before being activated for production use.
- Changes to production templates require a new version, not an in-place edit.
- Template authors and approvers are tracked.
- Every change is logged with who made it and when.

---

## Form Generation from Requirements

Form generation is the most direct application of the requirement-to-UI mapping. Given `analysis.requirements`, a form generator renders the appropriate input widget for each user-facing requirement.

A minimal form generator:

```js
function generateForm(requirements) {
  return requirements
    .filter(r => r.capability === 'user')
    .map(req => ({
      id: req.id,
      label: req.label,
      required: !req.optional,
      field: typeBuilderToField(req.type)
    }));
}

function typeBuilderToField(typeBuilder) {
  if (typeBuilder.name === 'string') {
    return {
      type: 'text',
      minLength: typeBuilder.constraints?.minLen,
      maxLength: typeBuilder.constraints?.maxLen
    };
  }
  if (typeBuilder.name === 'array' && typeBuilder.constraints?.values) {
    return {
      type: 'select',
      options: typeBuilder.constraints.values
    };
  }
  if (typeBuilder.name === 'int' || typeBuilder.name === 'float') {
    return {
      type: 'number',
      min: typeBuilder.constraints?.min,
      max: typeBuilder.constraints?.max,
      step: typeBuilder.name === 'int' ? 1 : (1 / Math.pow(10, typeBuilder.constraints?.precision ?? 2))
    };
  }
  if (typeBuilder.name === 'datetime') {
    return {
      type: typeBuilder.constraints?.precision === 'day' ? 'date' : 'datetime-local'
    };
  }
  return { type: 'text' };  // default fallback
}
```

This is not hypothetical. The type builder on each `RequirementDescriptor` was designed to be machine-readable precisely so that form generators could be written against it.

The form generator knows nothing about the template's content. It reads only the requirements and produces UI field specifications. The same form generator works for any template.

---

## Multi-Phase Guided Forms (Wizard)

The execution plan turns a form into a wizard: a multi-step form where each step corresponds to one phase of the execution plan. The wizard is driven by the engine:

```
Step 1:
  - Render form fields for phase 1 requirements
  - User fills fields and submits
  - Call engine.stebo({ template, values: step1Values, stopOn: ['user'] })
  - Engine resolves automatic capabilities (crm, secrets)
  - Engine suspends on remaining user requirements (phase 2, if any)
  
Step 2 (if pending needs remain):
  - Render form fields for the returned pending needs
  - User fills fields and submits
  - Call engine.stebo({ template, values: allValues, stopOn: [] })
  - Engine completes → output delivered
```

This is the same conversation loop described in the state machine article, now expressed in terms of UI steps. The engine doesn't know about the UI; the UI doesn't know about the engine's internal logic. They communicate through the public API: `stebo()` returns a state with `pending` needs, and the UI converts those needs to form fields.

The wizard's "back" button corresponds to removing values from the `resolved` map and re-running — which is safe because the evaluator is idempotent and the state is serializable.

The wizard's "save draft" corresponds to storing the current state (a JSON-serializable POJO) in a database. The user can resume later from the same page they left off.

---

## The Workflow Runner

The workflow runner is the server-side component that orchestrates complete template execution. It wraps `engine.stebo()` with:

- **State persistence**: After each interaction turn, the state is stored.
- **User session management**: The pending needs are associated with a user session.
- **Capability resolution**: The runner pre-configures the engine with the appropriate capability providers for the current context (user, tenant, environment).
- **Output delivery**: After completion, the output is delivered to the appropriate destination (email provider, ticketing system, document store).
- **Audit logging**: Every capability invocation is logged, with the user ID, template ID, and timestamp.

The runner interacts with the engine through the same `stebo()` API that any application uses. It adds orchestration around that API, not complexity inside it.

---

## Use Case Walkthroughs

### CRM-Integrated Email Generation

**Scenario**: A customer support agent wants to send an order confirmation email. The email body is templated; some content comes from the CRM (order data), some from the agent (personal note), and some is static (company footer).

**Template structure**:
```
From: ${ secrets({ id: 'sender', type: string() }) }
Subject: Order ${ crm({ id: 'order', type: object() }).id } confirmed

Dear ${ require({ id: 'saluto', type: array().constraints({ values: ['Gentile', 'Caro'] }), capability: 'user', label: 'Greeting' }) } customer,

Your order #${ crm({ id: 'order', type: object() }).id } placed on ${ datetime(crm({ id: 'order', type: object() }).date) } has been confirmed.
Total: ${ float(crm({ id: 'order', type: object() }).total).constraints({ precision: 2 }) } €

${ require({ id: 'note', type: string(), capability: 'user', label: 'Personal note', optional: true }) != '' ? require({ id: 'note', ... }) : '@{REMOVE_LINE}' }

@{ABSORB('company_footer')}
```

**Analysis output**:
- `requirements`: [saluto (user, required), note (user, optional)]
- `capabilitiesUsed`: ['secrets', 'crm', 'user']
- `maxPhases`: 1 (no conditional dependencies between user requirements)
- `executionPlan`: [{phase:1, requirements:['saluto','note']}]

**Workflow**:
1. Agent opens the email template tool. The form generator shows two fields: "Greeting" (select: Gentile/Caro) and "Personal note" (optional text).
2. Agent fills the form and submits.
3. `stebo()` runs: `secrets` provider auto-populates sender email; `crm` provider fetches order data; user requirements are taken from form values.
4. Engine renders the complete email with CRM data, agent-provided greeting, and optional note (line removed if empty).
5. Output is shown to the agent for review, then submitted to the email provider.

### API Body Generation

**Scenario**: An operations team needs to call a vendor API to create a service ticket. The API requires a JSON body with specific fields, some typed. The body varies based on the issue type.

**Template** (generates a JSON body):
```
{
  "type": "${ require({ id: 'type', type: array().constraints({ values: ['incident', 'request'] }), capability: 'user', label: 'Ticket type' }) }",
  "priority": ${ require({ id: 'priority', type: int().constraints({ min: 1, max: 5 }), capability: 'user', label: 'Priority (1-5)' }) },
  "title": "${ require({ id: 'title', type: string().constraints({ minLen: 5 }), capability: 'user', label: 'Title' }) }",
  "customer_id": "${ crm({ id: 'customer_id', type: string() }) }",
  "created_at": "${ now() }"
}
```

**What the engine provides**:
- Static analysis tells the UI: three user fields, one CRM lookup, uses `now()` (non-deterministic preview)
- The form: type (select), priority (number 1–5), title (text, min 5 chars)
- After rendering: a valid JSON string ready to POST to the API

The typed fields in the template ensure that the generated JSON is valid: `priority` is always an integer (never `"5"` in quotes), `created_at` is an ISO 8601 timestamp from `now()`.

### Ticket Automation

**Scenario**: After a customer call, an agent wants to create a JIRA ticket with structured information from the call, CRM data, and a templated description.

The template is similar to the email case, but the output format is the JIRA API body. The workflow runner, after engine completion, calls the JIRA API with the rendered JSON as the body. This is a capability-based side effect — the "JIRA" capability is configured as a write capability in the driver (a future feature, as noted in the action model section).

In v1, the runner does this manually: it takes the engine output and makes the API call outside the engine. The engine's job is to produce the JSON; the runner's job is to submit it.

### Runbook Generation

**Scenario**: An operations team maintains runbooks — step-by-step guides for common operational procedures. The runbook content is static (the steps), but some values are dynamic (current system state, contact information, thresholds).

**Template structure**:
```
# Runbook: Database Failover Procedure

**Triggered by**: ${ require({ id: 'trigger', type: string(), capability: 'user', label: 'What triggered this?' }) }
**Date**: ${ now() }
**On-call engineer**: ${ secrets({ id: 'oncall', type: string() }) }

## Step 1: Verify current state
Expected healthy replicas: ${ crm({ id: 'replica_count', type: int() }) }

@{ABSORB('failover_steps_standard')}
```

The rendered runbook is a complete, timestamped operational document. The `now()` call captures when the procedure was started. The on-call engineer is sourced from a secrets/schedule system. The standard failover steps come from an ABSORB macro (maintained as a separate template, versioned independently).

### Case Workspace

**Scenario**: A customer support agent is handling a complex case involving multiple customers, a product defect, and a coordinated response. The "case workspace" is a guided UI that leads the agent through collecting information and generating structured outputs (emails, tickets, internal notes).

The case workspace is essentially a multi-template workflow:
1. Template A generates the customer notification email.
2. Template B generates the internal escalation notice.
3. Template C generates the JIRA defect ticket.

Each template has its own requirements. Some requirements are shared (the case ID, the customer ID). The workflow runner uses `analyze()` to pre-compute all requirements from all templates, deduplicates shared requirements, and presents the agent with a single unified form.

The agent fills one form; the runner feeds the values into all three templates; all three outputs are generated and dispatched. This is the "case workspace" pattern: a single interaction that drives multiple template executions.

---

## Connectors as Capability Abstractions

Every capability provider is, from the platform's perspective, a connector: a named integration point that can supply values. The `crm` capability is the CRM connector. The `secrets` capability is the vault connector. The `weather` capability is the weather API connector.

This is not just a naming convention. The capability interface IS the connector interface:

```js
// "CRM connector" = the crm capability provider
capabilities: {
  crm: async (req) => {
    const result = await crmClient.query(req.id, req.resolverHints);
    return result;
  }
}
```

Adding a new integration means adding a new capability provider and registering a new capability name. The template language expresses which connector to use (`crm`, `billing`, `weather`) and what to request from it (`req.id`, `req.resolverHints`). The platform manages the connector implementations.

Connectors can be tenant-specific: different tenants get different `crm` providers that point to different CRM instances. The template is the same; only the capability registration differs.

---

## Governance, Approvals, and Audit

In an operational context, templates are not just technical artifacts — they are business documents with risk attached. A template that generates customer emails, API calls, or financial records must be subject to governance.

**Template versioning**: Every change to a template produces a new version. The old version remains active until the new version is explicitly activated. This allows rollback.

**Review workflow**: New templates and template changes go through a review queue. A reviewer validates the template, checks the analysis (are the capability usage and phase count reasonable?), and approves or rejects.

**Execution audit**: The driver's audit hook logs every capability invocation. The log records: which template was executed, by which user, at what time, which capabilities were called, and the outcome of each call. This provides a complete audit trail.

**Output archiving**: For templates that produce documents with legal or compliance significance (contracts, financial records), the rendered output is archived with its input values. This provides evidence of what was actually sent.

**Approval gates** (future work): For high-impact actions (sending a mass email, initiating a large API call), the workflow runner can require a second person to approve the rendered output before it is submitted. This is implemented at the runner level, not the engine level.

---

## Action Descriptors: Future Work

The current system is a **pull model**: the engine pulls data from capabilities and produces a document. The operator reads the document and takes action manually.

A natural extension is an **action model**: the template can also declare what actions to take with the rendered output. Instead of just pulling data in, the system also pushes effects out.

This would look something like:

```
${ effect('send_email', {
  to: crm({ id: 'customer_email', type: string() }),
  subject: 'Your order is ready',
  body: render('email_body')  // hypothetical: render a sub-template
}) }
```

The engine would collect pending effects alongside pending needs. After evaluation, the driver would apply the effects: calling the email provider, the ticketing system, etc.

This is **not implemented in v1**. The reason is principled: effects must be explicit, deferred, and exactly-once. In the current evaluator (which may re-evaluate on every `run()` call), side effects inside expressions would be applied on every re-evaluation — which is incorrect. A proper effect model requires tracking which effects have been applied and ensuring they are applied exactly once, regardless of how many times the template is evaluated.

The existing architecture supports this extension cleanly: the driver already manages the I/O layer. Effects would be a new category of outputs from `run()`, alongside output text and pending needs, managed by the driver.

---

## Why This Is Technical, Not Marketing

Every feature described in this article derives from a specific, implementable property of the Seebo engine:

- **Form generation** is possible because `TypeBuilder` objects are machine-readable at analysis time — they are plain data, not opaque schemas.
- **Wizard steps** are possible because `analyze()` computes a topological sort of the requirement dependency graph.
- **Governance** is possible because templates are strings that can be stored, versioned, and validated statically.
- **Audit** is possible because the driver's audit hook is part of the public API, not a logging hack.
- **Streaming** (as future work) is possible because `streamability` is pre-computed during analysis.
- **Multi-tenant connectors** are possible because capability providers are injected at engine creation, not hardcoded.

None of these are vague platform promises. Each is a direct consequence of specific architectural decisions made in the engine: the type builder design, the analysis output shape, the pure core, the explicit capability model.

The low-code platform vision is not separate from the engine — it is what the engine's design enables.

---

## Conclusion

The Seebo engine is more than a string renderer. Its static analysis capabilities make it self-describing: a template can describe the form it generates, the wizard steps it requires, the integrations it uses, and the computational properties of its output — all without being executed.

This self-description is the foundation of a low-code operational platform: a template hub for authoring and governing templates, a form generator for rendering user interfaces from template metadata, a workflow runner for orchestrating multi-turn template execution, and a connector registry for integrating with external systems.

The engine's design choices — typed requirements, explicit capabilities, static analysis, pure evaluation, serializable state — were made for engineering reasons. The platform capabilities follow from those choices, not from separate design decisions. Understanding the engine is understanding the platform.

---

## Further Reading

- `src/analyze/analyze.js` — the Analysis object structure; how requirement metadata is extracted
- `src/index.js` — `stebo()` and `drive()` as the workflow runner's core operations
- Article 08 in this series: "Requirements and Capabilities: Declarative Data Dependencies"
- Article 12 in this series: "Static Analysis: Understanding Templates Without Running Them"
- Article 10 in this series: "State Machines and Resumable Evaluation"
- Richardson, C. (2018). *Microservices Patterns*. Manning. — Chapter 4: Managing Transactions with Sagas — relevant to the action/effect model
- Gamma, Helm, Johnson, Vlissides (1994). *Design Patterns*. — Template Method, Strategy, and Observer patterns, all relevant to the platform architecture
