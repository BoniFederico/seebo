# Parsing Expressions: Recursive Descent, Pratt Parsing, and AST Design

## Table of Contents

1. [What Parsing Does](#what-parsing-does)
2. [Why Expression Parsing Is Harder Than Lexing](#why-expression-parsing-is-harder-than-lexing)
3. [Document-Level Structure](#document-level-structure)
4. [The Expression Parsing Problem: Precedence and Associativity](#the-expression-parsing-problem)
5. [Recursive Descent for the Outer Grammar](#recursive-descent-for-the-outer-grammar)
6. [Pratt Parsing: Top-Down Operator Precedence](#pratt-parsing)
7. [Seebo's Precedence Table in Practice](#seebos-precedence-table-in-practice)
8. [AST Node Design: Frozen POJOs](#ast-node-design)
9. [The Stable AST Contract and astVersion](#the-stable-ast-contract)
10. [Source Positions on AST Nodes](#source-positions)
11. [Match Desugaring](#match-desugaring)
12. [Syntax Diagnostics Without Crashing](#syntax-diagnostics)
13. [Worked Examples](#worked-examples)
14. [Conclusion](#conclusion)
15. [Further Reading](#further-reading)

---

## What Parsing Does

The lexer turns a raw string into a flat sequence of tokens: `NUMBER(1)`, `OPERATOR(+)`, `NUMBER(2)`, `OPERATOR(*)`, `NUMBER(3)`. The parser's job is to turn that flat sequence into a tree that captures grammatical structure. Specifically, it must know that `1 + 2 * 3` is `1 + (2 * 3)` and not `(1 + 2) * 3`. That knowledge does not come from the token stream — it comes from the grammar and the associated precedence rules, which the parser enforces.

The product of parsing is an Abstract Syntax Tree, or AST. The word "abstract" distinguishes it from a Concrete Syntax Tree, which would preserve every token including parentheses, commas, and whitespace. An AST discards punctuation that is structurally implied and keeps only the semantically meaningful relationships. A parenthesized expression `(a + b)` and the bare expression `a + b` produce the same AST subtree: a binary node with operator `+`, left child `a`, right child `b`.

In Seebo the parser consumes the flat token array produced by the lexer and returns a `Document`, a typed, frozen POJO whose `nodes` field is an ordered sequence of text segments, formula slots, comment slots, and macro slots. Inside each formula slot there is an expression tree built from AST nodes that the evaluator, the validator, and the analyzer all consume without ever looking at raw source text again.

The parser in Seebo is `src/parser/parser.js`. Its entry point is:

```js
export function parse(tokens, options) { ... }
```

It requires `options.source` — the original template string — because tokens store only byte offsets, not the text they cover. The source is threaded through the parse context and sliced on demand wherever lexeme text is needed.

---

## Why Expression Parsing Is Harder Than Lexing

Lexing is essentially a finite automaton problem. Each token rule can be matched with a regular expression or, more efficiently, a hand-written character-by-character scan. The lexer does not need to remember what it saw three tokens ago; it reads left to right and emits tokens. Seebo's lexer is deliberately error-tolerant: it never throws, it calls an `onError` callback for recoverable problems and continues scanning.

Expression parsing is a context-free grammar problem. Operator precedence creates implicit nesting: `a + b * c` requires the parser to recognize that `b * c` forms a tighter subexpression even though there is no punctuation grouping it. Associativity requires knowing that `a - b - c` is `(a - b) - c` (left-associative) while `a ?: b ?: c` should be `a ?: (b ?: c)` (right-associative). These are not properties of individual tokens; they are properties of the grammar rules governing how tokens may legally combine.

A context-free grammar (CFG) describes a language by defining productions: rules that say "an expression can be a literal, or two expressions joined by an operator, or an expression in parentheses." The challenge is that CFGs for expression languages are typically ambiguous — the string `1 + 2 * 3` matches multiple parse trees under a naive CFG. Disambiguation requires either transformation (baking precedence into the grammar with one non-terminal per precedence level) or an algorithmic approach that makes the precedence decisions dynamically during parsing. Seebo uses the latter.

---

## Document-Level Structure

A Seebo template is not a pure expression language. It is a document that interleaves verbatim text with typed slots. The top-level grammar is simple and regular enough that a straightforward linear scan works: the parser looks at each token and decides which kind of node it is building.

```js
while (!ctx.atEnd()) {
  const tok = ctx.peek();
  if (tok.kind === TokenType.TEXT) {
    // verbatim text segment
    nodes.push({ kind: 'Text', position: ..., value: unescapeText(...) });
  } else if (tok.kind === TokenType.SLOT_OPEN) {
    nodes.push(parseSlot(ctx)); // delegates to formula/macro/comment
  } else {
    throw ctx.error(`unexpected token ...`, tok);
  }
}
return { astVersion: AST_VERSION, nodes };
```

Each slot opens with a sigil: `$` for a formula, `#` for a comment, `@` for a macro. The lexer has already identified these as `SLOT_OPEN` tokens. The parser inspects the sigil character to dispatch:

- `#{...}` — a comment slot, discarded at emission. No inner expression is parsed.
- `@{...}` — a macro slot. The parser reads the macro name (a `MACRO_NAME` token), optional arguments, and a closing brace. The result is a `Macro` node tagged with the macro's family (`aggregator` or `layout`).
- `${...}` — a formula slot. The parser calls `parseExpr(ctx, 0)` to parse an arbitrary expression, then expects a closing brace. The result is a `Formula` node containing the expression tree.

The three slot types correspond to distinct `kind` values in the AST: `'Text'`, `'Formula'`, `'Comment'`, `'Macro'`. Together they form the `Node` union type.

---

## The Expression Parsing Problem: Precedence and Associativity

Consider Seebo's expression `a ?? b ?: c`. What does this mean? The `??` (nullish coalesce) has binding power 440, and `?:` (ternary) has binding power 420. A lower binding power means the operator grabs less tightly: `?:` is "weaker" than `??`. So the expression parses as `(a ?? b) ?: c` — the `??` binds its operands first, and the `?:` treats the result of `a ?? b` as its condition.

Now consider `a - b - c`. Both minus operators have the same binding power (540) and are left-associative. The correct parse is `(a - b) - c`. If you naively parse `b - c` first you get the wrong tree.

A right-associative example: `a ?: b ?: c` should parse as `a ?: (b ?: c)`. When the parser encounters the second `?:`, it should recurse rather than consuming the remaining tokens as the else-branch of the first ternary.

Handling all these cases correctly requires a method that tracks the "minimum binding power" the current expression must exceed before ceding control to an enclosing parse. This is exactly what Pratt parsing provides.

---

## Recursive Descent for the Outer Grammar

Seebo uses recursive descent for everything above the expression level: document nodes, slot dispatch, macro argument lists, array and object literals, and the `match` form. Recursive descent means each grammatical construct has a dedicated function that calls other functions for its sub-constructs. This produces straightforward, readable code that mirrors the grammar directly.

The call graph for a formula slot is:

```
parse → parseSlot → parseExpr → parseUnary → parsePostfix → parseAtom
                                      ↑                          |
                                      └──────────────────────────┘
                                        (infix loop)
```

`parseAtom` handles the terminal cases: number literals, string literals, boolean literals, identifiers, parenthesized groups, array literals `[...]`, and object literals `{...}`. `parsePostfix` wraps the atom with zero or more postfix operations: member access `.key`, method calls `.name(...)`, function calls `name(...)`, and `match` dispatch. `parseUnary` handles the prefix unary operators `not` and `-`. `parseExpr` is the Pratt loop that handles infix operators.

---

## Pratt Parsing: Top-Down Operator Precedence

Pratt parsing was described by Vaughan Pratt in 1973 under the name "top-down operator precedence." The insight is elegant: instead of encoding precedence into the grammar with one non-terminal per level (which requires many grammar rules), you assign each operator a "binding power" number and let the parser algorithm use those numbers dynamically.

The algorithm has two concepts. The **null denotation** (nud) of a token describes how that token behaves at the start of an expression: a number literal produces a literal node, an open parenthesis triggers grouping, a unary `-` triggers a prefix negation. The **left denotation** (led) of a token describes how that token behaves when it appears to the right of a subexpression already parsed: an `+` operator takes the left expression and the next expression as its two operands, a `.` takes the left expression and reads a member name.

In Seebo, the nud role is handled by `parseUnary → parsePostfix → parseAtom`, and the led role is handled by the loop inside `parseExpr`. The binding power table is:

```js
export const PRECEDENCE = Object.freeze({
  '*':  { level: 3, assoc: 'left',  binding: 560 },
  '/':  { level: 3, assoc: 'left',  binding: 560 },
  '+':  { level: 4, assoc: 'left',  binding: 540 },
  '-':  { level: 4, assoc: 'left',  binding: 540 },
  '<':  { level: 5, assoc: 'left',  binding: 520 },
  '<=': { level: 5, assoc: 'left',  binding: 520 },
  '>':  { level: 5, assoc: 'left',  binding: 520 },
  '>=': { level: 5, assoc: 'left',  binding: 520 },
  '==': { level: 6, assoc: 'left',  binding: 500 },
  '!=': { level: 6, assoc: 'left',  binding: 500 },
  'in': { level: 6, assoc: 'left',  binding: 500 },
  'and':{ level: 7, assoc: 'left',  binding: 480 },
  'or': { level: 8, assoc: 'left',  binding: 460 },
  '??': { level: 9, assoc: 'right', binding: 440 },
  '?:': { level:10, assoc: 'right', binding: 420 },
});
```

The `parseExpr` function takes a `minBinding` argument — the minimum binding power the next operator must have before this call is allowed to consume it:

```js
function parseExpr(ctx, minBinding) {
  ctx.enter();
  let left = parseUnary(ctx); // nud

  for (;;) {
    const tok = ctx.peek();
    if (!tok || tok.kind !== TokenType.OPERATOR) break;
    const op = ctx.text(tok);

    // Ternary is handled specially (its condition is already in `left`)
    if (op === '?') {
      if (TERNARY_BINDING < minBinding) break;
      ctx.next();
      const thenExpr = parseExpr(ctx, 0);
      ctx.expectPunct(TokenType.OPERATOR, ':', "expected ':' in ternary");
      const elseExpr = parseExpr(ctx, TERNARY_BINDING); // right-associative
      left = { kind: 'Ternary', ... };
      continue;
    }

    const prec = PRECEDENCE[op];
    if (!prec) break;
    if (prec.binding < minBinding) break; // yield to the caller

    ctx.next(); // consume the operator
    // For left-associative operators, the recursive call uses binding + 1
    // to prevent re-consuming the same operator; for right-associative,
    // the same binding is used to allow right-to-left chaining.
    const right = parseExpr(ctx,
      prec.assoc === 'left' ? prec.binding + 1 : prec.binding);
    left = { kind: 'Binary', op, left, right, ... };
  }

  ctx.exit();
  return left;
}
```

The critical line is `prec.assoc === 'left' ? prec.binding + 1 : prec.binding`. For a left-associative operator like `+` (binding 540), when parsing the right operand, the recursive call uses `minBinding = 541`. This means the recursive call will stop as soon as it sees another `+` (binding 540 < 541), leaving it for the loop to consume. The result is left-to-right grouping. For a right-associative operator like `??` (binding 440), the recursive call uses `minBinding = 440`, so a second `??` at the same level is consumed by the recursion, producing right-to-left grouping.

---

## Seebo's Precedence Table in Practice

Seebo's precedence levels follow a design principle: arithmetic binds tightest, logical operators bind loosest, and the flow-control operators (`??`, `?:`) are weaker still. This matches the expected reading of templates.

Consider `price * qty + tax > budget and isApproved`. With the table above:
- `price * qty` groups first (binding 560)
- `+ tax` groups next (binding 540)
- `> budget` groups next (binding 520)
- `and isApproved` groups last (binding 480)

The full parse is `((price * qty) + tax) > budget) and isApproved`.

The `in` operator (binding 500, same level as `==`) checks membership in an array: `status in ['pending', 'active']`. It shares the equality level because `x in arr` is semantically a predicate producing a boolean, and chaining it with `==` is not meaningful in Seebo.

The `??` (nullish coalesce, binding 440) and `?:` (ternary, binding 420) both appear below `or` (binding 460). This means `a or b ?? c` is `(a or b) ?? c`, not `a or (b ?? c)`. In practice, authors combine these operators with parentheses when mixing them, which is good style regardless.

---

## AST Node Design: Frozen POJOs

Every AST node in Seebo is a plain JavaScript object — no class instances, no prototype methods, no getters. The `kind` field is a string discriminant. The parser builds nodes like this:

```js
// A binary expression node
{
  kind: 'Binary',
  position: { start: 0, end: 9 },
  op: '+',
  left:  { kind: 'Lit', position: ..., type: 'int', value: 1 },
  right: { kind: 'Lit', position: ..., type: 'int', value: 2 }
}
```

Why plain objects? Several reasons. First, they are naturally serializable — you can `JSON.stringify` them without any custom logic. Second, they are transparent to any code that receives them: downstream phases (validate, analyze, evaluator) can pattern-match on `kind` without needing to import a class definition. Third, they compose safely: there is no inheritance hierarchy to reason about.

The nodes defined in `src/ast/nodes.js` are documented as JSDoc typedefs rather than classes. The file is a pure contract — no logic, no factories, just type documentation. The `NodeKind` and `ExprKind` objects provide the string constants as frozen records:

```js
export const NodeKind = Object.freeze({
  TEXT: 'Text',
  FORMULA: 'Formula',
  COMMENT: 'Comment',
  MACRO: 'Macro',
});
```

Immutability comes from `Object.freeze`. The parser does not freeze nodes inline (that would add overhead on every node construction), but the semantic contract is that nodes should not be mutated after construction. Any phase that needs to annotate a node creates a new node or stores its annotation elsewhere. The one exception in Seebo's codebase is the `nonExhaustiveMatch` property written onto the outermost ternary of a desugared `match` — a deliberate, documented annotation that the validator reads and every other phase ignores.

---

## The Stable AST Contract and astVersion

The `Document` root node carries an `astVersion` field:

```js
return { astVersion: AST_VERSION, nodes };
```

`AST_VERSION` is imported from `src/util/versions.js` and is currently `1`. This integer exists because the AST is a public contract between the parser and every downstream consumer: the validator, the analyzer, the evaluator, and any external tool that wishes to work with Seebo ASTs.

If a future version of Seebo changes the shape of any node — renames a field, adds or removes a node kind, changes the position format — the `AST_VERSION` must be bumped. A consumer that serializes and stores ASTs (for caching or code generation) can check this version number and know whether its cached AST is still valid.

The same versioning philosophy applies to `STATE_VERSION` (the serialized execution state) and `ANALYSIS_VERSION` (the output of the static analyzer). Each version evolves independently. A migration registry in `src/util/versions.js` provides a path for upgrading older state shapes to the current version, chain-applied step by step.

---

## Source Positions on AST Nodes

Every AST node has a `position` field of shape `{ start: number, end: number }`. These are byte offsets into the original source string. The lexer computes them during tokenization: each token records `start` and `end`, which are the indices of its first and last characters in the input.

The parser propagates positions upward using a `span` helper:

```js
function span(a, b) {
  const start = a.position ? a.position.start : a.start;
  const end   = b.position ? b.position.end   : b.end;
  return { start, end };
}
```

`span` accepts either a token (which has `start`/`end` directly) or a node (which has a `position` object). A binary node's position spans from the start of its left operand to the end of its right operand. A formula node spans from the opening `${` to the closing `}`.

These positions matter for diagnostics. When the validator finds that `a + b` has a type error — say `a` is a datetime and `b` is an int — it can report the position of the `+` node so the error message points to the right place in the template source. When the parser itself encounters an unexpected token, it constructs an error with the token's position, so the SYNTAX_ERROR diagnostic carries a precise location.

---

## Match Desugaring

Seebo's `match` construct provides pattern-matching syntax:

```
${status match {
  'active'  => 'Active',
  'pending' => 'Pending',
  *         => 'Unknown'
}}
```

Downstream phases — the evaluator, the validator, the analyzer — do not need to know about `match`. The parser desugars it into nested ternaries at parse time. This is an example of a source-level transformation that simplifies the rest of the compiler by reducing the number of node kinds that each phase must handle.

The desugaring logic is in `parseMatch`. It collects arms (each a test expression and a result expression) and an optional default `*` arm. It then builds nested ternaries from the bottom up:

```js
let elseExpr = defaultExpr ?? { kind: 'Lit', type: 'string', value: '' };
for (let i = arms.length - 1; i >= 0; i--) {
  const arm = arms[i];
  const cond = {
    kind: 'Binary', op: '==',
    left: subject, right: arm.test,
  };
  elseExpr = {
    kind: 'Ternary',
    cond,
    then: arm.result,
    else: elseExpr,
  };
}
```

The `match` above desugars to:

```
status == 'active'
  ? 'Active'
  : status == 'pending'
      ? 'Pending'
      : 'Unknown'
```

One subtlety: if there is no `*` default arm and the subject is an open domain (integers, strings — any value is possible), the match is not exhaustive. The validator should flag this with `NON_EXHAUSTIVE_MATCH`. But the validator works on the ternary tree; it needs a signal that the ternary came from a `match`. The parser attaches a non-normative property:

```js
if (defaultExpr === null && arms.length > 0 && !coversClosedDomain(arms)) {
  elseExpr.nonExhaustiveMatch = true;
}
```

The `coversClosedDomain` function recognizes one special case: a `bool` match with exactly two arms covering `true` and `false` is provably exhaustive even without `*`, because `bool` has exactly two values. Every other domain — `int`, `string`, enums — is treated as open. This is deliberately conservative: a false positive (flagging a match as non-exhaustive when it logically is) would be annoying; a false negative (missing a non-exhaustive match) would allow a silent empty string at runtime.

---

## Syntax Diagnostics Without Crashing

The parser throws `SeeboError` on malformed input. This is intentional and different from the lexer's error-tolerant design. The lexer can emit `onError` callbacks and continue scanning because lexical errors are local — an unterminated string affects only that token. Parse errors are harder to recover from: if you see `${1 +` without a right operand, the rest of the parse is unpredictable.

The `validate` function wraps `parse` in a try/catch:

```js
try {
  ast = parse(template, cfg);
} catch (e) {
  return [createDiagnostic(
    e instanceof SeeboError ? e.code : DiagnosticCode.SYNTAX_ERROR,
    { message: e.message, position: e.position, ... }
  )];
}
```

So from the user's perspective, a syntax error is just another diagnostic in the list — never an uncaught exception. The `code` on the `SeeboError` tells you what kind of problem occurred (SYNTAX_ERROR, NODE_LIMIT_EXCEEDED, NESTING_LIMIT_EXCEEDED), and the `position` tells you where.

The parser enforces two resource limits to resist hostile input:
- `maxNodes`: total AST node count. Exceeded nodes throw `NODE_LIMIT_EXCEEDED`.
- `maxNestingDepth`: maximum expression nesting. Exceeded depth throws `NESTING_LIMIT_EXCEEDED`. This prevents deeply recursive expressions from causing a JavaScript stack overflow during parsing.

Both limits are tracked through the parse context's `countNode()` and `enter()`/`exit()` calls, called at every node construction and every recursive `parseExpr` entry.

---

## Worked Examples

### Example 1: `1 + 2 * 3`

Tokenized: `NUMBER(1)`, `OPERATOR(+)`, `NUMBER(2)`, `OPERATOR(*)`, `NUMBER(3)`.

`parseExpr(ctx, 0)` calls `parseUnary → parsePostfix → parseAtom`, which consumes `NUMBER(1)` and returns `{ kind:'Lit', type:'int', value:1 }`. Call this `left`.

The loop peeks at `OPERATOR(+)`. Binding 540 >= 0, so it consumes `+` and calls `parseExpr(ctx, 541)` for the right operand.

Inside that recursive call, `parseAtom` consumes `NUMBER(2)`. The loop peeks at `OPERATOR(*)`. Binding 560 >= 541, so it consumes `*` and calls `parseExpr(ctx, 561)`.

That inner call consumes `NUMBER(3)`. The loop finds no more tokens (or the slot close), returns `{ kind:'Lit', type:'int', value:3 }`.

The `*` loop builds `{ kind:'Binary', op:'*', left:Lit(2), right:Lit(3) }` and returns it.

The `+` loop builds `{ kind:'Binary', op:'+', left:Lit(1), right:Binary(*) }` and returns it.

Final AST (simplified):
```
Binary(+)
├── Lit(int, 1)
└── Binary(*)
    ├── Lit(int, 2)
    └── Lit(int, 3)
```

### Example 2: `a ?? b ?: c`

`a` → `Ref('a')`. Loop sees `??` (binding 440 >= 0). Consumes `??`. Recursive call with `minBinding = 440` (right-associative).

Inside that call: `b` → `Ref('b')`. Loop sees `?:` (binding 420 < 440). Yields — returns `Ref('b')`.

Back at `??` level: right operand is `Ref('b')`. Builds `Binary(??, Ref('a'), Ref('b'))`.

Loop sees `?:` (binding 420 >= 0). Consumes `?`. `then = parseExpr(0)` = `Ref('c')`. Expects `:`. `else = parseExpr(420)` = nothing (end of expression). Wait — actually `?:` uses the ternary path in Seebo, which handles `? then : else` as a unit. The condition is `Binary(??, a, b)`, the then branch is parsed, then `:` is consumed, then the else branch is parsed.

Result:
```
Ternary(?:)
├── cond: Binary(??, Ref('a'), Ref('b'))
├── then: Ref('c')
└── else: <whatever follows>
```

This confirms: `a ?? b` binds tighter; the `?:` wraps the whole coalesce.

### Example 3: `require(...)` in a formula slot

```
${ require({ id: 'name', type: string(), capability: 'user', label: 'Your name' }) }
```

The parser sees `SLOT_OPEN($)`, enters `parseSlot`, calls `parseExpr(0)`. `parseAtom` sees `NAME(require)`. `parsePostfix` sees `PAREN('(')`, calls `parseArgs`. The first argument is an object literal `{...}`. The result:

```
Formula {
  expr: Call {
    callee: 'require',
    args: [
      ObjectLit {
        entries: [
          { key: 'id',         value: Lit(string, 'name') },
          { key: 'type',       value: Call { callee: 'string', args: [] } },
          { key: 'capability', value: Lit(string, 'user') },
          { key: 'label',      value: Lit(string, 'Your name') }
        ]
      }
    ]
  }
}
```

The `Call` node with `callee: 'string'` and `args: []` is the type builder expression. The evaluator for symbols (`src/eval/symbols.js`) knows that a zero-argument call to a type name is a builder, not a value, and evaluates it by calling `builder('string').toDescriptor()`.

### Example 4: Document with mixed text and slots

Template: `Dear ${name}, your balance is ${balance}.`

```
Document {
  astVersion: 1,
  nodes: [
    Text  { value: 'Dear ' },
    Formula { expr: Ref { name: 'name' } },
    Text  { value: ', your balance is ' },
    Formula { expr: Ref { name: 'balance' } },
    Text  { value: '.' }
  ]
}
```

The parser interleaves text segments and formula slots in document order. The evaluator later walks this array, concatenating the rendered values of `Formula` nodes with the verbatim text of `Text` nodes.

---

## Conclusion

Seebo's parser is a two-tier design. The outer grammar — documents, slots, macros — is handled by straightforward recursive descent, one function per construct. The expression grammar is handled by Pratt parsing, which assigns binding powers to operators and uses them dynamically to enforce the correct precedence and associativity without an explosion of grammar rules.

AST nodes are typed, frozen POJOs with a stable version contract. Positions flow from lexer tokens through every node so that every error message can be located precisely in the source. The `match` construct is desugared into nested ternaries at parse time, keeping downstream phases simple. Resource limits prevent hostile input from consuming unbounded memory or causing stack overflows. Syntax errors are reported as diagnostics rather than uncaught exceptions, preserving the invariant that well-behaved Seebo APIs never throw at users.

---

## Further Reading

- Vaughan R. Pratt, "Top Down Operator Precedence," POPL 1973. The original paper describing the algorithm.
- Bob Nystrom, *Crafting Interpreters* (craftinginterpreters.com), chapter on Pratt parsing. An accessible modern treatment with worked examples in C and Java.
- Alfred V. Aho, Monica S. Lam, Ravi Sethi, Jeffrey D. Ullman, *Compilers: Principles, Techniques, and Tools* (the Dragon Book), chapters 4 and 5. The definitive reference for context-free grammars, parse tables, and recursive descent.
- `src/parser/parser.js` — the complete Seebo parser, approximately 700 lines, extensively commented.
- `src/ast/nodes.js` — the AST contract, purely declarative JSDoc typedefs with no logic.

---
