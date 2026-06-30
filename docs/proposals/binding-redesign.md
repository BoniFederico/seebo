# Proposal: unified declarative binding (`bind` / `need`), capability contracts, and dynamic `args`

> **Status:** Draft for review. No code written yet. This document captures the design agreed
> during exploration so it can be reviewed before implementation.
>
> **Scope:** a redesign of Seebo's _declarative surface_ — how a template declares the data,
> values and effects it depends on. It does **not** change the pure/async split, the suspendable
> evaluator, or the action execution layer (`seebo/actions`); those are reused unchanged.

---

## 1. Motivation

Today a template declares three structurally-identical things with three unrelated syntaxes:

| Nature       | What it is            | Resolved from        | Today's syntax                      |
| ------------ | --------------------- | -------------------- | ----------------------------------- |
| **variable** | a pure, local value   | `resolved` / default | `var('total', int())`               |
| **need**     | missing external data | a capability         | `require({ id, type, capability })` |
| **action**   | an external effect    | the execution layer  | `action({ id, type, input })`       |

All three are the same act: _"introduce a binding `name → descriptor` of some kind"_. The
boilerplate is heaviest for `need`, where the full descriptor (type, constraints, label,
capability) is repeated inline at the point of use — even though the same data is often
referenced in several places, and its **contract (type/constraints) is a property of the
capability, not of the template**.

Three problems compound:

1. **Verbosity.** `${ require({ id:'amount', type:int(), capability:'input', label:'Importo' }) }`
   in the middle of prose is noisy.
2. **Wrong ownership of the contract.** The template repeats `type`/`constraints` that the
   capability already knows and must honour. The contract lives in the wrong place.
3. **No data dependencies between needs.** A capability cannot take, as a parameter, the resolved
   value of another need (e.g. "fetch the city, given the already-resolved region") without
   leaving the declarative model.

This proposal addresses all three, while **preserving** Seebo's three guarantees: static
analysability (`analyze`/`validate` run without executing anything), informed suspendability
(a `Need` carries a known type before resolution), and determinism (template shape does not
depend on runtime data).

---

## 2. Design overview

### 2.1 One binding keyword: `bind(name, descriptor)`

`var` is renamed to **`bind`** — a neutral binding keyword that does not lie when the bound thing
is a need or an effect. The second argument is a **descriptor** whose _nature_ is determined
statically by its node kind:

```text
${ bind('total',  int()) }                                   # variable (pure value)
${ bind('amount', need('input')) }                           # need (type from the capability)
${ bind('amount', need('input', int())) }                    # need with explicit type override
${ bind('ticket', action('jira.createIssue').input({...})) } # action (effect)
```

In the body, the bound names are ordinary `Ref`s resolved by the static symbol table — the
mechanism that already powers `${ amount }` today:

```text
Paghi ${ amount } € su un totale di ${ total }.
${ ticket }
```

Dispatch is on the **callee of the second argument**:

| Second argument          | Binding kind |
| ------------------------ | ------------ |
| a type-builder (`int()`) | `var`        |
| `need(...)`              | `require`    |
| `action(...)`            | `action`     |

`bind` is **optional**: `need(...)`, `action(...)` (and legacy `require({...})`) remain usable
inline without a prior `bind`, exactly like today (implicit registration). `bind` exists only to
declare-and-name something for reuse.

### 2.2 The contract lives in the capability (static)

`defineCapability` is enriched so the capability declares its own contract **at registration
time** (known to `createEngine`, therefore still static):

```js
defineCapability('input', {
  type: object(),
  constraints: {
    /* ... */
  },
  label: 'User input',
  resolve: (need) => collectFromUser(need),
});
```

Then `need('input')` inherits `type`/`constraints`/`label`/`format` from the capability — the
template no longer repeats them. The template may still **override** any field (precedence: the
template wins; if the provider then violates the template's stricter contract, it fails closed
with `CAPABILITY_INVALID_VALUE`, as today).

This is the "reading A" decision: the contract is **declared** by the capability, not **computed**
at resolve time. Computing the contract at runtime was explicitly rejected — it would break static
analysis (see §5).

### 2.3 Two namespaces in the descriptor: Seebo fields vs. capability `args`

A need descriptor mixes two vocabularies, which must not collide:

- **Seebo fields** (first level): `id`, `label`, `constraints`, `optional`, `default` — governed
  and validated by Seebo.
- **Capability args** (under `args`): arbitrary data passed to the provider — vocabulary owned by
  the capability, **opaque to Seebo**.

```text
${ bind('city', need('geo', { args: { region: 'eu' } })) }
```

Seebo never validates the shape of `args`. If a capability required `args.region` and receives
`{}`, **the capability fails** (its provider throws → `CAPABILITY_ERROR`). The string sugar
`need('input')` / `cap('id')` is therefore always syntactically allowed; it is the capability's
responsibility to complain if it needed `args`. _(Agreed: the completeness of `args` is
transparent to Seebo.)_

