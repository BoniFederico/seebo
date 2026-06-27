# Performance Engineering: Measuring, Understanding, and Optimizing an Engine

## Table of Contents

1. [The Philosophy: Measure Before You Optimize](#1-the-philosophy-measure-before-you-optimize)
2. [Benchmark Design](#2-benchmark-design)
3. [Baseline Results: Walking Through the Numbers](#3-baseline-results-walking-through-the-numbers)
4. [Memory Allocation and Frozen Objects](#4-memory-allocation-and-frozen-objects)
5. [Hot Paths Identified](#5-hot-paths-identified)
6. [The astCache Optimization](#6-the-astcache-optimization)
7. [Benchmark Results With Caching](#7-benchmark-results-with-caching)
8. [Deliberate Non-Optimizations](#8-deliberate-non-optimizations)
9. [Big-O Analysis](#9-big-o-analysis)
10. [Interpreting Numbers for Real Workloads](#10-interpreting-numbers-for-real-workloads)
11. [Conclusion](#conclusion)
12. [Further Reading](#further-reading)

---

## 1. The Philosophy: Measure Before You Optimize

The most common performance mistake in software development is optimizing before measuring. The developer has an intuition about which part of the system is slow, acts on that intuition, discovers later that the slow part was elsewhere, and has now added complexity for no benefit. The second most common mistake is measuring the wrong thing: benchmarking an isolated function that is not on any hot path, or benchmarking with a workload that does not represent real usage.

Seebo's performance approach is governed by two principles. First, no optimization is added without a benchmark that demonstrates it improves the measured case. Second, every optimization must be transparent to the caller — enabling it must not change any observable behavior, only performance. The astCache is the canonical example: `engine.parse(template)` with cache enabled must return a structurally identical AST to `engine.parse(template)` without cache. The test suite verifies this explicitly.

A third principle, less obvious: not every bottleneck should be optimized. Sometimes the correct response to a benchmark result is to document it, note that it is acceptable for the expected workload, and move on. Premature optimization is the root of much complexity in software systems. The deliberate non-optimizations section below explains what was chosen not to optimize and why.

---

## 2. Benchmark Design

A good benchmark for a template engine must satisfy several properties that are easy to violate.

### Representativeness

The benchmark template must be representative of real workloads, not a trivial case (which would optimize for the fast path) or a pathological case (which would optimize for adversarial inputs). A template with one formula is not representative. A template with 10,000 formulas is pathological. The Seebo benchmark uses a `scale` parameter that controls how many formulas and text segments appear in the template. At `scale=120`, the generated template is approximately 20KB — typical for an email template or a structured document with many conditional sections.

### Phase isolation

A full `stebo()` call exercises every phase: expand, parse, evaluate, finalize. But if the parser is the bottleneck, a benchmark of the full pipeline obscures that. Seebo benchmarks each phase independently:

- **Lexer only** (`lexer.tokenize`): measures the cost of converting the template string to a token array.
- **Parser only** (`parser.parse`): measures the cost of converting the token array to an AST, including the lexing step that precedes it.
- **Evaluation only** (`render run() cold`): measures the cost of a full `run()` call, which includes parsing and evaluation.
- **Analysis** (`analyze()`): measures the cost of static analysis, including parsing and the graph computation.
- **Full pipeline** (`macro stebo()`): measures the cost of expand + drive + finalize.

### Warmup and statistical stability

JavaScript engines (V8) use tiered compilation: functions start in the interpreter, are compiled by the baseline JIT after a few calls, and compiled by the optimizing JIT after many calls. A benchmark that runs only one iteration measures the interpreter, not the JIT-compiled code. Seebo benchmarks include warmup iterations to reach JIT-compiled steady state before measuring. Multiple iterations are then run and averaged to reduce noise from GC pauses and other system events.

### Cache state

Benchmarks are run both with `optimizations.astCache: false` (cold) and `optimizations.astCache: true` (warm). Cold benchmarks represent the first-call case. Warm benchmarks represent repeated calls with the same template, which is the common case for a template hub where the same templates are rendered many times.

---

## 3. Baseline Results: Walking Through the Numbers

All measurements are taken on Node v24 with `scale=120` (approximately 20KB templates).

| Operation | ms/op | ops/s | KB/op |
|-----------|-------|-------|-------|
| lexer.tokenize | 0.245 | 4,080 | 2.5 |
| parser.parse | 3.78 | 264 | 89.5 |
| render run() cold | 2.84 | 352 | 55.8 |
| analyze() | 7.00 | 143 | 135.3 |
| macro stebo() | 4.64 | 216 | 230.9 |

### The lexer: 0.245ms/op, 4,080 ops/s

The lexer is fast because it is algorithmically simple. It makes a single linear pass over the input. Every decision is made on the current character code: is this a sigil? Is this an open brace? Is this whitespace? Character code comparisons are cheaper than regular expression matches because they avoid the regex engine's overhead. The lexer uses `charCodeAt()` comparisons:

```js
const isDigit = (c) => c >= 48 && c <= 57;
const isIdentStart = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
```

These are trivially inlineable by V8. The lexer produces minimal objects — `{ kind, start, end }` tuples, three fields each — and nothing is allocated for text outside of slots. At 4,080 ops/s, the lexer is not the bottleneck for any reasonable workload.

### The parser: 3.78ms/op, 264 ops/s

The parser is the primary bottleneck. At 3.78ms per parse of a 20KB template, parsing is roughly 15 times slower than lexing and about 33% slower than a full evaluation run. This is expected for a Pratt parser: precedence climbing requires a call-stack frame per precedence level, and complex expressions produce many object allocations.

Every node in the AST is a plain JavaScript object with `kind`, `position`, and type-specific fields. Each call to a node constructor allocates. For a 20KB template with many formulas and nested expressions, the number of allocations is substantial — and they all reach the young generation of V8's garbage collector. The benchmark reports 89.5 KB allocated per parse, which is the heap footprint of the produced AST.

This is the correct place to focus optimization effort.

### run() cold: 2.84ms/op, 352 ops/s

A full `run()` call includes parsing. The 2.84ms cold cost is slightly less than the 3.78ms parse cost because the benchmark numbers include a warmup effect — by the time the evaluation phase runs, the JIT has compiled the hot evaluator dispatch path. The 55.8 KB/op figure reflects the value objects allocated during evaluation. These are smaller than the AST because the evaluator reuses the parsed AST (within one call) and only allocates for intermediate `Value` records.

The fact that `run()` cold is faster than `parser.parse` alone in the table might seem contradictory. The difference is measurement methodology: the parser benchmark includes the full tokenize+parse pipeline measured in isolation, while the run benchmark measures the combined parse+eval where V8 can schedule JIT compilation across both phases more aggressively.

### analyze(): 7.00ms/op, 143 ops/s

Static analysis is more expensive than a plain run because it does more work after parsing: it walks the AST to build the requirement graph, computes phase assignments via a topological sort, identifies potential cycles, and evaluates all cold-resolvable formulas. The graph computation is O(nodes × edges) in the worst case, and for a template with many conditional requirements, the edges can be numerous.

The 135.3 KB/op figure is the highest of any phase because analysis produces a rich `Analysis` object containing the parsed AST, the requirement list, the graph, the execution plan, and static values.

### stebo(): 4.64ms/op, 216 ops/s

The full pipeline includes macro expansion (expand), multi-phase driving (drive), and finalize. For a template with no macros and no pending requirements, the macro phases are cheap. The 4.64ms figure reflects a template where the driver runs to completion in one pass — no external capability calls, no suspension. The 230.9 KB/op memory figure is the highest because the full pipeline retains more intermediate state.

---

## 4. Memory Allocation and Frozen Objects

Seebo's value system uses deeply frozen records. Every `Value` produced by a `make*` factory — `makeInt`, `makeString`, `makeObject`, and so on — is frozen with `Object.freeze`:

```js
function makeValue(type, value, opts = {}) {
  const format = deepFreeze({ ...DEFAULT_FORMATS[type], ...sanitizeOptions(opts.format) });
  const constraints = deepFreeze({ ...DEFAULT_CONSTRAINTS[type], ...sanitizeOptions(opts.constraints) });
  return Object.freeze({ type, value, format, constraints });
}
```

Freezing has two effects on performance. The allocation side: every `make*` call allocates a new frozen object. There is no object pooling or reuse. This contributes to GC pressure, particularly in the parser where many `Value` objects are constructed for literal nodes during AST building.

The GC benefit: frozen objects are immutable, which means they can never be in a state where a reference points to an object mid-mutation. V8's garbage collector can track them more efficiently. Frozen short-lived objects (like the intermediate `Value` records produced during evaluation) are collected in minor GCs without promoting to the old generation. Over many iterations, this amortizes well.

AST nodes are also frozen. A parsed `Binary` node is an immutable record: once created, its `left`, `right`, and `op` fields cannot change. This is what makes the AST cache safe — you can return the same AST object for multiple evaluations without risk of one evaluation corrupting the tree seen by another.

The ~90 KB per parse is dominated by the AST nodes. The ~56 KB per run reflects the `Value` objects produced during evaluation, minus the AST cost which is shared when the cache is enabled.

---

## 5. Hot Paths Identified

Profiling the benchmark runs under Node's built-in CPU profiler (`--prof`) reveals the same picture as the timing numbers suggest, but with more granularity.

### Parser: Pratt precedence climbing and allocation

The `parsePrimary` and `parseExpr` functions in the parser are consistently at the top of the profile. Every binary expression requires at least two recursive calls and one object allocation. For a template with 500 formulas, each containing an average of four operators, this is 2,000 binary nodes, 4,000 recursive call frames, and 2,000 object allocations just for the binary operators. The profile confirms that most time is spent in these functions.

### Evaluator: jump-table dispatch

The evaluator's `evaluate` function dispatches on `expr.kind` using a `switch` statement. V8 compiles this into a jump table when the cases are dense integer keys, but string keys (like `'Binary'`, `'Ternary'`, `'Call'`) compile to a comparison chain. The chain has about twelve cases, which means an average of six comparisons per expression evaluation in the worst case. In practice, `Binary` and `Lit` are the most common kinds, and the comparison chain is ordered by frequency, so the average is lower.

The evaluator is not the bottleneck in the baseline numbers. Its dispatch is efficient enough that evaluation adds less overhead than parsing.

### Macro finalization: string slicing and offset recalculation

The finalize pass works by scanning the emitted output string for marker patterns (`@{NAME(args)}`) and applying edits. Each edit involves a slice operation and an offset adjustment for all subsequent markers. The implementation keeps a sorted list of pending edits and applies them in order, which avoids the O(n²) behavior of repeated string splices. For templates with many layout macros, the marker scanning is the bottleneck, but this is not the common case.

---

## 6. The astCache Optimization

The most impactful optimization in Seebo is the AST cache, which is opt-in via `config.optimizations.astCache`. When enabled, parsed ASTs and analysis results are memoized, keyed by the config object reference and the template string.

The implementation uses a `WeakMap` keyed on the config object, pointing to a `Map` keyed on the template string:

```js
const ANALYSIS_CACHE = new WeakMap();

function cacheBucket(config) {
  if (!config || !config.optimizations?.astCache) return undefined;
  let bucket = ANALYSIS_CACHE.get(config);
  if (!bucket) {
    bucket = new Map();
    ANALYSIS_CACHE.set(config, bucket);
  }
  return bucket;
}
```

The `WeakMap` is crucial: when the config object is garbage collected (e.g., when the engine instance is discarded), the entire cache for that config is automatically released. There is no manual cache invalidation, no lifetime management, no memory leak.

The cache key is the template string itself, after the config identity has been established. This means two engines with different registries, different limits, or different delimiter configurations will never share cache entries — the config object reference differentiates them. This is correct because the AST shape depends on the delimiter configuration: a template with custom sigils `{{ }}` instead of `${ }` produces a different token stream and thus a different AST.

Cache invalidation also happens implicitly when `astVersion`, the delimiter configuration, or the vocabulary changes — because any of these changes would require constructing a new engine instance with a new config object, which starts a fresh cache bucket.

The parser cache checks the bucket before parsing:

```js
export function analyze(template, config) {
  const bucket = cacheBucket(config);
  if (bucket) {
    const hit = bucket.get(template);
    if (hit) return hit;
    const a = analyzeUncached(template, config);
    if (bucket.size >= MAX_CACHE_ENTRIES) bucket.clear();
    bucket.set(template, a);
    return a;
  }
  return analyzeUncached(template, config);
}
```

The `MAX_CACHE_ENTRIES = 512` limit prevents unbounded growth when a host generates many unique templates. When exceeded, the entire cache is cleared wholesale rather than using LRU eviction. This is simpler to implement and sufficient for the expected use case: a template hub with a fixed set of templates.

Cache transparency is verified by the test suite:

```js
test('render output is identical with and without astCache', () => {
  const plain = createEngine();
  const cached = createEngine({ optimizations: { astCache: true } });
  const r1 = plain.run(plain.start(TEMPLATE, values));
  const r2 = cached.run(cached.start(TEMPLATE, values));
  assert.equal(r1.output, r2.output);
});
```

---

## 7. Benchmark Results With Caching

With `optimizations.astCache: true`:

| Operation | ms/op | Speedup |
|-----------|-------|---------|
| parser.parse | 0.0005 | ~3,000× |
| render run() | 0.63 | ~4.5× |
| analyze() | 0.0009 | ~3,000× |
| macro stebo() | 0.68 | ~6.8× |

### Why parse is ~3,000× faster with cache

A cache hit on `analyze()` returns the already-computed `Analysis` object — which includes the parsed AST — without any lexing or parsing work. The cost is a WeakMap lookup (O(1)), a Map lookup by string hash (O(1) average), and a reference copy. This is measured in microseconds rather than milliseconds.

The ~3,000× speedup reflects the ratio between a microsecond lookup and a 3.78ms parse. For workloads where the same template is rendered many times (batch processing, repeated API calls), this speedup directly multiplies throughput.

### Why run() is ~4.5× faster with cache

Even with the AST cached, the evaluation still runs. The evaluator walks the AST, resolves references, applies operators, and produces the output string. The 0.63ms vs 2.84ms difference represents the elimination of parsing time, with evaluation time remaining roughly constant. The 4.5× speedup is the ratio of (parse + eval) to eval-only.

### Why stebo() is ~6.8× faster with cache

The `stebo()` pipeline includes expand, drive, and finalize in addition to parse and eval. Caching eliminates the parse cost from both the initial run and the analysis that precedes it. The remaining cost is the driver loop with capability resolution, the macro expansion check, and the finalize pass. The 6.8× speedup is higher than the run() speedup because `stebo()` calls `analyze()` as part of its planning, and that analysis is also cached.

---

## 8. Deliberate Non-Optimizations

### Streaming output

Streaming output would allow the engine to emit the beginning of the rendered string before all requirements are satisfied. This would reduce perceived latency for long templates where the first few paragraphs have no pending requirements. The reason it was not implemented in v1 is correctness: some layout macros (`REMOVE_LINE`, `COLLAPSE`) require knowledge of what follows the current position. Streaming output would require a two-pass approach or a streaming layout engine, both of which add significant complexity. The v1 architecture buffers the full output and applies layout in a post-pass. This is correct and simple. Streaming can be added later once the buffered architecture is proven.

### Lazy parsing

Lazy parsing defers parsing formulas until they are actually evaluated. In a long template with many formulas, some formulas are in branches that are never taken for a given input. Parsing them upfront is wasted work. The reason lazy parsing was not implemented is that it complicates error reporting: position information is only available after parsing, and lazy parsing means positions are only known for formulas that were actually evaluated. An `analyze()` call that returns incomplete diagnostics would violate the specification. This trade-off was explicitly made: correctness of static analysis over parse-time savings.

### Object pooling

Object pooling reuses allocated objects rather than letting them be garbage collected and re-allocated. For the `Value` records that dominate memory allocation in the evaluator, pooling would reduce GC pressure. The reason pooling was not implemented is that it complicates memory management significantly. A pooled object must be explicitly returned to the pool when it is no longer needed. In a functional-style evaluator where values flow through expressions without explicit ownership, tracking when a value is safe to pool requires either reference counting (complex) or a stack discipline (restrictive). V8's generational garbage collector handles short-lived immutable objects efficiently enough that pooling has not been necessary.

### Incremental evaluation

Incremental evaluation would re-evaluate only the parts of the AST that changed between calls. For the common case of re-rendering a template after one requirement is satisfied, most of the AST has already been evaluated and the results are known. Full re-evaluation repeats this work. The reason full re-evaluation is used is the simplicity of the model: the evaluator has no state between calls. There are no continuation frames, no saved partial results, no incremental update mechanism. Adding incremental evaluation would require a much more complex evaluator architecture. With the AST cache eliminating parsing costs, the remaining re-evaluation time is acceptable for current workloads.

---

## 9. Big-O Analysis

### Lexer: O(n) in input bytes

The lexer makes exactly one pass over the input string. Every character is visited exactly once. Character classification uses constant-time comparisons. Token objects are allocated lazily (only when a slot is opened). There are no nested loops, no backtracking, no lookahead beyond one or two characters. The lexer is O(n) with a small constant.

### Parser: O(n) average, O(n²) in adversarial cases

A Pratt parser is O(n) for most grammars: each token is consumed exactly once. However, some Pratt implementations degrade to O(n²) when deeply nested expressions cause the parser to scan through many levels of the precedence table for each token. Seebo's parser guards against this with `maxNestingDepth`: once the nesting exceeds 200, the parser rejects the input. Within the nesting limit, the parse is effectively O(n). The 89.5 KB/op allocation figure reflects the O(n) object creation.

### Evaluator: O(AST nodes) per run

The evaluator visits each AST node once per evaluation. Lazy evaluation means some nodes are skipped (branches not taken), so in practice the evaluator visits fewer than all nodes for any given input. The step counter enforces this bound: when `maxSteps` is exceeded, evaluation halts. For typical templates, the evaluator's cost is dominated by the number of formula nodes and the depth of their expression trees.

### Macro expansion: O(total expanded size)

Template expansion via `ABSORB` and `MERGE` replaces a macro call with the content of a sub-template, which can itself contain macro calls. The total work is proportional to the total size of all sub-templates expanded, including duplications from multiple inclusions of the same template. Without the `maxDepth` limit, this could be exponential: a template that includes itself would expand indefinitely. The depth limit ensures that expansion is bounded: the total expanded size cannot exceed `maxDepth × maxInputBytes`.

---

## 10. Interpreting Numbers for Real Workloads

The benchmark numbers need to be interpreted in the context of real server workloads.

At 352 ops/s for `run()` cold (no cache), a single Node.js thread can handle about 352 template renders per second. For a web server handling concurrent requests, Node.js is single-threaded but uses the event loop to interleave I/O. Template rendering is CPU-bound (no I/O in the pure core), so concurrent rendering would require multiple CPU cores via worker threads, process clustering, or multiple instances.

A web server with 4 CPU cores, using `cluster` to spawn 4 worker processes, would achieve roughly 4 × 352 = 1,408 cold renders per second. For a typical B2B application generating documents at human scale (not high-frequency trading), this is more than adequate.

With the AST cache enabled, `run()` drops to 0.63ms/op, or approximately 1,587 ops/s per thread. With 4 workers, that is approximately 6,350 renders/s — enough to handle thousands of requests per second for any workload where the template set is bounded.

The critical insight for architecture is: **cache your AST**. The difference between cold and warm is 4.5×. For any application that renders the same templates more than once, enabling `optimizations.astCache` on the engine instance is the single most impactful change available. The cache is transparent — it does not change any behavior — and it costs nothing to enable.

For one-off template renders where each template is unique (e.g., user-uploaded templates that are each used once), the cold path is the relevant benchmark. At 352 ops/s, a single server can handle modest throughput. For higher throughput with unique templates, the architecture would need to scale horizontally.

---

## Conclusion

Performance engineering is fundamentally about measurement and prioritization. Seebo's benchmark suite measures each pipeline phase independently, at representative scale, with and without caching. The results show that the parser is the bottleneck, that the evaluator's dispatch is efficient, and that the AST cache eliminates parsing cost almost entirely for repeated renders.

The deliberate non-optimizations — no streaming, no lazy parsing, no object pooling, no incremental evaluation — represent a conscious trade-off of throughput for correctness and simplicity. Each one is a future option, not a closed door. The architecture is designed so that these optimizations can be added without changing the public contract.

For most production workloads, enabling `optimizations.astCache` and deploying with appropriate horizontal scale is sufficient. The engine is fast enough cold, and dramatically faster with caching.

---

## Further Reading

- `src/analyze/analyze.js` — the analysis cache implementation with `WeakMap` + `Map` pattern
- `src/util/limits.js` — all resource limits that bound worst-case complexity
- `src/runtime/values.js` — the frozen `Value` record and `deepFreeze` implementation
- `src/eval/evaluator.js` — the step counter and dispatch switch
- `test/unit/cache.test.js` — cache transparency tests
- IMPL §11 — the specification for the AST and analysis cache
- IMPL §13 — resource limits and their relationship to complexity bounds
