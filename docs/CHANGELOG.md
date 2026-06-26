# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-06-26

First implemented release of **Seebo** (Suspendable Evaluation Engine Built with Opus).
Plain JavaScript + JSDoc, no runtime dependencies, Node ≥ 20.

### Added

- **Pipeline.** Full lexer → parser → `validate`/`analyze` → `run` flow, framed by the
  `expand` (aggregator macros) pre-pass and `finalize` (layout macros) post-pass; async
  confined to `drive`/`stebo` (SPEC Part 2, IMPL §1).
- **Type system & evaluation.** Immutable typed values (`int`, `float`, `bool`, `string`,
  `datetime`, `duration`, `object`, `array`), operators incl. temporal arithmetic, transformer
  methods, object/array access, lazy `and`/`or`/`??`/ternary and desugared `match`; suspendable
  `Ok | Susp | Err` evaluator with full re-evaluation and requirement `Need`s.
- **Static analysis.** `validate` reports `UNDECLARED_NAME`, `UNKNOWN_FUNCTION`,
  `UNKNOWN_METHOD`, `ARITY_MISMATCH`, `TYPE_ERROR`, `NON_EXHAUSTIVE_MATCH`,
  `UNKNOWN_CAPABILITY`, and `POLICY_FORBIDDEN` (incl. `allowedTypes`/`allowedFunctions`),
  backed by a conservative static type inferencer. `analyze` computes requirements, graph,
  execution plan, capabilities, static values, determinism, streamability and metrics.
- **Extensibility (`define*`).** Custom types (`defineType`: construction, validation,
  stringify), producers/transformers (`defineFunction`), libraries (`defineLibrary`),
  capabilities (`defineCapability`), and finalize macros (`defineMacro` with `apply`).
  `builtins.{types,functions,macros}` expose the standard vocabulary for `...builtins.all`.
- **Persistence & versioning.** Serializable `PublicState`; `run` migrates older states and
  rejects newer ones with `UNSUPPORTED_STATE_VERSION` (IMPL §14).
- **Security & limits.** Configurable limits with diagnostics (`INPUT`/`TOKEN`/`NODE`/
  `NESTING`/`STEP`/`DEPTH`/`OUTPUT_LIMIT_EXCEEDED`, `maxOutputBytes` enforced), runtime
  `CONSTRAINT_VIOLATION`, prototype-pollution protection, trusted/untrusted capability policy
  and per-capability `audit`.
- **Performance.** Benchmark runner (`npm run bench`, `--smoke`) and the opt-in
  `optimizations.astCache` (transparent parse/analyze memoization).
- **Tooling.** ESLint + Prettier + `tsc --noEmit` type-check; GitHub Actions CI (lint,
  format-check, typecheck, test, bench smoke) on Node 20 & 22.
- **Documentation.** README plus `docs/{ARCHITECTURE,API,USAGE,SECURITY,PERFORMANCE,CONFORMANCE}.md`.

### Notes

- Diagnostic `code`s are a stable public contract (IMPL Appendix A): never renamed; adding
  new ones is non-breaking.
- Intentionally out of scope for v1: a shipped `fake.*` library, `steboStream` streaming, and
  the `lazyParse`/`stream`/`objectPool` optimizations (accepted but inert).

[0.1.0]: https://github.com/BoniFederico/seebo/releases/tag/v0.1.0