> `args` replaces today's `resolverHints` (clearer name). Rename strategy is an open question
> (§6, decision ⑤).

### 2.4 Dynamic `args`: data dependencies between needs (the new capability)

`args` may reference the resolved value of **another** binding. This is the genuinely new feature:

```text
${ bind('region', need('input')) }
${ bind('city',   need('geo', { args: { region: region } })) }
```

This is **not** a dynamic contract. The _shape_ (the type of `city`, the edge `region → city`, the
phases) stays fully static and analysable; only the _value_ of `region` is runtime. The dependency
becomes a **static edge in the requirement graph**, so:

- `analyze` reports the edge `region → city` and places them in different **phases** (`region` in
  phase 1, `city` in phase 2) — reusing the existing `requirementGraph` / `executionPlan` /
  `phaseOf` machinery;
- the driver resolves `region` first, then invokes the `geo` provider with
  `need.args.region = <resolved value>`;
- the suspend/resume loop is reused unchanged: the `Need` for `city` is simply **gated** behind the
  resolution of `region` (the same gating that already governs blocked actions and untaken ternary
  branches);
- **cycles** (`a` depends on `b`, `b` depends on `a`) are caught for free by the existing cycle
  detection in `analyze` (`potentialCycles`, `phaseOf`'s stack).

This is the correct, declarative way to express "x depends on y": an explicit edge in the Need
graph, **not** a nested dynamic constraint. The latter was rejected because it would make the
template's shape depend on runtime data (see §5).

---

## 3. How it maps onto the codebase

| File                         | Change                                                                                                                                                                                                                                        |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/util/vocabulary.js`     | Reserve `bind`, `need`; **remove `var`, `require`** from the builtin forms (see §6 ④⑥).                                                                                                                                                       |
| `src/parser/parser.js`       | Parse `bind(name, descriptor)`; `need(cap, type?, {...}?)` as a descriptor constructor. Capability sugar (`cap('id')`) unchanged.                                                                                                             |
| `src/eval/symbols.js`        | `extractVar` → `extractBinding`: dispatch on the 2nd-arg kind → `{ kind:'var'\|'require'\|'action', descriptor }`. Reuse `extractRequirement` / `buildActionDescriptor`. Relax `constToJson` **only inside `args`** to accept `Ref`/`Member`. |
| `src/analyze/analyze.js`     | Extend `walkGraph` to add edges from **data dependencies** in `args` (today it only adds edges from ternary conditions).                                                                                                                      |
| `src/eval/evaluator.js`      | A `Ref` to an `action` binding runs `evalAction` (records into the plan); a `need` whose `args` reference unresolved bindings is gated (reuses suspend/resume).                                                                               |
| `src/index.js`               | `defineCapability` accepts `type`/`constraints`/`format`/`label`.                                                                                                                                                                             |
| `src/driver/async_driver.js` | **Unchanged.** `need.args` arrives already resolved; the fail-closed validation runs identically.                                                                                                                                             |

**Reused unchanged:** the phasing (`phaseOf`), cycle detection (`potentialCycles`), and the
driver's contract enforcement. That reuse is the signal that the design is aligned with the
architecture rather than fighting it.

---

## 4. Worked examples

```text
# 1. Pure value
${ bind('vat', float().default(0.22)) }

# 2. Need whose contract comes from the capability
${ bind('amount', need('input')) }            # type/constraints from defineCapability('input', ...)

# 3. Need with a template-side override (template wins)
${ bind('amount', need('input', int().constraints({ min: 0 }))) }

# 4. Need with static args for the capability
${ bind('user', need('directory', { args: { fields: ['name', 'email'] } })) }

# 5. Dynamic args — a data dependency, resolved in phases
${ bind('region', need('input')) }
${ bind('city',   need('geo', { args: { region: region } })) }

# 6. Action binding, activated by name in the body
${ bind('ticket', action('jira.createIssue').input({ summary: amount })) }
... text ...
${ ticket }                                   # activates the action here (lazy, document order)

# Body
Paghi ${ amount } € (IVA ${ amount * vat }) per ${ city } / ${ region }.
```

---

## 5. What is intentionally NOT allowed (and why)

These were considered and **rejected** because they break one of the three guarantees:

1. **Contract decided at resolve time** (a capability returning `{ value, type, constraints }`
   computed at runtime). Breaks static analysis: `validate` could not type-check `user.name`, and
   the `Need` sent to a client would carry no type before resolution. Contracts must be declared at
   registration (§2.2).
2. **Nested dynamic constraints** (`constraints: { max: other.value }`). Same failure: the contract
   of one need would depend on another's runtime value, so the template's shape would depend on
   data. The supported way to express a dependency is a data edge in `args` (§2.4), which keeps the
   shape static.
3. **Arbitrary positional capability arguments** (`cap(a, b)` with computed expressions). The
   descriptor must remain statically inspectable; data dependencies go through `args` as graph
   edges, not opaque call arguments.

The guiding rule: **static shape, dynamic values is fine; dynamic shape is not.**

### 5.1 FAQ — why is a `Ref` allowed in `args` but not in `constraints`?

Because the two fields mean different things to the engine, and the difference is _what the field
is for_, not _where the `Ref` is written_:

- **`args` is opaque to Seebo** — it is data forwarded to the provider. The engine never reads it to
  reason about the template. A `Ref` in `args` is just a dependency edge ("resolve `region` before
  calling the `geo` provider"); the **shape** of the `city` descriptor (its type, its constraints)
  stays statically known. ✅
- **`constraints` is the contract** — Seebo reads it for static type-checking in `validate`, for the
  `options` computed by `analyze`, and for the fail-closed validation in the driver. If
  `constraints.max` depended on the runtime value of another need, `validate`/`analyze` could no
  longer know the contract, and the `Need` sent to a client would carry no constraints before
  resolution. The template's **shape** would depend on data. ❌

**The real use case ("`city`'s valid values depend on the chosen `region`") is supported — through
the capability, not through a dynamic constraint:**

```text
${ bind('region', need('input')) }
${ bind('city',   need('geo', { args: { region: region } })) }
```

The `geo` provider receives `args.region` and decides which cities are valid for that region — that
is application logic, and it lives in the capability where runtime decisions belong. Seebo still
enforces `geo`'s **static** contract (is it a `string`? does it satisfy the constraints declared by
`defineCapability('geo')`?). You get the behaviour you want without making the template's shape
dynamic.

---

## 6. Decisions (resolved)

| #   | Decision                                                                                     | Resolution                                                                                                                                                                                                                                                                         |
| --- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ①   | After renaming the declaration role to `bind`, is the `var('x')` read/accessor still needed? | **No.** A bound name is read **plain** (`${ x }`, a `Ref` resolved by the symbol table — already how it works today). `var('x')` is removed. A plain reference to an **undeclared** name stays an error (`UNDECLARED_NAME`); no implicit binding is created from a bare reference. |
| ②   | Expressiveness of `args`: only `Ref`/`Member`, or full expressions?                          | **`Ref`/`Member` only** (`region`, `region.code`) — a readable dependency edge, no phased mini-language.                                                                                                                                                                           |
| ③   | Is `bind` mandatory or optional?                                                             | **Optional.** `need(...)` / `action(...)` remain usable inline without a prior `bind` (implicit registration).                                                                                                                                                                     |
| ④   | `need(...)` vs `require({...})`.                                                             | **`need` replaces `require`. `require` is removed entirely** (no deprecation alias).                                                                                                                                                                                               |
| ⑤   | `resolverHints` → `args`.                                                                    | **`args` replaces `resolverHints`. `resolverHints` is removed entirely.**                                                                                                                                                                                                          |
| ⑥   | `var` / `require` removal.                                                                   | **Hard break: `var` and `require` are removed entirely** (the project has few users; no deprecation period).                                                                                                                                                                       |

Dynamic `args` (§2.4) is now **in scope** (decision ② confirms `Ref`/`Member`).

---

## 7. Phased implementation plan (when approved)

Each phase is committed separately with a green quality gate (`npm run check`).

1. **`defineCapability` contracts (§2.2).** Additive, lowest risk; a `require` (still the inline
   form at this stage) inherits the capability's `type`/`constraints`/`format`/`label`. No grammar
   change yet.
2. **`bind` + `need` grammar (§2.1, §2.3), with removals.** Rename `var`→`bind` and `require`→`need`;
   add the `need(...)` constructor and the `args` namespace (static only at this stage); **remove
   `var`, `require`, `resolverHints` entirely** (hard break). Migrate every source/test/doc usage.
3. **Dynamic `args` via the graph (§2.4).** Relax `constToJson` inside `args` to accept `Ref`/
   `Member`; extend `walkGraph` with data edges; gate the `need` in the evaluator. The riskiest
   phase — `analyze` and the evaluator must agree on edges (covered by multi-phase
   cross-dependency tests).
4. **Docs + CHANGELOG** (migration guide: `var`→`bind`, `require`→`need`, `resolverHints`→`args`).

---

## 8. Risks

- **Locality of knowledge.** With the contract in the capability, reading the template alone no
  longer shows the type. Mitigation: `analyze()` exposes the merged type, so tooling can show it.
- **analyze/evaluator edge agreement.** The dynamic-`args` phase requires both passes to compute
  the same dependency edges; a divergence would surface a `Need` in the wrong phase. Must be covered
  by targeted multi-phase tests.
- **Surface churn.** This is the largest declarative-surface change to date (renamed keywords, new
  constructors). It is additive in spirit but breaking in names; sequencing via the phased plan and
  a clear CHANGELOG/migration note is essential.
