# Macro Processing: Text Transformation Before and After Evaluation

## Table of Contents

1. [Why Macros Exist](#why-macros-exist)
2. [The Two Macro Phases](#the-two-macro-phases)
3. [The Canonical Pipeline Order](#the-canonical-pipeline-order)
4. [EXPAND Phase: Structural Composition](#expand-phase-structural-composition)
   - [ABSORB](#absorb)
   - [MERGE](#merge)
   - [Depth Limits and Cycle Detection](#depth-limits-and-cycle-detection)
   - [Why EXPAND Happens Before Tokenization](#why-expand-happens-before-tokenization)
   - [Source Mapping Trade-off](#source-mapping-trade-off)
5. [FINALIZE Phase: Layout Cleanup](#finalize-phase-layout-cleanup)
   - [REMOVE_LINE](#remove_line)
   - [REMOVE_LEFT and REMOVE_RIGHT](#remove_left-and-remove_right)
   - [COLLAPSE](#collapse)
   - [Positional Application and Offset Recalculation](#positional-application-and-offset-recalculation)
   - [Why FINALIZE Cannot Be Done at Expression Level](#why-finalize-cannot-be-done-at-expression-level)
6. [Why Macro Order Matters](#why-macro-order-matters)
7. [Custom Macros](#custom-macros)
8. [Worked Examples](#worked-examples)
9. [Conclusion](#conclusion)
10. [Further Reading](#further-reading)

---

## Why Macros Exist

Template engines deal in text. But text composition — assembling a complete document from pieces, conditionally removing sections, normalizing whitespace — is not well-handled by expression evaluation alone.

Consider a simple case: you have a template that conditionally includes a line, and you want to remove that line entirely when the condition is false. In an expression language, you can write:

```
${ showNote ? 'Note: ' + note : '' }
```

If `showNote` is false, the slot produces an empty string. But it leaves behind a blank line in the output. The newline character surrounding the slot is still there. The user sees:

```
Dear customer,

[blank line here]
Best regards,
```

You cannot remove that blank line from inside an expression, because an expression has no concept of "the text around me." It produces a value; it does not transform the surrounding document.

This is the gap that layout macros fill. The marker `@{REMOVE_LINE}` is placed as a possible output value of an expression. After evaluation, a post-processing pass finds the marker and removes the entire line containing it. This gives the template author control over layout that cannot be expressed through value-producing expressions alone.

Similarly, structural macros solve a different problem: how do you compose a document from many separate template files? Expression evaluation cannot inline a separate file's content — by the time expressions are evaluated, the source text is already fixed. Composition must happen at the text level, before parsing.

Macros are the answer to both problems.

---

## The Two Macro Phases

Seebo's macro system has two distinct phases, and it is essential that they are kept separate:

**EXPAND** is a pre-processing pass. It runs on the raw template string, before tokenization. Its job is structural composition: inlining other templates (ABSORB) and concatenating groups of templates (MERGE). The input and output of EXPAND are both plain text strings. The output feeds directly into the tokenizer.

**FINALIZE** is a post-processing pass. It runs on the resolved output string, after `run()` has evaluated all expressions and produced a text result. Its job is layout cleanup: removing empty lines (REMOVE_LINE), removing surrounding characters (REMOVE_LEFT, REMOVE_RIGHT), and collapsing multiple blank lines (COLLAPSE). The input is the raw rendered output; the final output is the clean, formatted result.

These two phases operate on fundamentally different representations:
- EXPAND operates on source templates (possibly containing unevaluated slots)
- FINALIZE operates on rendered output (no slots, only resolved text)

Keeping them separate is not just a design preference — it is a correctness requirement. EXPAND cannot know what expressions will evaluate to (they haven't been evaluated yet). FINALIZE cannot inline templates (the template has already been rendered). Each phase has a well-defined domain.

---

## The Canonical Pipeline Order

The complete macro-aware pipeline is:

```
Raw Template String(s)
        │
        ▼
  ┌─────────────────────────────────┐
  │ EXPAND                          │
  │  ABSORB('name') → inline        │
  │  MERGE('pattern', sep) → concat │
  └─────────────────────────────────┘
        │ composed template string
        ▼
  ┌──────────────┐
  │  TOKENIZE    │
  └──────────────┘
        │
        ▼
  ┌──────────────┐
  │    PARSE     │
  └──────────────┘
        │
        ▼
  ┌──────────────────────────────┐
  │ validate / analyze (optional)│
  └──────────────────────────────┘
        │
        ▼
  ┌──────────────┐
  │     RUN      │  (suspendable evaluator)
  └──────────────┘
        │ raw output string (may contain @{REMOVE_LINE} etc.)
        ▼
  ┌──────────────────────────────────────────┐
  │ FINALIZE                                 │
  │  REMOVE_LINE, REMOVE_LEFT/RIGHT, COLLAPSE│
  └──────────────────────────────────────────┘
        │
        ▼
  Final Output String
```

Understanding this order is critical for understanding what macros can and cannot do. EXPAND operates on source text, before any parsing. FINALIZE operates on rendered text, after all evaluation.

---

## EXPAND Phase: Structural Composition

### ABSORB

The `ABSORB` macro inlines another named template at the position of the macro marker:

```
@{ABSORB('email_header')}

Dear ${ require({ id: 'name', type: string(), capability: 'user', label: 'Name' }) },

@{ABSORB('email_footer')}
```

The templates `email_header` and `email_footer` are provided as named strings in the `stebo()` call or in the engine configuration. The EXPAND pass replaces each `@{ABSORB('email_header')}` with the content of the named template.

If the named template does not exist, ABSORB produces an empty string. This is a deliberate design choice: missing templates are treated as empty rather than as errors. It allows optional sections to be omitted cleanly without requiring conditional logic in the template. If you want an error on missing templates, you validate the template list before calling `stebo()`.

### MERGE

The `MERGE` macro concatenates all templates whose names match a glob pattern:

```
@{MERGE('section_*', '\n---\n')}
```

This finds all templates whose names match `section_*` (e.g., `section_intro`, `section_body`, `section_closing`), sorts them lexicographically by name, and concatenates them with `'\n---\n'` between each pair. The separator is optional; if omitted, templates are concatenated with no separator.

The glob pattern is **anchored**: `section_*` matches names that begin with `section_` and have any suffix. The translation to a regular expression uses only safe patterns (no backtracking-prone constructs), avoiding the class of ReDoS (Regular Expression Denial of Service) vulnerabilities that can affect glob implementations using greedy patterns.

Sorting by name is deterministic: given the same set of templates, MERGE always produces the same output regardless of the order templates were registered. This is essential for reproducible builds and reliable testing.

### Depth Limits and Cycle Detection

EXPAND is recursive: the content of an absorbed template may itself contain `ABSORB` or `MERGE` macros, which are expanded in turn. This recursion is bounded by `limits.maxDepth` (default: 20). If the depth exceeds this limit, the engine stops with a `DEPTH_EXCEEDED` diagnostic rather than consuming unbounded memory or stack space.

Cycle detection prevents infinite recursion: if template A absorbs template B, which absorbs template A, the analyzer detects the cycle on the second encounter of A and stops with an `INCLUSION_CYCLE` diagnostic.

The cycle detection is implemented by maintaining a set of currently active template names during expansion. Before expanding a template, the name is added to the set. After expansion, it is removed. If the name is already in the set when we try to expand it, we have detected a cycle.

### Why EXPAND Happens Before Tokenization

This is a frequently asked question. Couldn't we expand macros after parsing, operating on the AST? The answer is no, for a fundamental reason:

The EXPAND phase produces a new template string. This new string is the input to the tokenizer. The tokenizer must tokenize the result of expansion — it has no way to tokenize `ABSORB('header')` and then later replace it with the header's tokens, because the header may contain expressions that interact with the outer template's scope (sharing identifier declarations, for example).

More practically: the composed template must be a single, valid, coherent template that can be tokenized and parsed as a unit. This is only possible if composition happens at the text level before parsing.

### Source Mapping Trade-off

There is a real cost to pre-tokenization expansion: source positions in the expanded template do not directly correspond to source positions in the original component templates. If an error occurs at position 1450 in the expanded template, and the expansion absorbed three templates of 400 characters each, you cannot trivially tell the user whether the error is in the header, the body, or the footer.

Seebo v1 does not implement source maps for the expansion phase. Errors are reported with positions in the **expanded** template string, not in the component templates. This is a known limitation. Future work would involve maintaining a mapping from expanded positions back to source template names and offsets, similar to how JavaScript source maps relate minified code back to original source.

The trade-off was accepted in v1 because the primary use case for ABSORB/MERGE is assembling well-tested component templates, where errors in the components are caught in isolation before assembly. Post-assembly errors are typically in the "glue" — the surrounding template — where positions in the expanded string are already meaningful.

---

## FINALIZE Phase: Layout Cleanup

### REMOVE_LINE

`@{REMOVE_LINE}` is a layout marker that can appear as a template expression value:

```
${ note != '' ? 'Note: ' + note : '@{REMOVE_LINE}' }
```

When `note` is empty, the expression evaluates to the string `'@{REMOVE_LINE}'`. This string appears in the raw output:

```
Dear customer,
@{REMOVE_LINE}
Best regards,
```

The FINALIZE pass finds this marker, identifies the complete line it occupies, and removes that line including its newline character:

```
Dear customer,
Best regards,
```

The marker does not need to be the only content on the line — it can appear alongside other text. But it is most useful when the entire line should be removed conditionally.

### REMOVE_LEFT and REMOVE_RIGHT

`@{REMOVE_LEFT(n)}` removes the `n` characters immediately to the left of the marker in the output. `@{REMOVE_RIGHT(n)}` removes `n` characters to the right.

These markers enable fine-grained conditional content removal:

```
${ showComma ? ',' : '@{REMOVE_LEFT(1)}' }
```

If `showComma` is false, the expression evaluates to `'@{REMOVE_LEFT(1)}'`. In the raw output, suppose the previous character is a space. FINALIZE removes that space, eliminating the trailing separator.

This is useful for lists where you want to conditionally remove separators between items without restructuring the entire template.

### COLLAPSE

`@{COLLAPSE}` appears as a positional marker in the output to indicate: "collapse multiple blank lines near this point to at most one blank line."

When several optional sections are removed by `REMOVE_LINE`, the result may be multiple consecutive blank lines:

```
Dear customer,



Best regards,
```

Placing `@{COLLAPSE}` (via an expression like `'@{COLLAPSE}'` in an appropriate slot) near these sections tells FINALIZE to normalize consecutive blank lines to a single blank line:

```
Dear customer,

Best regards,
```

COLLAPSE is applied to the output as a whole, finding all runs of two or more consecutive blank lines and reducing them to one.

### Positional Application and Offset Recalculation

FINALIZE markers are positional: each marker knows its byte offset in the raw output string. The FINALIZE pass processes markers left-to-right.

After each marker is processed, the output string changes length (characters are removed). All subsequent marker offsets must be recalculated to account for the shift. This is done by tracking the cumulative deletion offset: each time characters are removed from position P, all markers at positions > P have their offsets decremented by the number of characters removed.

**Overlapping removals** are handled safely: if two markers specify overlapping removal ranges (e.g., two REMOVE_LEFT markers whose ranges overlap), the second marker's removal is a no-op if its range has already been removed. This is implemented by checking whether the target range still exists before applying each removal.

The left-to-right ordering ensures that when a marker is processed, all markers to its left have already been applied. This makes the offset recalculation straightforward: only forward offsets need adjustment.

### Why FINALIZE Cannot Be Done at Expression Level

Layout cleanup cannot be done during expression evaluation for a fundamental reason: **the information needed to perform layout cleanup is only available after evaluation is complete**.

Whether a line is "blank" depends on what all expressions on that line produced. To know if a line should be removed, you need to know the final rendered value of every slot on that line. During evaluation, you are computing individual expression values — you don't have a view of the assembled line.

Similarly, knowing whether two blank lines have accumulated between sections requires knowing the final layout of the entire document, which is only known after all expressions have been evaluated and their values concatenated into the output string.

This is why FINALIZE is a post-evaluation pass: it can only see the things it needs to see after the evaluator has finished its work.

---

## Why Macro Order Matters

Swapping the phases would break the system:

**FINALIZE before EXPAND**: FINALIZE expects to operate on a fully rendered string (no slots). But before EXPAND, the template still contains unevaluated slots. Running FINALIZE on `${ require({...}) }` is meaningless — there are no layout markers yet.

**EXPAND after tokenization**: If we ran EXPAND on the AST rather than on the source string, we would need to merge AST subtrees instead of strings. This is significantly more complex and requires that the absorbed templates have compatible scopes. Running at the text level is simpler and sufficient.

**FINALIZE during evaluation**: The evaluator is pure and produces values for individual expressions. It has no access to the assembled output string. Layout cleanup requires the assembled string.

The canonical order is: EXPAND → tokenize → parse → run → FINALIZE. Each step requires the output of the previous step. There is no valid reordering.

---

## Custom Macros

The `defineMacro(name, def)` factory allows adding custom macro directives to the engine. Custom macros are defined with:

- `name`: the macro identifier (used as `@{NAME}` in templates)
- `phase`: either `'expand'` (pre-processing) or `'finalize'` (post-processing)
- `apply(slot, context)`: the transformation function for expand-phase macros
- Or `apply(marker, output)` for finalize-phase macros that edit the output string

Custom expand-phase macros receive the macro slot content and the current templates registry, and return a string to substitute. Custom finalize-phase macros receive the marker position and the output string, and return the modified output string.

This allows application-specific macro behavior to be added without modifying the engine core. For example, a custom `INCLUDE_IF(condition)` macro that conditionally includes a section, or a custom `TRIM_TRAILING_SPACES` that normalizes whitespace in a domain-specific way.

---

## Worked Examples

### ABSORB: Composing an Email

Templates provided:
```
'email_header': 'From: no-reply@company.com\nDate: ${now()}\n\n'
'email_footer': '\n\nRegards,\nThe Team'
```

Main template:
```
@{ABSORB('email_header')}
Dear ${ require({id:'name', type:string(), capability:'user', label:'Name'}) },
Your order is confirmed.
@{ABSORB('email_footer')}
```

After EXPAND:
```
From: no-reply@company.com
Date: ${now()}

Dear ${ require({id:'name', type:string(), capability:'user', label:'Name'}) },
Your order is confirmed.

Regards,
The Team
```

This is now a single coherent template that can be tokenized and parsed normally.

### MERGE: Assembling Sections

Templates provided:
```
'section_01_intro': 'Dear customer,\n\n'
'section_02_body':  'Your order #${ require({id:"orderId",...}) } is ready.\n\n'
'section_03_close': 'Thank you for your business.'
```

Main template:
```
@{MERGE('section_*', '')}
```

After EXPAND (sections sorted lexicographically):
```
Dear customer,

Your order #${ require({id:"orderId",...}) } is ready.

Thank you for your business.
```

### REMOVE_LINE: Conditional Line Removal

Template:
```
Subject: Order Confirmation
${ hasReference ? 'Reference: ' + reference : '@{REMOVE_LINE}' }
Body text here.
```

With `hasReference = false`, run() produces:
```
Subject: Order Confirmation
@{REMOVE_LINE}
Body text here.
```

After FINALIZE:
```
Subject: Order Confirmation
Body text here.
```

The line containing `@{REMOVE_LINE}` (including the newline) is removed entirely.

### COLLAPSE: Normalizing Blank Lines

Template with multiple optional sections that all get REMOVE_LINE:
```
Header

@{REMOVE_LINE}

@{REMOVE_LINE}

Footer
```

After removing the marked lines:
```
Header



Footer
```

Adding `@{COLLAPSE}` to the template (or using it alongside REMOVE_LINE markers):

After COLLAPSE:
```
Header

Footer
```

---

## Conclusion

Seebo's macro system addresses two distinct needs that expression evaluation cannot satisfy: structural composition of templates (EXPAND phase) and layout normalization of rendered output (FINALIZE phase). By keeping these phases separate and placing them at exactly the right points in the pipeline — EXPAND before tokenization, FINALIZE after evaluation — the system maintains a clean architecture where each phase operates on a well-defined representation.

The built-in macros cover the most common use cases: inlining templates, merging template sets, removing lines, and collapsing whitespace. Custom macros extend the system for application-specific needs. And the depth limits and cycle detection in EXPAND ensure that compositional power doesn't become a security liability.

Understanding the macro pipeline is particularly important when debugging unexpected output: if the rendered text contains unexpected blank lines or missing content, the likely explanation is in either the EXPAND output (composition failure) or the FINALIZE pass (unexpected removal). Inspecting the intermediate outputs — the expanded template string and the raw run() output before finalization — quickly isolates the issue.

---

## Further Reading

- `src/macros/expand.js` — EXPAND pass: ABSORB/MERGE implementation, cycle detection, depth limiting
- `src/macros/finalize.js` — FINALIZE pass: REMOVE_LINE/REMOVE_LEFT/REMOVE_RIGHT/COLLAPSE; offset recalculation
- `src/index.js` — `defineMacro()` factory; how custom macros are registered
- `src/util/limits.js` — `maxDepth` limit used by EXPAND
- Article 03 in this series: "Engine Architecture: A Pipeline of Pure Transformations"
- Article 14 in this series: "Extensibility: Designing a Safe Plugin Architecture"
- Kernighan, B.W. & Plauger, P.J. (1976). *Software Tools*. Addison-Wesley. — Chapter 2 on text processing pipelines
- The source map specification: https://sourcemaps.info/spec.html — for understanding the source-mapping problem introduced by pre-tokenization expansion
