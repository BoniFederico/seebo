/**
 * @file Default resource limits (SPEC §1.11/§2.2, IMPL §13). Single source of truth shared
 * by the lexer/parser/evaluator/driver so the engine terminates and resists hostile input.
 *
 * The four normative limits of SPEC §2.2 (`maxDepth`, `maxPhases`, `maxOutputBytes`,
 * `timeoutMs`) are kept; the rest are **additive** hardening guards (IMPL §13, non-breaking
 * per §14) that bound work per phase. All are overridable via `config.limits`.
 */

/**
 * Default resource limits. Every value can be overridden through `config.limits`.
 * @type {Readonly<Record<string, number>>}
 */
export const DEFAULT_LIMITS = Object.freeze({
  // Normative (SPEC §2.2).
  maxDepth: 20, //         max template-inclusion depth (EXPAND, IMPL §10.1)
  maxPhases: 10, //        max conversation phases (driver loop, IMPL §6.3)
  maxOutputBytes: 1_000_000, // max rendered output size
  timeoutMs: 2000, //      max time per capability invocation (driver, IMPL §7.1)
  // Additive hardening guards (IMPL §13).
  maxInputBytes: 1_000_000, // max template source length (parse)
  maxTokens: 100_000, //   max tokens produced for a template (parse)
  maxNodes: 50_000, //     max AST nodes built for a template (parse)
  maxNestingDepth: 200, // max expression nesting depth (parse, stack-overflow guard)
  maxSteps: 1_000_000, //  max evaluator steps per run pass (run)
});
