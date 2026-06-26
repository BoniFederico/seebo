# Performance

Measurement-first notes for Seebo: how to run the benchmarks, the baseline numbers, the three
hot spots that were profiled, and the optimizations applied (with their rationale). Guiding
rule: **measure first; no micro-optimization that hurts readability without evidence.**

## Running the benchmarks

```bash
npm run bench                      # timings (ms/op, ops/s)
node --expose-gc bench/index.js    # timings + approximate KB/op (heap delta)
```

The runner ([`bench/index.js`](../bench/index.js)) warms up each case (JIT) before timing and
awaits async operations. Fixtures ([`bench/cases.js`](../bench/cases.js)) repeat realistic
blocks to a configurable `scale` (default 120), producing ~15–26 KB templates that exercise the
lexer, parser, evaluator (render), the macro pipeline (`expand`+`run`+`finalize`) and `analyze`.

`KB/op` is a coarse `heapUsed` delta — reliable to an order of magnitude, noisy for sub-ms ops
(GC may run mid-measurement). Treat `ms/op` / `ops/s` as the primary signal.

## Baseline (scale = 120, Node v24)

Representative run, AST cache **off** (the default). Absolute numbers vary by machine/load; the
ratios are what matter.

| Operation               | ms/op | ops/s | KB/op |
| ----------------------- | ----- | ----- | ----- |
| `lexer.tokenize` (text) | 0.245 | 4080  | 2.5   |
| `parser.parse` (exprs)  | 3.78  | 264   | 89.5  |
| `render run()` (cold)   | 2.84  | 352   | 55.8  |
| `analyze()`             | 7.00  | 143   | 135.3 |
| `macro stebo()`         | 4.64  | 216   | 230.9 |

Reading the baseline:

- The **lexer is already fast** and allocation-light (single linear pass, char-code
  classification). It is **not** a bottleneck.
- **Parsing dominates** everything else, and it is re-done on every `render run()` (the v1
  re-evaluation strategy re-parses each pass, IMPL §6.4) and inside `analyze`/`stebo`.
- `analyze` and `stebo` are the heaviest because they parse **and** do extra work.

## Hot spots and what was done

### 1. Lexer scan — _no change (by evidence)_

At ~4080 ops/s on a 20 KB template the lexer is not on the critical path. It already uses
`charCodeAt` for classification and slices the source **only** to capture lexemes (controlled
slicing). Adding char-code comparisons for the two-character operators was considered and
**rejected**: it would trade clarity for no measurable gain on real inputs.

### 2. Parser loop — _cold parse is allocation-bound; the win is not re-parsing_

Cold parsing is ~3.8 ms / ~90 KB per template. That cost is intrinsic to building the AST: one
node object plus one `{start,end}` position per syntactic element — required by the public AST
contract (IMPL §3.1), so it cannot be removed without changing the contract. Two things were
done:

- **Removed `try/finally` from the hottest recursion** (`parseExpr`/`parseUnary`). The nesting
  guard (IMPL §13) decrements depth on the normal return path; a thrown error aborts the whole
  parse, so the counter never needs unwinding. Cleaner code, small/neutral timing.
- **The decisive fix is to avoid re-parsing at all** via the cache below.

### 3. Evaluator step — _eliminate redundant per-pass work_

With parsing removed (cache on), `render run()` becomes evaluator-bound (~0.63 ms for ~480
formulas, ~1.3 µs/formula). The dispatch is already a `switch` on the node `kind` (an effective
jump table), so it was left as is. The real redundancy was elsewhere:

- **Memoized `collectDeclarations` by AST identity** ([`src/eval/symbols.js`](../src/eval/symbols.js)).
  The static declaration scan is a pure function of the AST but was re-run on **every** pass;
  it now runs once per template (a `WeakMap<Document, table>`), which matters for the multi-pass
  conversation loop and templates with many declarations. Safe: the table is read-only.

### Caching parse & analysis (the primary optimization)

IMPL §11/§6.1 sanction memoizing `parse`/`analyze` by template (the `astRef` pattern), and
IMPL §12.1 makes `astCache` an **opt-in** flag (default off, per clarifications §3 — so default
behaviour and all tests are unchanged). When `optimizations.astCache` is enabled:

- [`src/parser/index.js`](../src/parser/index.js) memoizes the AST per `(config, template)` —
  a `WeakMap` keyed by the config object identity (collected with the engine, never mixing
  vocabularies/delimiters) then a bounded `Map` by template string.
- [`src/analyze/analyze.js`](../src/analyze/analyze.js) memoizes the `Analysis` the same way.

Both are **transparent**: the result is a pure function of `(config, template)`, returned
read-only, so output is identical to the uncached path (locked by
[`test/unit/cache.test.js`](../test/unit/cache.test.js)).

`finalize` already short-circuits: it scans for the macro sigil once and returns immediately
when no layout marker is present (the common case), so no extra cache was warranted there.

## Results with `astCache` on

Same run, AST cache enabled. Cacheable operations collapse to a lookup; `render`/`stebo` keep
only their irreducible work (evaluation, output building, macro post-processing).

| Operation       | default ms/op | +astCache ms/op | speed-up |
| --------------- | ------------- | --------------- | -------- |
| `parser.parse`  | 3.78          | 0.0005          | ~3000×   |
| `render run()`  | 2.84          | 0.63            | ~4.5×    |
| `analyze()`     | 7.00          | 0.0009          | ~3000×   |
| `macro stebo()` | 4.64          | 0.68            | ~6.8×    |

When to enable it: long-lived engines that render the **same** templates repeatedly (server-side
rendering, the multi-phase conversation loop, an editor re-analyzing on each keystroke). For
one-shot parses of ever-changing source it adds only a `WeakMap`/`Map` write.

## Summary of changes

- `bench/` — runnable, warmed-up benchmark with timing and (opt-in) allocation estimate.
- Parse cache + analysis cache, opt-in via `optimizations.astCache` (transparent, IMPL §11/§12.1).
- Memoized `collectDeclarations` by AST identity (removes redundant per-pass scanning).
- Removed `try/finally` from the hottest parser recursion (clarity; nesting guard preserved).
- Deliberately **left the lexer and the evaluator dispatch unchanged** — measurement showed no
  bottleneck there, and changes would have cost readability for no gain.

All existing tests pass unchanged; the cache's transparency is covered by dedicated tests.
