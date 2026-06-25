/**
 * @file Conformance suite (IMPL Appendix B). Cases B.1–B.6 are **normative**: an
 * implementation is conformant if it reproduces them. In v1 the language is not yet
 * implemented, so the cases are registered as `todo` (runnable placeholders) and will be
 * enabled incrementally. See also docs/initial_docs/impl.md, Appendix B.
 */

import { test } from 'node:test';

test('B.1 — requirement in nested branches: phase(c) = 1 + max(phase(a), phase(b))', {
  todo: true,
});
test('B.2 — Need in a non-taken branch is not emitted', { todo: true });
test('B.3 — non-exhaustive match → NON_EXHAUSTIVE_MATCH', { todo: true });
test('B.4 — unregistered capability → UNKNOWN_CAPABILITY (static)', { todo: true });
test('B.5 — cyclic inclusion → INCLUSION_CYCLE + potentialCycles', { todo: true });
test('B.6 — adjacent layout macros and removal conflicts', { todo: true });
