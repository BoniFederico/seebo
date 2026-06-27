# Designing a Template Language: Principles and Trade-offs

## Table of Contents

1. [What a Template Language Is](#what-a-template-language-is)
2. [The Design Goals](#the-design-goals)
3. [Text Segments: The Invisible Majority](#text-segments-the-invisible-majority)
4. [Literals: Numbers, Strings, and Booleans](#literals-numbers-strings-and-booleans)
5. [Slots: Where Dynamic Values Live](#slots-where-dynamic-values-live)
6. [Expressions: A Typed Expression Language](#expressions-a-typed-expression-language)
7. [Requirements: Explicit Data Dependencies](#requirements-explicit-data-dependencies)
8. [Capabilities: Named External Providers](#capabilities-named-external-providers)
9. [Variables: Local Computed Values](#variables-local-computed-values)
10. [Macros: Structural Directives](#macros-structural-directives)
11. [Why Not Turing-Complete](#why-not-turing-complete)
12. [Why Lazy Evaluation Matters](#why-lazy-evaluation-matters)
13. [Why Requirements Must Be Explicit](#why-requirements-must-be-explicit)
14. [Declarative vs. Imperative: What the Language Describes](#declarative-vs-imperative-what-the-language-describes)
15. [Trade-offs: Expressiveness vs. Analyzability](#trade-offs-expressiveness-vs-analyzability)
16. [Conclusion](#conclusion)
17. [Further Reading](#further-reading)

---

## What a Template Language Is

A template language occupies a position in the space of programming languages that is deliberately constrained. It is not a general-purpose language, and the constraint is intentional.

A general-purpose language (JavaScript, Python, Java) is Turing-complete: given enough time and memory, it can compute any computable function. This completeness comes at a cost: it becomes impossible to answer basic questions about a program's behavior without executing it. You cannot know, in general, whether a JavaScript program will terminate, what functions it will call, or what resources it will consume. These are classical undecidability results.

A template language trades completeness for analyzability. By excluding loops, recursion, and arbitrary user-defined functions, it limits itself to a class of programs that can be analyzed statically. You can determine, before any execution, what names a template uses, what types those names must have, what external data the template needs, and in what order it will need it.

The Seebo template language is this kind of constrained system. Its grammar is defined precisely. Its type system is closed (you cannot define new types at the language level, only through the extension API). Its expression language is rich enough to express conditional logic, arithmetic, string manipulation, and temporal computation, but not rich enough to define new abstractions or iterate over arbitrary data structures.

Understanding why these constraints were chosen — and what they cost — is the subject of this article.

---

## The Design Goals

Seebo's template language was designed around five goals, listed here from most to least fundamental.

**1. Typed.** Every value that flows through evaluation must have a declared type. The type determines what operations are valid, what format is applied at emission, and what constraints govern valid values. The eight built-in types are `int`, `float`, `bool`, `string`, `datetime`, `duration`, `object`, and `array`.

**2. Declarative.** The language should describe what is needed, not how to obtain it. A template that needs a customer's name should declare "I need a string from the CRM," not "call `crmClient.getCustomer(id).name`." The mechanism for obtaining the value is the responsibility of the capability provider registered in the engine configuration, not the template.

**3. Not Turing-complete.** The language deliberately omits loops, recursion, and user-defined functions. Termination of any Seebo template is guaranteed by design.

**4. Suspendable.** The language must be able to express that a value is needed but not yet available. This is the property that makes Seebo different from a conventional template engine: an expression that references an unresolved requirement does not fail; it suspends.

**5. Statically analyzable.** Every structural property of a template — what names it uses, what requirements it declares, what capabilities it references, what phases of execution it will require — should be computable from the template source without executing it.

These goals are not independent. Turing-incompleteness is a prerequisite for static analyzability. Declarative style is a prerequisite for the kind of static analysis that produces meaningful requirement graphs and execution plans. The type system enables the static type checker to catch errors before execution.

---

## Text Segments: The Invisible Majority

Most of a template is text. A legal notice, a configuration file, an email — the bulk of the content is static, and only specific positions within it vary dynamically.

The Seebo lexer represents text between slots as `TEXT` tokens. The parser turns them into `Text` AST nodes. The evaluator copies them verbatim into the output string. No analysis is needed; no types are involved; no capabilities are consulted.

This sounds trivial, but the design of how text and slots coexist is a meaningful decision. The approach used by Seebo — sigil-delimited slots embedded in arbitrary text — is the same approach used by shell parameter expansion, Mustache, Jinja2, and most other embedded template languages. The sigils (`$`, `#`, `@`) followed by `{` mark the beginning of a slot, and `}` marks its end. Everything else is literal text.

The consequence of this design is that the sigil sequences `${`, `#{`, and `@{` cannot appear in the literal text without escaping. Seebo resolves this with a backslash escape: `\${`, `\#{`, and `\@{` are treated as literal text and produce `${`, `#{`, and `@{` in the output. The delimiters are also configurable (through `createEngine`'s `delimiters` option), so a document that contains many occurrences of `${` (such as a JavaScript template literal itself) can choose a different sigil.

```javascript
const engine = createEngine({
  delimiters: { formula: '%', open: '[', close: ']' }
});
// Now slots are delimited: %[ expression ]
```

---

## Literals: Numbers, Strings, and Booleans

Inside a slot, three kinds of literal values can appear directly in the source.

**Number literals** are either integers (a sequence of digits with no decimal point) or floats (a sequence of digits, a decimal point, and more digits). The classification happens at lexing time: the `NUMBER` token produced by the lexer is classified as `int` or `float` by the parser based on whether the literal contains a decimal point. There is no ambiguity, and no conversion at runtime: `42` is always an `int`, `3.14` is always a `float`.

```
${ 42 }       -- emits "42"
${ 3.14 }     -- emits "3.14"
```

**String literals** are sequences of characters enclosed in single quotes. The choice of single quotes, rather than the double quotes used in JSON and many programming languages, is deliberate: Seebo templates are often embedded in JSON or HTML documents where double quotes are syntactically significant, and using single quotes reduces the frequency of escaping. Within a string literal, `\'` produces a literal single quote and `\\` produces a literal backslash.

```
${ 'Hello, world' }     -- emits "Hello, world"
${ 'O\'Brien' }         -- emits "O'Brien"
```

**Boolean literals** are `true` and `false`, matching the JavaScript convention. They are lexed as `BOOL` tokens (distinguished from `NAME` tokens) and produce `bool`-typed values.

```
${ true }   -- emits "true"
${ false }  -- emits "false"
```

Note that there are no `null` or `undefined` literals. Seebo's type system does not have a null type. The `??` (nullish coalesce) operator and the `optional: true` flag on requirements handle the concept of "no value" through type-specific empty values (empty string for strings, `0` for numbers, `false` for booleans).

---

## Slots: Where Dynamic Values Live

A slot is the fundamental embedding mechanism. It is a delimited region in the template that is evaluated and replaced with its result at emission.

Seebo has three slot types, distinguished by their sigil:

**Formula slots** (`${ expression }`) contain an expression that is evaluated and whose result is converted to a string and inserted at that position in the output. This is the slot type you use for most dynamic content:

```
Dear ${ require({ id: 'name', type: { type: 'string' }, capability: 'user' }) },
Your balance is ${ require({ id: 'balance', type: { type: 'float' }, capability: 'accounts' }) }.
```

**Comment slots** (`#{ any text }`) are ignored entirely. The content is not parsed as an expression; the slot is removed from the output without a trace. Comments can contain curly braces as long as they are balanced. This is useful for template development notes:

```
#{ This line will be removed from the output. }
${ recipient_name }
```

**Macro slots** (`@{ MACRO_NAME }` or `@{ MACRO_NAME(args) }`) invoke structural directives. Macros are not expressions; they do not evaluate to values. They modify the document's structure either before parsing (aggregator macros like `ABSORB` and `MERGE`) or after evaluation (layout macros like `REMOVE_LINE`, `COLLAPSE`, `REMOVE_LEFT`, `REMOVE_RIGHT`). More on macros later.

Inside a formula slot, the brace `{` and `}` characters are tracked by the lexer (using a depth counter) so that an object literal inside an expression does not prematurely close the slot:

```
${ { key: 'value', count: 42 } }   -- valid: inner braces are tracked
```

---

## Expressions: A Typed Expression Language

The expression language inside formula slots is a substantial sublanguage. It supports the following constructs:

**Arithmetic:** `+`, `-`, `*`, `/`. The operators are defined on numeric types. Addition on strings performs concatenation. Temporal arithmetic (datetime ± duration) follows the rules described in the type system article.

**Comparison:** `==`, `!=`, `<`, `<=`, `>`, `>=`. These return boolean values. The `in` operator tests set membership: `x in [1, 2, 3]`.

**Logical:** `and`, `or`, `not`. Word-form operators (not symbols) for clarity. Both `and` and `or` are short-circuit (lazy): the right side is evaluated only when needed.

**Nullish coalesce:** `??`. Returns the left side if it is non-empty, otherwise the right side. "Empty" is type-specific: empty string for strings, `0` for numbers, `false` for booleans.

**Ternary conditional:** `condition ? then : else`. The taken branch is evaluated lazily; the not-taken branch is not evaluated at all. This is important for requirements: a requirement in the not-taken branch does not become a need.

**`match` expression:** A pattern-matching form that desugars to nested ternaries at parse time:

```
${ status match {
  'active'   => 'Your account is active',
  'suspended' => 'Your account is suspended',
  * => 'Unknown status'
} }
```

The `*` arm is the default (catch-all). A `match` without a `*` arm, where the cases do not provably cover the value domain, generates a `NON_EXHAUSTIVE_MATCH` diagnostic from `validate`.

**Function calls:** Producers and type constructors are called with the standard function call syntax:

```
${ now() }                     -- current datetime
${ int('42') }                 -- convert string to int
${ string(some_number) }       -- convert to string
${ date('YYYY-MM-DD', raw) }   -- parse a date from a string
```

**Method calls:** Transformers are methods called on a receiver value:

```
${ name.upper() }              -- string to uppercase
${ price.format() }            -- format a number
${ items.length() }            -- length of array
```

**Member access:** Access fields of an object value:

```
${ customer.address.city }
```

**Object and array literals:** Used primarily as arguments to `require` and other producers:

```
${ require({ id: 'order', type: { type: 'object' }, capability: 'orders' }) }
${ [1, 2, 3].length() }
```

The operator precedence in Seebo's expression language is fixed and documented. From lowest to highest binding:

| Operator | Associativity | Binding Power |
|----------|--------------|---------------|
| `?:` (ternary) | right | 420 |
| `??` (nullish coalesce) | right | 440 |
| `or` | left | 460 |
| `and` | left | 480 |
| `==`, `!=`, `in` | left | 500 |
| `<`, `<=`, `>`, `>=` | left | 520 |
| `+`, `-` | left | 540 |
| `*`, `/` | left | 560 |
| unary `not`, `-` | right | (prefix) |
| `.` (member access) | left | (postfix) |

Parentheses can override precedence in the usual way: `(a + b) * c`.

---

## Requirements: Explicit Data Dependencies

The `require` form is the most important construct in the language. It declares that the template needs an external value to complete:

```
${ require({
  id: 'customer_tier',
  type: { type: 'string', constraints: { values: ['gold', 'silver', 'bronze'] } },
  capability: 'crm',
  label: 'Customer loyalty tier',
  optional: false
}) }
```

Each field has a specific role:

- `id`: The unique identifier for this requirement. If the engine has already resolved a value for this ID, it uses that value immediately. Otherwise, it emits a need.
- `type`: The expected type of the value, along with optional format and constraint specifications. The driver validates the capability provider's response against this type descriptor.
- `capability`: The name of the provider that should supply this value. Must be registered in the engine configuration.
- `label`: Human-readable display text for the requirement, useful when presenting needs to a user through a UI.
- `optional`: If `true`, an unresolved requirement produces an empty value of the declared type rather than suspending. The document can render even without this value.

The `require` form is special in the expression language. It is syntactically a function call but semantically a declaration. The parser treats it as a `Call` node with callee `'require'`, but the evaluator handles it by looking up the ID in the resolved values map and either returning the value or recording a need and returning `Susp`.

Seebo also provides syntactic sugar for capability calls. If you register a capability named `crm` in the engine configuration, you can write:

```
${ crm({ id: 'customer_name', type: { type: 'string' }, label: 'Customer name' }) }
```

and the parser desugars this to `require({ id: 'customer_name', type: { type: 'string' }, capability: 'crm', label: 'Customer name' })` automatically, by injecting the `capability` field into the object literal. This is purely a parse-time transformation; the AST that downstream phases see is always in the expanded `require(...)` form.

---

## Capabilities: Named External Providers

A capability is a named function registered in the engine configuration that provides values for requirements. The template language uses capability names to tag requirements with their provider, but the capability itself is defined entirely in JavaScript, outside the template:

```javascript
const engine = createEngine({
  capabilities: {
    crm: async (req) => {
      // req.id, req.type, req.label are available
      const customer = await crmClient.getById(req.id);
      return customer.name;
    },
    orders: async (req) => {
      const order = await ordersDb.query(req.id);
      return order.total;
    }
  }
});
```

The capability function receives the full requirement descriptor and returns a value (or a Promise of a value). Returning `undefined` means "I cannot resolve this requirement now" — the need stays pending. Returning a value that does not match the declared type produces a `CAPABILITY_INVALID_VALUE` outcome.

From the template language's perspective, capabilities are opaque. The template knows a capability by name and declares that it needs a value from that capability. It does not know how the capability is implemented. This separation is the core of the declarative design: the template describes what it needs, not how to get it.

---

## Variables: Local Computed Values

The `var` form declares a locally computed value from an expression:

```
${ var({ id: 'discount_pct', type: { type: 'float' } })(tier == 'gold' ? 0.20 : tier == 'silver' ? 0.10 : 0.05) }

Your discount: ${ discount_pct }%
```

Unlike a `require`, a `var` is resolved by evaluating an expression at runtime, not by calling a capability. Its value must be computable from the values already available at the time it is encountered. If its expression references an unresolved requirement, the `var` will suspend in the same way a formula does.

Variables are declared through `collectDeclarations`, which walks the AST before evaluation begins to build a static symbol table mapping names to their descriptors. This is what allows `validate` to catch references to undeclared names: at validation time, the full set of declared names is known before any expression is evaluated.

---

## Macros: Structural Directives

Macros are a different kind of construct from expressions. They do not evaluate to values; they modify the document's structure. Seebo has two families of macros.

**Aggregator macros** (the `ABSORB` and `MERGE` directives) operate in a pre-pass before the template is parsed. They compose multiple template sources into a single document:

```
@{ ABSORB('header') }

Main content here.

${ require({ id: 'name', type: { type: 'string' }, capability: 'user' }) }

@{ ABSORB('footer') }
```

The EXPAND pre-pass replaces `@{ ABSORB('header') }` with the full text of the template named `'header'` from the template map, and similarly for `'footer'`. The resulting composed string is then parsed as a single document. This enables template composition without a separate include mechanism at the expression level.

`MERGE('prefix_*')` works similarly but matches multiple templates by glob pattern and concatenates them in sorted order:

```
@{ MERGE('section_*', '\n\n') }
```

This is useful when a document should include all templates matching a naming convention, with a configurable separator.

**Layout macros** (the `REMOVE_LINE`, `COLLAPSE`, `REMOVE_LEFT`, `REMOVE_RIGHT` directives) operate in a post-pass after the document has been evaluated. They are positional markers: the evaluator emits them as `@{MACRO_NAME}` strings in the output, and the FINALIZE pass processes them left-to-right to modify the surrounding text.

```
${ is_admin ? 'Admin panel' : @{ REMOVE_LINE } }
```

If `is_admin` is false, the evaluator emits `@{REMOVE_LINE}` into the output. The FINALIZE pass then removes the entire line containing that marker. If no line would exist (the REMOVE_LINE evaluates to nothing in context), the macro is a no-op.

The layout macros are:
- `REMOVE_LINE`: removes the entire line containing the marker, including its trailing newline
- `REMOVE_LEFT(n)`: removes `n` characters to the left of the marker
- `REMOVE_RIGHT(n)`: removes `n` characters to the right of the marker
- `COLLAPSE`: removes the marker itself and, after all markers have been processed, collapses any runs of three or more blank lines to a single blank line

---

## Why Not Turing-Complete

The decision to exclude loops, recursion, and user-defined functions is the most consequential design choice in the language. It deserves a careful explanation.

The classical result in computability theory is that, for any Turing-complete language, many interesting questions about programs in that language are undecidable. You cannot determine, in general, whether a program will terminate. You cannot determine what functions it will call. You cannot determine what resources it will consume. These are not failures of current technology; they are mathematical impossibilities.

Static analysis — the ability to determine properties of a program by examining its source rather than executing it — is constrained by computability. The more expressive the language, the less you can determine statically without executing the program.

Seebo's analysis capabilities depend directly on its non-Turing-completeness. The `validate` function can check type safety because types are propagated through a fixed grammar of expression forms. The `analyze` function can build a requirement dependency graph because the graph is a static property of the AST. The execution plan — which requirements are active in which phase — can be computed because the phasing depends only on the conditional structure of the AST, not on runtime values.

If Seebo had loops, none of this would be possible in general. A loop might iterate over an array fetched from a capability, and within the loop body, it might require additional capabilities. The number of phases, and even the set of capabilities used, would be unknowable until the loop had been executed with the actual data.

The cost of non-Turing-completeness is expressive power. You cannot define a recursive function, iterate over a collection, or build an abstraction that can be called from multiple places within the template. These limitations are real. They mean that complex document logic — sorting a list of items by a field and rendering them in order, grouping requirements by some property and rendering each group differently — must be expressed through capability implementations rather than template expressions. The template describes what it needs; the capability provides the already-processed data.

This trade-off is acceptable for the document-generation use case that Seebo targets, because the complexity that matters for that use case is the complexity of obtaining the data, not the complexity of processing it once obtained.

---

## Why Lazy Evaluation Matters

The `and`, `or`, `??`, and ternary (`?:`) operators in Seebo are lazy. The right-hand side of `and` is evaluated only when the left side is true. The right-hand side of `or` is evaluated only when the left side is false. The right-hand side of `??` is evaluated only when the left side is empty. Only the taken branch of a ternary is evaluated; the not-taken branch is not.

This laziness is critical for the suspension model. Consider:

```
${ customer_type == 'premium' ? require({ id: 'premium_feature', type: { type: 'string' }, capability: 'premium' }) : 'Standard feature' }
```

If `customer_type` is `'standard'`, the engine never encounters the `require(...)` call in the then-branch, because the condition is false and the then-branch is not evaluated. The `premium` capability is never called. No need for `premium_feature` is emitted.

This is what makes phased execution possible. When a template has multiple conditional requirements, the evaluator discovers which requirements are needed based on the values already available. Requirements behind an unresolved condition are not emitted until the condition itself resolves. This creates a natural phasing: phase 1 discovers the outermost requirements, phase 2 discovers requirements that depend on phase-1 values, and so on.

If the language were strict (eagerly evaluating all subexpressions), every requirement in the template would be emitted in the first phase, regardless of whether its gating condition had been evaluated. The natural phase structure would be destroyed.

---

## Why Requirements Must Be Explicit

A simpler design would infer requirements from undefined variable names: any name that is not defined locally and is not a built-in function is a requirement. This is how some template engines work — Mustache simply renders an empty string for undefined names; Jinja2 raises an error.

Seebo requires explicit `require(...)` declarations for several reasons.

First, type information. An inferred requirement has no type: you know that `customer_name` is needed, but not whether it is a string, a number, or an object. Without type information, the engine cannot validate the value returned by the capability provider, cannot infer the type of expressions that use the value, and cannot enforce constraints.

Second, capability routing. An explicit `require` declaration specifies which capability should supply the value. Without explicit declarations, the engine cannot route requests to the right provider.

Third, metadata. The `label`, `description`, `optional`, and `priority` fields on a requirement carry information that cannot be inferred from a variable name. This metadata is used by the driver to prioritize capability invocations, by UI generators to display forms to users, and by the analysis output to describe the template's dependencies.

Fourth, clarity. When reading a template, an explicit `require(...)` declaration clearly indicates that the value comes from outside the template. An undefined name could be a bug (a typo, a renamed variable) or an intended external dependency. Making the declaration explicit eliminates the ambiguity.

---

## Declarative vs. Imperative: What the Language Describes

The distinction between declarative and imperative is most clearly visible at the boundary between the template and the capability providers.

An imperative template would say: "Call the CRM API, get the customer record, extract the name field, apply title casing, and insert it here." The template contains the logic of how to obtain and transform the value.

A declarative template says: "I need a string from the `crm` capability, identified as `customer_name`." The template contains only the declaration of the dependency. The logic of how to satisfy the dependency lives in the capability implementation.

This declarative style has consequences that extend through the entire design. The static analyzer can enumerate all dependencies without executing the template, because dependencies are declarations, not procedure calls. The driver can route requirements to appropriate capabilities without understanding the template's expression logic, because the capability name is part of the requirement descriptor, not buried in code. The state object can be serialized without capturing closures, because the state contains resolved values, not suspended computations.

The Seebo language is declarative at the level of data dependencies. Within the expression language, it is as functional as any expression language: you write `a + b * c` and the expression computes a value. But the expressions themselves do not perform I/O, do not modify global state, and do not call into external systems. They operate on values that were either declared as literals, computed locally, or declared as requirements.

---

## Trade-offs: Expressiveness vs. Analyzability

No design achieves all goals simultaneously. The Seebo template language makes several trade-offs worth naming explicitly.

**Trade-off 1: No user-defined functions.** You cannot define a helper function inside a template and call it from multiple places. If you need to compute the same value in two different slots, you must either use `var` (which works for simple cases) or express the computation twice. The gain is that the evaluator never needs to handle recursive calls, and the static analyzer never needs to analyze a user-defined call graph.

**Trade-off 2: No iteration.** There is no `for` loop, no list comprehension, no `map` function. If your template needs to render a list of items, the list must be pre-processed by a capability and returned as a pre-rendered string or an array value that is then stringified. The gain is that the execution time of any Seebo template is bounded by the size of the template source, not by the size of runtime data.

**Trade-off 3: No dynamic names.** Requirement IDs must be string literals; they cannot be computed from expressions. You cannot write `require({ id: computed_id, ... })`. This restriction makes the static analyzer's symbol table complete: the full set of requirement IDs is knowable from the source. The gain is that `analyze` can enumerate all requirements before any execution.

**Trade-off 4: No side effects.** An expression cannot modify state. This rules out patterns like incrementing a counter within a template or building up a result through mutations. The gain is that evaluation is pure and can be repeated (as in the full re-evaluation strategy of v1) without concern for double-execution of side effects.

These trade-offs collectively define a design point in the language space: expressive enough for real document-generation tasks, constrained enough to be statically analyzable. They are not arbitrary. Each one was chosen to serve the design goals stated at the beginning of this article.

---

## Conclusion

The Seebo template language is a small, typed, declarative language for describing documents that depend on external data. It is not a general-purpose programming language. Every design decision — from the sigil-delimited slots to the Pratt-parsed expression language, from the explicit `require` declarations to the two-pass macro system — follows from the five design goals: typed, declarative, not Turing-complete, suspendable, statically analyzable.

Understanding the language design is the prerequisite for understanding the engine that implements it. The next three articles descend from the language level to the implementation level, starting with the overall engine architecture and then drilling into the lexer in detail.

---

## Further Reading

- Wadler, P. (1992). "The essence of functional programming." *POPL '92.* — The paper that introduced monads as a way to express effects in pure languages; useful background for understanding why Seebo separates pure evaluation from effectful capability resolution.
- Meyer, B. (1997). *Object-Oriented Software Construction* (2nd ed.). Chapter on the command-query separation principle. — The separation of commands (effects) from queries (pure computations) is analogous to Seebo's separation of evaluation from capability invocation.
- Krishnamurthi, S. (2001). "Automata via Macros." *Journal of Functional Programming.* — An example of how constrained macro systems can implement non-trivial features; context for Seebo's two-pass macro design.
- Pierce, B.C. (2002). *Types and Programming Languages.* MIT Press. — The standard reference for type system design; the chapter on simple types and the chapter on subtyping are most relevant to Seebo's type model.
