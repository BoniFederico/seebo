# Lexical Analysis: Tokenizing a Mixed-Content Language

## Table of Contents

1. [What Lexing Is](#what-lexing-is)
2. [The Challenge of Mixed-Content Languages](#the-challenge-of-mixed-content-languages)
3. [Seebo's Token Types](#seebos-token-types)
4. [The O(n) Linear Pass](#the-on-linear-pass)
5. [Delimiter Configuration](#delimiter-configuration)
6. [Escaping: Literal Sigils in Text](#escaping-literal-sigils-in-text)
7. [String Literals and Brace Tracking](#string-literals-and-brace-tracking)
8. [Error-Tolerant Tokenization](#error-tolerant-tokenization)
9. [Source Positions: Byte Offsets as the Normative Coordinate](#source-positions-byte-offsets-as-the-normative-coordinate)
10. [Optional Line/Column Enrichment](#optional-linecolumn-enrichment)
11. [How Source Positions Enable Editor Integration](#how-source-positions-enable-editor-integration)
12. [The Finite-State Scanning Model](#the-finite-state-scanning-model)
13. [Why Regex-Only Lexers Become Fragile](#why-regex-only-lexers-become-fragile)
14. [Worked Examples](#worked-examples)
    - [Plain Text](#plain-text)
    - [Formula Slot](#formula-slot)
    - [Macro Slot](#macro-slot)
    - [Escaped Delimiter](#escaped-delimiter)
    - [Malformed / Unclosed Slot](#malformed--unclosed-slot)
15. [Conclusion](#conclusion)
16. [Further Reading](#further-reading)

---

## What Lexing Is

Lexical analysis — lexing, or scanning — is the first transformation in the compilation pipeline. Its job is to convert a raw string of characters into a sequence of tokens.

A token is a named unit of meaning in the source language. Where the raw string has characters, the token stream has units: "this is an integer literal," "this is the open brace of a slot," "this is an identifier," "this is the keyword `and`." Tokens carry their kind, their text, and their position in the source. Downstream phases — the parser, the validator, the analyzer — consume tokens rather than raw characters.

Separating lexical analysis from parsing is a classical choice in compiler design, and it is justified by the separation of concerns. The parser needs to know that a token is "an integer literal" without needing to know which characters encode that literal. The lexer knows which characters encode which tokens without needing to know what syntactic role those tokens play. The two concerns are orthogonal, and keeping them in separate modules keeps each one tractable.

For Seebo specifically, the lexer is also the layer that handles the mixed-content nature of templates: the coexistence of arbitrary text with embedded expression syntax. This is the hardest part of the lexer's job, and understanding it requires understanding what "mixed-content" means.

---

## The Challenge of Mixed-Content Languages

An ordinary programming language source file consists entirely of code. Every character is part of the language. The lexer's job is to classify sequences of characters into tokens: identifiers, keywords, operators, literals, comments.

A template language is different. Most characters in a template are literal text that should be copied verbatim to the output. Only certain delimited regions contain language syntax. The lexer must therefore alternate between two modes: a "text mode" where characters are copied as-is, and a "code mode" where characters are parsed as expression syntax.

This is simpler than it sounds for a fixed delimiter, but the simplicity is somewhat illusory. Consider a template that contains `${` in its text — for example, a template that generates JavaScript code or shell scripts:

```
# Generated shell script
export DB_URL="${{ DB_HOST }}:5432/${{ DB_NAME }}"
```

If `${` is the slot delimiter, the lexer would incorrectly interpret `"${` in the shell script as the beginning of a Seebo formula slot. The standard resolution is either escaping (`\${`) or configurable delimiters. Seebo supports both.

A second challenge of mixed-content lexing is that the code inside a slot may contain characters that resemble the close delimiter. In Seebo, a formula slot is closed by `}`. But object literals in expressions also contain `}`:

```
${ { name: 'Alice', score: 42 } }
```

The first `}` closes the object literal, not the slot. The lexer must know this. The solution is brace-depth tracking: the lexer counts open `{` and close `}` characters inside a slot, treating only a `}` at depth zero as the slot closer.

A third challenge is that string literals inside slots may contain characters that would otherwise have special meaning. The string `'hello}'` contains a `}`, but that `}` should not close the slot. The lexer must therefore scan string literals as atomic units, consuming characters until the closing quote, without treating their contents as slot structure.

These three problems — delimiter collision, nested braces, and string literals — make mixed-content lexing more complex than either plain-text lexing or code-only lexing. Seebo's lexer addresses all three.

---

## Seebo's Token Types

The full set of token types recognized by Seebo's lexer is defined in `src/lexer/tokens.js` as the `TokenType` frozen object:

```javascript
export const TokenType = Object.freeze({
  TEXT: 'text',          // verbatim text between slots
  SLOT_OPEN: 'slot-open', // ${ or #{ or @{ (the sigil + open brace)
  SLOT_CLOSE: 'slot-close', // } closing a slot
  SIGIL: 'sigil',         // reserved (not currently emitted)
  NAME: 'name',           // identifier reference (e.g., customer_name)
  METHOD: 'method',       // identifier after a dot (e.g., .upper in name.upper())
  NUMBER: 'number',       // integer or float literal
  STRING: 'string',       // single-quoted string literal
  BOOL: 'bool',           // true or false
  OPERATOR: 'operator',   // any infix or prefix operator
  DOT: 'dot',             // . member access
  COMMA: 'comma',         // ,
  PAREN: 'paren',         // ( or )
  BRACKET: 'bracket',     // [ or ]
  BRACE: 'brace',         // { or } inside a slot (not the slot closer)
  ARROW: 'arrow',         // => (match arm separator)
  STAR: 'star',           // * as the match default arm (not multiplication)
  COMMENT_BODY: 'comment-body', // text content inside a #{ } comment slot
  MACRO_NAME: 'macro-name',     // the name in a @{ MACRO_NAME } macro slot
});
```

These token types are the stable public contract between the lexer and the parser. The string values (`'text'`, `'slot-open'`, etc.) are used as the `kind` field of each token and appear in diagnostics and editor tooling output. They are chosen to be human-readable for debugging.

Several design choices are embedded in this list.

`SLOT_OPEN` encodes both the sigil and the open brace as a single two-character token. The parser can determine which kind of slot opened (formula, comment, or macro) by reading the first character of the lexeme at `token.start` from the source string. This avoids splitting the sigil into a separate `SIGIL` token (which is defined but not used in v1).

`METHOD` is distinct from `NAME` even though both are identifiers. The distinction allows the parser to look up a name's role without re-reading the preceding context: if the previous token was `DOT`, the current identifier is a method; otherwise it is a name. The lexer tracks the previously emitted kind and makes this classification directly.

`BOOL` is distinct from `NAME`. `true` and `false` are always classified as boolean literals, never as names. This avoids the need for the parser to check whether a `NAME` token has the value `'true'` or `'false'`.

`OPERATOR` covers all operators (both word-form like `and`, `or`, `not`, `in`, `match` and symbol-form like `+`, `-`, `==`, `!=`). The parser distinguishes them by reading the lexeme.

`STAR` is `*` when the lexer determines that the next non-whitespace token is `=>` (making `*` the match default arm), or `OPERATOR` otherwise (making `*` multiplication). The lexer implements this lookahead with a small helper that scans forward past whitespace:

```javascript
function starOrOperator(from) {
  let j = from;
  while (j < n && isSpace(input.charCodeAt(j))) j++;
  return input[j] === '=' && input[j + 1] === '>' ? TokenType.STAR : TokenType.OPERATOR;
}
```

---

## The O(n) Linear Pass

The Seebo lexer processes the input string exactly once, left to right, without backtracking. This gives it O(n) time complexity: the work done is proportional to the length of the input, with a small constant factor.

The linear pass is implemented with a single integer cursor `i` that tracks the current position in the string. The outer loop alternates between two phases:

**Text phase**: the cursor advances until it either reaches the end of the string or encounters a sigil character (`$`, `#`, `@`) followed by the open brace. Any characters passed over become a `TEXT` token.

**Slot phase**: the cursor reads the slot, producing tokens for each syntactic element inside it, until it encounters the close brace at depth zero.

Within the slot phase, the lexer uses character code comparisons for classification rather than regular expressions:

```javascript
const isDigit = (c) => c >= 48 && c <= 57;
const isIdentStart = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isIdentChar = (c) => isIdentStart(c) || isDigit(c);
const isSpace = (c) => c === 32 || c === 9 || c === 10 || c === 13;
```

Character code comparisons are faster than regex matching for single-character decisions because they avoid the overhead of regex engine initialization and matching. They also avoid allocation: no temporary strings are created for each character. The `charCodeAt` method returns a small integer, and integer comparison is among the cheapest operations in any JavaScript engine.

The resulting lexer is allocation-efficient: it creates only `Token` objects (plain `{ kind, start, end }` objects) and no temporary strings except for the occasional short-lookahead operations (`input.slice(i, i+2)` for two-character operators). For a typical template, the number of tokens is small relative to the input size, and the constant factor in the O(n) complexity is correspondingly small.

---

## Delimiter Configuration

The default delimiters are:
```javascript
const DEFAULT_DELIMITERS = {
  formula: '$',
  comment: '#',
  macro: '@',
  open: '{',
  close: '}'
};
```

These can be overridden through the engine's `delimiters` option:

```javascript
const engine = createEngine({
  delimiters: {
    formula: '%',
    open: '(',
    close: ')'
  }
});
// Slots now look like: %( expression )
```

The delimiter configuration is propagated to the lexer through the `options` object. The lexer resolves the effective delimiters at the start of `tokenize`:

```javascript
export function tokenize(input, options = {}) {
  const d = { ...DEFAULT_DELIMITERS, ...(options.delimiters ?? {}) };
  // ...
  const sigilFormula = d.formula;
  const sigilMacro = d.macro;
  const open = d.open;
  const close = d.close;
  const isSigil = (ch) => ch === sigilFormula || ch === sigilComment || ch === sigilMacro;
  // ...
}
```

Delimiter configuration is useful when the default delimiters (`${`, `}`) conflict with the host document format. Templates that embed JavaScript code, shell scripts, or other languages that use `${}` natively should use a non-conflicting delimiter set.

Note that the sigils and brackets are configured independently. You can keep `$` as the formula sigil but change the brackets to `(` and `)`, or keep the brackets as `{` and `}` but change the formula sigil to `%`. This flexibility accommodates a wide range of host document formats without requiring the template author to escape every occurrence of the default delimiter.

---

## Escaping: Literal Sigils in Text

Even with configurable delimiters, there are cases where the text portion of a template needs to contain the sigil+open sequence literally. Seebo handles this with backslash escaping:

- `\${` in text produces `${` in the output
- `\#{` in text produces `#{` in the output
- `\@{` in text produces `@{` in the output

The lexer handles this at the character level in the text phase:

```javascript
// Escaped sigil: `\` + sigil + open → literal text (do not open a slot).
if (c === '\\' && isSigil(input[i + 1]) && input[i + 2] === open) {
  i += 3;
  continue;
}
```

When the lexer sees `\` followed by a sigil character followed by the open brace, it advances three characters and continues in text mode. The `\`, the sigil, and the open brace all become part of the current `TEXT` token.

The parser then unescapes the text when building `Text` AST nodes:

```javascript
function unescapeText(raw, d) {
  const cls = [d.formula, d.comment, d.macro].map(escapeRegExp).join('');
  const re = new RegExp(`\\\\([${cls}])${escapeRegExp(d.open)}`, 'g');
  return raw.replace(re, `$1${d.open}`);
}
```

This regex removes the `\` character, leaving just the sigil and the open brace. The escaping is transparent: the output string looks as if the sigil+open sequence was always present without the backslash.

It is worth noting that only `\${`, `\#{`, and `\@{` are treated as escape sequences. A lone `\` in the text is passed through literally. Seebo does not implement a general backslash escaping scheme for the text portions of templates; only the specific sequences that would otherwise open a slot are affected.

---

## String Literals and Brace Tracking

Inside a formula slot, two mechanisms ensure that the slot is not prematurely closed.

**String literal scanning**: When the lexer encounters a single quote inside a slot, it switches to string-scanning mode and reads characters until the closing single quote. The `}` character inside a string literal is treated as literal text, not as the slot closer:

```javascript
if (c === "'") {
  const s = i;
  i++;
  let terminated = false;
  while (i < n) {
    if (input[i] === '\\') {
      i += 2;  // skip escaped character
      continue;
    }
    if (input[i] === "'") {
      i++;
      terminated = true;
      break;
    }
    i++;
  }
  if (!terminated) report('unterminated string literal', s, n);
  emit(TokenType.STRING, s, i);
  continue;
}
```

The string literal becomes a single `STRING` token spanning from the opening single quote to the closing single quote inclusive.

**Brace depth tracking**: The lexer maintains a `braceDepth` counter inside each slot. When it encounters `{` (the open brace character), it emits a `BRACE` token and increments the counter. When it encounters `}` (the close brace character), it checks the counter:
- If `braceDepth > 0`: this `}` closes a nested brace, not the slot. Emit a `BRACE` token and decrement the counter.
- If `braceDepth === 0`: this `}` closes the slot. Emit a `SLOT_CLOSE` token and return.

```javascript
if (c === close && braceDepth === 0) {
  emit(TokenType.SLOT_CLOSE, i, i + 1);
  return i + 1;
}
// ...
if (c === open) {
  braceDepth++;
  emit(TokenType.BRACE, i, i + 1);
  i++;
  continue;
}
if (c === close) {
  braceDepth--;
  emit(TokenType.BRACE, i, i + 1);
  i++;
  continue;
}
```

Together, string literal scanning and brace depth tracking ensure that the slot closer `}` is always found at the right position, regardless of the complexity of the expression inside the slot.

---

## Error-Tolerant Tokenization

The Seebo lexer never throws. Errors are reported through an optional `onError` callback and scanning continues.

The error types the lexer can report:
- **Unterminated string literal**: the single-quote scan reached the end of the string without finding a closing quote
- **Unterminated slot**: the slot scan reached the end of the string without finding the close brace at depth zero
- **Unterminated comment slot**: the comment scan reached the end of the string without finding the close brace
- **Unexpected character**: a character was encountered inside a slot that does not begin any valid token

Each error is reported as a `Diagnostic` with code `SYNTAX_ERROR`, a `recoverable: true` flag, and a `position` covering the problematic range. The `recoverable` flag indicates that the lexer continued scanning after the error, so there may be additional diagnostics.

Error tolerance is important for editor tooling. An editor that provides syntax highlighting, completions, and inline diagnostics for Seebo templates cannot require the template to be syntactically perfect before highlighting begins. The user is in the middle of typing. The template is incomplete. The lexer must produce the best token stream it can from whatever characters are present.

The practical implementation of error recovery is conservative: when the lexer encounters an unterminated slot, it reports the error and stops scanning that slot. When it encounters an unexpected character, it reports the error and skips the character. In both cases, subsequent tokens may be misclassified (a token that would have been inside the unterminated slot may now be treated as part of text context), but some meaningful token stream is better than none.

---

## Source Positions: Byte Offsets as the Normative Coordinate

Every token produced by the lexer carries `start` and `end` offsets: the position of the first character of the token and the position just past the last character. These are measured in characters from the beginning of the template string.

The design decision to use character offsets (rather than line and column numbers) as the normative position representation is deliberate and documented in the token contract:

```
/**
 * Only `start`/`end` offsets are normative. `line`/`column` metadata is optional,
 * derived from offsets, and provided solely for diagnostics/editor convenience.
 *
 * `start`/`end` are absolute offsets into the template source — the only fields
 * required by tokens, AST nodes, diagnostics, internal source maps and the
 * conformance tests.
 */
```

The reasoning is straightforward. Character offsets are:
1. **Derivable from the source**: given a source string and a character offset, you can always compute the line and column by scanning the string.
2. **Stable under encoding changes**: offsets in characters do not change if the line ending convention changes (CR, LF, CRLF), whereas line numbers and column numbers do.
3. **Cheap to compute**: the lexer accumulates `i` as it scans; `i` is already the character offset.
4. **Unambiguous**: there is exactly one character offset for each position in the string. Line and column numbers have edge cases (tabs, multibyte Unicode, CRLFs).

Line and column numbers are useful for human-readable diagnostics ("error at line 12, column 5") but they are a derived coordinate, not a primary one. They are computed on demand from character offsets when the `locations: true` option is passed to `tokenize`.

The AST nodes produced by the parser also carry `{ start, end }` positions derived from the positions of the tokens that formed them. The `span(a, b)` helper in the parser computes a position covering from the start of `a` to the end of `b`:

```javascript
function span(a, b) {
  const start = a.position ? a.position.start : a.start;
  const end = b.position ? b.position.end : b.end;
  return { start, end };
}
```

This gives every AST node a precise byte range in the source, enabling accurate error reporting and source-map generation.

---

## Optional Line/Column Enrichment

When the lexer is called with `options.locations: true`, it attaches richer position metadata to each token after the scan completes:

```javascript
if (options.locations) attachLocations(input, tokens);
return tokens;
```

`attachLocations` is called after the main scan, not during it. This separation keeps the hot path (the scan itself) free of line-tracking overhead. Line and column numbers are only computed when explicitly requested.

The implementation precomputes an array of line start positions:

```javascript
function attachLocations(input, tokens) {
  const lineStarts = [0];
  for (let i = 0; i < input.length; i++) {
    if (input.charCodeAt(i) === CH_LF) lineStarts.push(i + 1);
  }
  for (const t of tokens) {
    const { line, column } = lineColAt(lineStarts, t.start);
    t.position = { start: t.start, end: t.end, line, column };
  }
}
```

The `lineStarts` array records the character offset at which each line begins: `lineStarts[0] = 0` (line 1 starts at offset 0), `lineStarts[1] = 10` (line 2 starts at offset 10 if the first newline is at offset 9), and so on.

Given `lineStarts`, the line and column of any offset are found by binary search:

```javascript
function lineColAt(lineStarts, offset) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - lineStarts[lo] + 1 };
}
```

The binary search has O(log n) complexity in the number of lines. For a template with k tokens and m lines, the total cost of `attachLocations` is O(n) for building `lineStarts` plus O(k log m) for the binary searches. In practice, with typical templates (hundreds of tokens, tens of lines), this is negligible.

The `position` field attached by `attachLocations` carries `{ start, end, line, column }`, where `start` and `end` remain the normative character offsets and `line`/`column` are the derived, non-normative display values.

---

## How Source Positions Enable Editor Integration

An editor integration for Seebo templates needs to be able to answer questions like:
- "What symbol is at the cursor position?"
- "What is the range of the current token, for highlighting?"
- "Where does the expression starting at position 42 end?"
- "What diagnostic covers position 87, and what is its message?"

All of these questions can be answered using character offsets. Given an editor cursor at character offset `p`, you can find the token that spans `p` by binary-searching the token array for a token with `start <= p < end`. The token's `kind` tells you the symbol class. The token's `[start, end)` range is the range to highlight.

Diagnostics also carry `{ start, end }` positions, so underlines and hover tooltips can be positioned accurately.

This coordinate system works without needing line/column numbers from the lexer. The editor already knows the mapping from display coordinates to character offsets (it is the editor's own line-wrapping and rendering logic). Seebo provides character offsets; the editor converts them to display coordinates.

If the editor wants line/column numbers in its user interface (for a status bar showing "Ln 12, Col 5"), it can request `locations: true` when calling `engine.tokenize`, or it can compute line/column from character offsets using the same algorithm that `attachLocations` uses.

---

## The Finite-State Scanning Model

The lexer's behavior can be described as a finite-state machine with two main states and a few sub-states.

**State: TEXT_CONTEXT.** The scanner is reading verbatim text. It advances one character at a time. On `\` + sigil + open brace, it advances three characters and stays in TEXT_CONTEXT. On sigil + open brace, it emits a TEXT token (if the current text accumulator is non-empty), emits a SLOT_OPEN token, and transitions to SLOT_CONTEXT. On end of input, it emits a TEXT token and halts.

**State: SLOT_CONTEXT.** The scanner is inside a slot. It dispatches on the current character class:
- Whitespace: skip, stay in SLOT_CONTEXT
- `'` (single quote): enter STRING_CONTEXT
- Digit: scan a number literal, emit NUMBER, stay in SLOT_CONTEXT
- Identifier start: scan an identifier, classify as NAME/METHOD/BOOL/OPERATOR/MACRO_NAME, emit, stay in SLOT_CONTEXT
- `.`: emit DOT, stay in SLOT_CONTEXT
- `,`: emit COMMA, stay in SLOT_CONTEXT
- `(`, `)`: emit PAREN, stay in SLOT_CONTEXT
- `[`, `]`: emit BRACKET, stay in SLOT_CONTEXT
- `{` (open brace): increment depth, emit BRACE, stay in SLOT_CONTEXT
- `}` (close brace, depth > 0): decrement depth, emit BRACE, stay in SLOT_CONTEXT
- `}` (close brace, depth = 0): emit SLOT_CLOSE, transition to TEXT_CONTEXT
- Two-character operator: emit OPERATOR or ARROW, stay in SLOT_CONTEXT
- `*`: classify as STAR or OPERATOR (by lookahead), emit, stay in SLOT_CONTEXT
- Single-character operator: emit OPERATOR, stay in SLOT_CONTEXT
- Other: report error, skip, stay in SLOT_CONTEXT
- End of input: report unterminated-slot error, halt

**State: STRING_CONTEXT** (sub-state of SLOT_CONTEXT). The scanner is inside a string literal. It advances one character at a time. On `\\`, it advances two characters. On `'`, it emits a STRING token and returns to SLOT_CONTEXT. On end of input, it reports an unterminated-string error and emits a STRING token covering what was scanned.

**State: COMMENT_SLOT_CONTEXT** (entered when the sigil is `#`). The scanner reads the comment body, tracking brace depth. On the close brace at depth zero, it emits COMMENT_BODY and SLOT_CLOSE and returns to TEXT_CONTEXT. On end of input, it reports an error.

This state machine is implicit in the code — there is no explicit state variable or state transition table — but the structure is there. Each `while` loop in the lexer corresponds to a state. Each `break`, `continue`, or `return` corresponds to a state transition.

---

## Why Regex-Only Lexers Become Fragile

A tempting alternative implementation uses regular expressions for everything:

```javascript
const TOKEN_PATTERN = /(\$\{)|(\})|([a-zA-Z_][a-zA-Z0-9_]*)|(\d+(?:\.\d+)?)|('[^']*')|(\+|-|\*|\/|==|!=|<=|>=|<|>|\?|:|,|\.|;)/g;
```

This approach works for simple expression-only languages. It fails for mixed-content templates for several reasons.

**Mode-switching.** A regex-only lexer has no notion of "text mode" and "code mode." The pattern above would match `${` as a slot opener but could not represent "everything from here to the next `${` is text." You would need to split the input on slot delimiters first, then lex each segment, which is a two-pass approach and loses the precise positions of slot boundaries relative to the original input.

**Brace tracking.** Regular expressions are not well-suited to counting balanced delimiters. A regex that matches "from `${` to the matching `}`" for nested braces would need to be non-regular (context-sensitive), which means either a recursive descent approach or a hack using lookahead and recursion extensions that are not available in standard JavaScript regex.

**String literal boundaries.** A pattern like `'[^']*'` (string literal) fails on `'O\'Brien'` (escaped quote inside the literal). A correct pattern requires handling the escape sequence, which complicates the regex and makes it harder to read.

**Error recovery.** A regex-based lexer that encounters an unexpected character has limited options: it can skip the character (losing position accuracy) or fail entirely (not error-tolerant). An imperative scanner can report the specific error, record the precise position, skip exactly one character, and continue scanning with full awareness of the state.

**Performance.** A single large regex with many alternatives has a complex matching algorithm. The lexer that uses integer character-code comparisons and simple arithmetic is more predictable and typically faster for common cases.

Seebo's lexer is imperative because the problem it solves requires more than a finite automaton with a single regex. The explicit control flow gives it the flexibility to handle all the edge cases of mixed-content tokenization.

---

## Worked Examples

### Plain Text

Input: `Hello, world!`

Token stream:
```
{ kind: 'text', start: 0, end: 13 }
```

The entire input is a single `TEXT` token, because no sigil+open sequence appears.

### Formula Slot

Input: `${ name.upper() }`

Token stream:
```
{ kind: 'slot-open',  start: 0, end: 2  }   // ${
{ kind: 'name',       start: 3, end: 7  }   // name
{ kind: 'dot',        start: 7, end: 8  }   // .
{ kind: 'method',     start: 8, end: 13 }   // upper
{ kind: 'paren',      start: 13, end: 14 }  // (
{ kind: 'paren',      start: 14, end: 15 }  // )
{ kind: 'slot-close', start: 16, end: 17 }  // }
```

Note that the `name` token has kind `'name'` (a reference to a declared name), and the `upper` token has kind `'method'` (an identifier after a dot). The lexer made this classification by tracking that the previous emitted token was `DOT`.

### Macro Slot

Input: `@{ REMOVE_LINE }`

Token stream:
```
{ kind: 'slot-open',   start: 0, end: 2  }   // @{
{ kind: 'macro-name',  start: 3, end: 14 }   // REMOVE_LINE
{ kind: 'slot-close',  start: 15, end: 16 }  // }
```

The `REMOVE_LINE` identifier has kind `'macro-name'` because the lexer set `macroNamePending = true` when it saw the `@` sigil. The very first identifier inside a macro slot is always classified as `'macro-name'`.

### Escaped Delimiter

Input: `Use \${ for template literals.`

Token stream:
```
{ kind: 'text', start: 0, end: 30 }
```

The `\${` sequence is recognized as an escape and the lexer advances three characters. The entire input, including the `\`, `$`, and `{` characters, becomes part of the `TEXT` token. The parser's `unescapeText` function later removes the `\`, yielding the final text `Use ${ for template literals.`

### Malformed / Unclosed Slot

Input: `Hello, ${ name + ` (truncated, no closing `}`)

Token stream:
```
{ kind: 'text',      start: 0, end: 7  }   // Hello, 
{ kind: 'slot-open', start: 7, end: 9  }   // ${
{ kind: 'name',      start: 10, end: 14 }  // name
{ kind: 'operator',  start: 15, end: 16 }  // +
```

After the `+`, the lexer reaches the end of the string. It reports an error via `onError` (if provided): `"unterminated slot: expected '}'"` with position `{ start: 7, end: <end of input> }`. No `SLOT_CLOSE` token is emitted. The token stream is incomplete but contains everything that was lexed successfully.

---

## Conclusion

Lexical analysis is the foundation of the Seebo pipeline. The lexer's O(n) linear scan, error-tolerant design, brace-depth tracking, string-literal handling, and delimiter configuration make it capable of handling the full complexity of mixed-content templates.

The decision to use character offsets as the normative position coordinate — with line and column numbers as optional, derived enrichment — is a deliberate choice that simplifies the lexer's hot path and makes positions composable across all pipeline stages.

The token stream produced by the lexer is the complete interface between raw source text and all subsequent phases. Nothing in the parser, validator, or evaluator reads from the original string directly; everything goes through tokens and the `source.slice(token.start, token.end)` accessor.

The next article examines what the parser does with this token stream: how it builds a frozen AST using recursive descent at the document level and Pratt precedence climbing at the expression level, and how it handles desugaring, resource limits, and capability sugar.

---

## Further Reading

- Aho, A.V., Lam, M.S., Sethi, R., & Ullman, J.D. (2006). *Compilers: Principles, Techniques, and Tools* (2nd ed.). Addison-Wesley. Chapter 3: Lexical Analysis. — The textbook treatment of lexical analysis, including finite automata, regular expressions, and the construction of deterministic automata from regular expressions.
- Thompson, K. (1968). "Regular Expression Search Algorithm." *Communications of the ACM*, 11(6). — The paper that introduced the NFA simulation approach to regex matching, which is the theoretical basis for understanding why regex-based lexers behave as they do.
- Russ Cox, "Regular Expression Matching Can Be Simple And Fast," https://swtch.com/~rsc/regexp/regexp1.html — A practical explanation of the performance characteristics of different regex implementations; relevant to understanding why Seebo's hand-coded character comparisons are faster than a regex-based lexer for this problem.
- Unicode Consortium (2024). *The Unicode Standard.* — The reference for character encoding; relevant to understanding why Seebo uses character offsets (JavaScript's string indices) rather than byte offsets as the normative coordinate.
