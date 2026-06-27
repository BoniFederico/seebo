# Performance Engineering: Measuring, Understanding, and Optimizing an Engine

## Table of Contents

1. [The Philosophy: Measure Before You Optimize](#the-philosophy)
2. [Benchmark Design](#benchmark-design)
3. [The Baseline Results](#the-baseline-results)
4. [Understanding the Lexer Numbers](#understanding-the-lexer-numbers)
5. [Why the Parser Is the Bottleneck](#why-the-parser-is-the-bottleneck)
6. [The Evaluator: Efficient Dispatch](#the-evaluator-efficient-dispatch)
7. [Analyze: Why It Costs More Than Run](#analyze-why-it-costs-more-than-run)
8. [Memory Allocation and Frozen Objects](#memory-allocation-and-frozen-objects)
9. [Hot Paths from Profiling](#hot-paths-from-profiling)
10. [The astCache Optimization](#the-astcache-optimization)
11. [Results with Cache Enabled](#results-with-cache-enabled)
12. [Deliberate Non-Optimizations](#deliberate-non-optimizations)
13. [Big-O Analysis](#big-o-analysis)
14. [Interpreting the Numbers for Real Workloads](#interpreting-the-numbers-for-real-workloads)
15. [Conclusion](#conclusion)
16. [Further Reading](#further-reading)

---

## The Philosophy: Measure Before You Optimize

Donald Knuth's famous observation — "premature optimization is the root of all evil" — is often cited but rarely followed with the discipline it implies. The full quote is instructive: "We should forget about small efficiencies, say about 97% of the time: premature optimization is the root of all evil. Yet we should not pass up our opportunities in that critical 3%."

The critical 3% can only be identified by measurement. Without measurement, you are guessing. A developer who "knows" that string concatenation is slow in JavaScript may spend days introducing a StringBuilder pattern into a codebase where the hot path is actually object allocation in the parser. The time was wasted, the code is more complex, and the actual bottleneck is unchanged.

Seebo's performance engineering follows a simple discipline: first, establish a baseline. Second, identify the actual hot paths through profiling. Third, apply targeted optimizations to those paths. Fourth, measure again to confirm the improvement.

The baseline is a prerequisite for everything else. Without a number for "how fast it was before," you cannot tell whether your optimization helped, had no effect, or (embarrassingly common) made things slower.

---

## Benchmark Design

A good benchmark for a template engine must be representatively complex. A trivial template (`Hello ${ name }!`) runs in microseconds and tells you nothing about the engine's behavior on realistic inputs. A pathological template (50,000 nested ternaries) runs in seconds and tells you about edge cases that no real user will encounter.

Seebo's benchmark uses a scale parameter: `scale=120` produces a template of approximately 20KB with 120 expression slots, various operator types, requirement declarations, method calls, and temporal arithmetic. This is representative of a complex operational document: a multi-section email with dynamic content, conditional sections, and CRM-sourced data.

The benchmark isolates individual pipeline stages:

- **Lexer-only**: Call `tokenize()` directly on the template string
- **Parser-only**: Call `parse()` on a pre-tokenized template (using a cached token stream)
- **Run-only (cold)**: Call `engine.run(engine.start(template, values))` from scratch
- **Analyze-only**: Call `engine.analyze(template)` without subsequent evaluation
- **Full stebo() pipeline**: Call `engine.stebo({template, values})` — the complete path

Each benchmark runs a warmup phase (to allow JIT compilation to stabilize) followed by a measurement phase with enough iterations to produce statistically stable results. The numbers are expressed as ms/operation (lower is better) and operations/second (higher is better).

The environment is fixed: Node v24, no other processes consuming CPU, V8 with standard JIT settings. Benchmark results are hardware-dependent; the absolute numbers are less important than the relative numbers and the trends they reveal.

---

## The Baseline Results

Running the benchmark with `scale=120` and `astCache` disabled produces:

| Operation | ms/op | ops/s | Memory/op |
|-----------|-------|-------|-----------|
| `lexer.tokenize()` | 0.245 | 4,080 | ~2.5KB |
| `parser.parse()` | 3.78 | 264 | ~89.5KB |
| `engine.run()` (cold) | 2.84 | 352 | ~55.8KB |
| `engine.analyze()` | 7.00 | 143 | ~135.3KB |
| `engine.stebo()` (full) | 4.64 | 216 | ~230.9KB |

These numbers require interpretation. Raw ops/second is not the metric — what matters is whether the performance is adequate for the expected workload, and where time is being spent.

---

## Understanding the Lexer Numbers

4,080 operations per second at 20KB per template is excellent. The lexer processes roughly 82MB of template text per second. For a typical web application, where templates are measured in kilobytes and request rates are measured in hundreds per second, the lexer is not a bottleneck and is unlikely to become one.

The lexer is fast for structural reasons:

**Single-pass O(n)**: The lexer makes exactly one pass over the input string. It does not backtrack, does not re-scan, and does not build intermediate data structures (except the output token array). The time complexity is linear in the input size.

**State machine simplicity**: The lexer's state machine has a small number of states. At any point, it is either in "text mode" (accumulating characters until a delimiter is found) or "formula mode" (tokenizing an expression). Transitions between states happen only at the delimiter characters.

**Minimal allocation**: Each token is a small object with four fields (type, value, start, end). No complex data structures are allocated during scanning. The output array is the only major allocation.

The ~2.5KB memory per operation is the cost of the token array — roughly 100-200 tokens for a 20KB template, each a small object.

---

## Why the Parser Is the Bottleneck

At 264 ops/second (3.78ms/op), the parser is 15× slower than the lexer. Understanding why is essential for understanding where optimization effort is valuable.

The Pratt parser does significant work per token:

**Object allocation**: Every AST node is a fresh object. A 20KB template with 120 slots and complex expressions might produce 2,000-5,000 AST nodes. Each is allocated as a separate JavaScript object, consuming GC cycles both at allocation time and at collection time.

**`Object.freeze()` on every node**: Seebo's AST nodes are frozen for correctness (immutability guarantees). `Object.freeze()` is not free — it transitions the object to a different internal V8 representation that prevents property addition. This is a one-time cost per node, but it multiplies across thousands of nodes.

**Precedence climbing**: The Pratt parser calls `parseExpression(minBP)` recursively for each binary operator. Each call involves a function invocation, a stack frame, and a binding-power comparison. For a deeply nested expression, this is many stack frames.

**Token consumption**: The parser consumes tokens from the lexer's output array sequentially, tracking the current position with an index variable. Array index access is fast, but the pattern of "advance, peek, consume" is repeated thousands of times per template.

The ~89.5KB memory allocation per parse is primarily the AST node graph. This is unavoidable: the parser must produce an AST, and the AST has a fixed minimum size per expression.

The parser's 3.78ms/op dominates the `run()` number of 2.84ms. This seems backwards — how can `run()` be faster than `parse()`? The answer is that `run()` includes parsing (it re-parses the template on every call) and is measured with a smaller range of template variations than the isolated parse benchmark. The key insight is: **parse time is the dominant cost in run(), and that's why the AST cache produces such dramatic speedups.**

---

## The Evaluator: Efficient Dispatch

The evaluator is fast (it contributes roughly 0.5ms to the 2.84ms run() total, with the rest being parsing), primarily because:

**Jump-table dispatch**: The evaluator's main `evaluate(node)` function dispatches on `node.kind` using a switch statement. V8 compiles switch statements on string or integer keys to efficient jump tables when the cases are dense enough. The dispatch overhead is minimal.

**No allocation in hot path**: For most operations, the evaluator does not allocate new objects. Arithmetic operations on numbers, string comparisons, and boolean logic operate on existing Value objects and return new Value objects from a small, fixed set of constructors.

**Short-circuit propagation**: When a Susp result is encountered, it propagates immediately upward without evaluating the rest of the expression tree. For templates with many pending requirements, this means large portions of the tree are skipped.

**Step counting as a cache**: The `steps` counter doubles as an execution progress marker. The evaluator can bail out quickly when `steps > maxSteps`, and V8's branch predictor learns that this condition is rarely true and optimizes accordingly.

---

## Analyze: Why It Costs More Than Run

At 7.00ms/op, `analyze()` is more expensive than `run()` (2.84ms/op). Several factors explain this:

**Full AST traversal for requirement extraction**: `analyze()` walks the complete AST looking for `require()` calls. This is a full O(nodes) traversal with purpose-built visitor logic.

**Dependency graph construction**: Building the requirement graph involves identifying conditional structures (ternaries, `and`, `or`) and recording which requirements appear in which branches. This requires tracking context through the traversal.

**Topological sort**: Computing the execution plan requires a topological sort of the dependency graph, which is O(V + E) but has higher constant factors than simple traversal.

**Static value computation**: The "cold evaluation" pass that identifies `staticValues` runs the full evaluator with an empty resolved set, adding the evaluator's cost on top of the analysis cost.

**Conservative type inference**: The type inferencer traverses the AST applying inference rules, which adds another full traversal.

The ~135.3KB memory usage per analyze call reflects all these intermediate data structures (the graph, the inference table, the execution plan) in addition to the AST.

---

## Memory Allocation and Frozen Objects

The memory figures deserve attention. A `run()` call that allocates ~55.8KB may seem small, but at 352 ops/second, that is about 19MB/second of allocation. For a long-running Node.js process with many simultaneous users, this creates GC pressure.

The main allocations:

**AST nodes** (~90KB per parse): Each node is a separate object. For a 20KB template, there may be thousands of nodes. These are frozen (via `Object.freeze()`), which means V8 may place them in a non-garbage-collected region if they are large and long-lived — the cache makes them long-lived, which is actually beneficial.

**Value objects** (~56KB per run): Each evaluated sub-expression may produce a new Value object. The engine does not pool or reuse Value objects.

**Need objects** (small): Each pending need is a small object, allocated only when a requirement is not in `resolved`.

The frozen AST nodes are particularly interesting. V8 has an optimization for deeply frozen object graphs: once frozen, they are considered immutable and can be held in a compacted, pointer-stable region. When the AST cache is used, frozen AST nodes are allocated once and reused across many `run()` calls, amortizing the allocation cost completely.

---

## Hot Paths from Profiling

Profiling the benchmark with `node --prof` and then processing with `node --prof-process` reveals where time is spent:

1. **Parser's `parseExpression()`** (dominant): Most time is spent in the recursive Pratt parser. The binding-power table lookup, recursive calls, and AST node allocation all concentrate here.

2. **`Object.freeze()` on AST nodes**: Significant time is spent in node finalization. This is intrinsic to the frozen-AST design.

3. **String operations in the lexer**: The `indexOf` calls used to find delimiter characters in text mode.

4. **Evaluator's `evaluate()` dispatch**: The switch statement dispatch is fast but frequent.

5. **`JSON.stringify` / string concatenation in output building**: Converting each evaluated segment to a string and accumulating the output.

No other operations appear in the hot path at significant percentages. This profile guides optimization: #1 and #2 are addressed by the AST cache. #3 could be addressed by a more sophisticated scanner (e.g., using `Uint8Array` operations instead of string methods). #4 and #5 would require fundamental algorithmic changes.

---

## The astCache Optimization

The single most impactful optimization in Seebo is the opt-in AST cache. When enabled with `optimizations: { astCache: true }` in `createEngine()`, the parser's output is memoized by (config hash + template string).

The cache is implemented as a `WeakMap<config, Map<templateString, AST>>`:

```js
// Conceptual implementation (src/parser/index.js with cache)
const astCaches = new WeakMap();

function cachedParse(config, template, registry) {
  let cache = astCaches.get(config);
  if (!cache) {
    cache = new Map();
    astCaches.set(config, cache);
  }
  if (cache.has(template)) {
    return cache.get(template);
  }
  const ast = parse(template, registry);
  cache.set(template, ast);
  return ast;
}
```

The `WeakMap` keyed on `config` ensures that the cache is garbage-collected when the engine instance is collected. The inner `Map` keyed on the template string provides O(1) lookup once the engine instance is found.

**Cache invalidation**: The cached AST must be invalidated when:
- The engine's vocabulary changes (a new function or type is registered) — which can't happen because the registry is frozen at `createEngine()` time
- The delimiter configuration changes — same reason
- The `astVersion` increments (a new version of the AST contract requires a new parse)

Because the registry and config are fixed at `createEngine()` time, the cache never needs explicit invalidation within an engine's lifetime. A new engine instance (with different config) gets a new cache.

**Thread safety**: Node.js is single-threaded within a process. The cache does not need locking.

**Memory trade-off**: The cache holds strong references to all parsed ASTs. For a system that processes many distinct templates (e.g., a template library with thousands of templates), the cache grows without bound. In practice, template libraries tend to have hundreds of templates, not millions, so this is acceptable. A production system should consider a bounded cache with an eviction policy (LRU) if the template space is large.

---

## Results with Cache Enabled

With `optimizations: { astCache: true }` and a warm cache:

| Operation | ms/op (cold) | ms/op (warm cache) | Speedup |
|-----------|-------------|-------------------|---------|
| `parser.parse()` | 3.78 | 0.0005 | ~3,000× |
| `engine.run()` | 2.84 | 0.63 | ~4.5× |
| `engine.analyze()` | 7.00 | 0.0009 | ~3,000× |
| `engine.stebo()` | 4.64 | 0.68 | ~6.8× |

The parse and analyze speedups are extraordinary (~3,000×) because those operations are almost entirely eliminated: the cache hit returns an already-computed result in near-zero time. The `run()` and `stebo()` speedups are smaller (4.5×–6.8×) because the evaluator's cost remains — the cache eliminates parsing but not evaluation.

The warm-cache `run()` cost of 0.63ms is almost entirely evaluator cost. This is the irreducible minimum for the current evaluator implementation on a 20KB template. Further speedups would require changes to the evaluator (incremental evaluation, value caching) or to the evaluation model itself.

---

## Deliberate Non-Optimizations

Several potentially useful optimizations were considered and deliberately not implemented in v1. Understanding why they were deferred is part of understanding the performance model.

**Streaming output**: Delivering the output prefix before all requirements are resolved would reduce time-to-first-byte for users waiting for long documents. Not implemented because: (1) the evaluator needs to process the full template to know which requirements are in the output prefix and which are in conditional branches; (2) streaming complicates error handling significantly; (3) the primary use case (operational workflow documents) is not latency-sensitive in the same way a web page is.

**Lazy parsing**: Parsing only the slots that are needed for the first evaluation, deferring the rest. Not implemented because: (1) it complicates error reporting (errors in unparsed sections go undetected); (2) with the AST cache, the savings only apply to the first call, after which the cache is warm; (3) the implementation complexity is high.

**Object pooling**: Reusing AST node or Value objects across calls to reduce GC pressure. Not implemented because: (1) V8's generational GC handles short-lived objects well; (2) object pooling with frozen objects is tricky (you must "thaw" and re-freeze); (3) profiling did not show GC as a dominant cost at the tested scale.

**Incremental evaluation**: Re-evaluating only the subtrees that depend on newly-resolved requirements. Not implemented because: (1) dependency tracking at the sub-tree level is complex; (2) with the AST cache, full re-evaluation costs 0.63ms — fast enough for the current use case; (3) the complexity trade-off is not justified until scale demands it.

---

## Big-O Analysis

**Lexer**: O(n) in input bytes. Each byte is visited exactly once. The state transitions are O(1) per byte. The output token array grows linearly with the number of tokens, which is at most linear in the input.

**Parser**: O(n) in tokens for well-structured inputs in a typical Pratt parser implementation. However, error recovery paths can introduce O(n²) behavior in pathological inputs (where the parser repeatedly attempts to recover from errors). The normal case is O(n).

**Evaluator**: O(N) in AST nodes per `run()` call, where N is the number of nodes in the AST. Each node is visited at most once in the forward pass. Lazy evaluation means some nodes are skipped (short-circuit), so the practical cost is at most O(N) and often less.

**Macro expansion (EXPAND)**: O(total expanded size). Each template is expanded in O(size) time. If ABSORB/MERGE creates a template K times larger than the input, the total expansion cost is O(K × input size). The `maxDepth` limit bounds K.

**Macro finalization (FINALIZE)**: O(M × L) where M is the number of markers and L is the output length. Each marker may require shifting subsequent characters in the string. In the worst case (many markers near the beginning of a long string), this approaches O(M × L). In practice, M is small (dozens at most) and L is bounded by `maxOutputBytes`.

**Static analysis (analyze())**: O(N) for AST traversal + O(V + E) for dependency graph construction, where V is the number of requirements and E is the number of dependency edges. The topological sort is O(V + E). Total: O(N + V + E), which is effectively O(N) since V and E are bounded by N.

---

## Interpreting the Numbers for Real Workloads

What do 264 ops/second (cold) and ~1,580 ops/second (warm cache) mean in practice?

Consider a web server handling template rendering requests. Each request uses a template from a library of 500 templates. The server has 10 concurrent users making requests.

**Without cache**: 264 ops/s ÷ 10 users = 26.4 renders per second per user. For most operational workflow tools — where rendering is triggered by user actions (clicking "Generate Email"), not automated at high frequency — this is ample throughput.

**With cache**: ~1,580 ops/s ÷ 10 users = 158 renders per second per user. This is more than adequate for any anticipated use case.

The more relevant metric for operational tools is latency: how long does a single user wait for their template to render? At 2.84ms (cold) or 0.63ms (warm cache), the latency is imperceptible to a human. The bottleneck for operational tool users is almost always the capability resolution (waiting for CRM API responses, database queries, user input), not the engine computation.

The 7.00ms `analyze()` cost is relevant for template validation during authoring (e.g., in a live editor). Analyzing a template on every keystroke would be expensive; analyzing on save or debounced after a pause is acceptable.

---

## Conclusion

Performance engineering for a language engine requires understanding the entire pipeline: where time is spent (profiling), why (structural analysis), and what can be done about it (targeted optimization).

For Seebo, profiling reveals that the parser is the bottleneck — not because it is poorly implemented, but because AST construction is intrinsically allocation-intensive. The AST cache addresses this bottleneck directly and effectively, delivering 3,000× parse speedup and 4.5–7× end-to-end speedup for repeated calls on the same template.

The remaining 0.63ms per warm-cache run is evaluator cost. This is fast enough for current use cases. Further optimization would require either a more sophisticated evaluator (incremental, streaming) or a fundamental change in the execution model. Both are deferred to future work, where they can be justified by measured production demand rather than anticipated need.

The lesson: measure first, optimize the actual bottleneck, and resist the temptation to optimize what isn't slow.

---

## Further Reading

- `docs/PERFORMANCE.md` — the project's benchmark results and methodology documentation
- `src/parser/index.js` — the AST cache implementation; `WeakMap` keying strategy
- `src/util/limits.js` — all resource limits that bound worst-case behavior
- Crockford, D. (2007). "Top Down Operator Precedence." — Pratt parsing and its performance characteristics
- V8 Blog (various). "Trash talk: the Orinoco garbage collector." — V8's GC design and its implications for allocation-heavy code
- Nystrom, R. (2021). *Crafting Interpreters*. — Chapter 24 on optimization; Chapter 30 on bytecode vs tree-walking interpreters
- Sedgewick, R. & Wayne, K. (2011). *Algorithms* (4th ed.). — Chapter 5 on string processing algorithms, relevant to the lexer
