/**
 * @file Unit — public API surface. Verifies that `createEngine`, the facades, the
 * contract enums and the named contract files export the expected symbols (v1
 * placeholders). Does not exercise language logic.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as api from '../../src/index.js';

// Named contract files (source of truth)
import * as tokens from '../../src/lexer/tokens.js';
import * as nodes from '../../src/ast/nodes.js';
import * as values from '../../src/runtime/values.js';
import * as evaluator from '../../src/eval/evaluator.js';
import * as runMachine from '../../src/run/run.js';
import * as validateMod from '../../src/validate/validate.js';
import * as analyzeMod from '../../src/analyze/analyze.js';
import * as expandMod from '../../src/macros/expand.js';
import * as finalizeMod from '../../src/macros/finalize.js';
import * as asyncDriver from '../../src/driver/async_driver.js';

// Module barrels
import * as lexer from '../../src/lexer/index.js';
import * as parser from '../../src/parser/index.js';
import * as ast from '../../src/ast/index.js';
import * as errors from '../../src/util/errors.js';
import * as versions from '../../src/util/versions.js';

test('public API exports the facades required by v1', () => {
  for (const name of [
    'createEngine',
    'builtins',
    'defineType',
    'defineFunction',
    'defineMacro',
    'defineCapability',
    'defineLibrary',
    'RESERVED_WORDS',
  ]) {
    assert.ok(name in api, `missing export: ${name}`);
  }
});

test('public API re-exports the contract enums', () => {
  for (const name of [
    'TokenType',
    'NodeKind',
    'ExprKind',
    'TypeName',
    'ResultKind',
    'Status',
    'Streamability',
    'MacroFamily',
    'BUILTIN_MACROS',
    'ProviderOutcome',
    'DiagnosticCode',
  ]) {
    assert.ok(name in api, `missing contract export: ${name}`);
  }
});

test('createEngine returns an engine with all public methods', () => {
  const engine = api.createEngine();
  for (const method of [
    'tokenize',
    'parse',
    'validate',
    'analyze',
    'start',
    'run',
    'expand',
    'finalize',
    'drive',
    'stebo',
  ]) {
    assert.equal(typeof engine[method], 'function', `missing or non-function method: ${method}`);
  }
});

test('createEngine applies config defaults (delimiters/limits/optimizations/policy)', () => {
  const engine = api.createEngine();
  assert.deepEqual(engine.config.delimiters, api.DEFAULT_DELIMITERS);
  assert.deepEqual(engine.config.limits, api.DEFAULT_LIMITS);
  assert.deepEqual(engine.config.optimizations, api.DEFAULT_OPTIMIZATIONS);
  assert.equal(engine.config.optimizations.stream, false);
  assert.equal(typeof engine.config.policy.audit, 'function');
  assert.deepEqual(engine.config.policy.retry, { attempts: 0, backoffMs: 0 });
});

test('no streaming facade exists in v1 (clarifications §2)', () => {
  const engine = api.createEngine();
  assert.equal(engine.steboStream, undefined);
  assert.equal(/** @type {Record<string, unknown>} */ (api).steboStream, undefined);
});

test('named contract files export their runtime symbols', () => {
  assert.equal(tokens.TokenType.SLOT_OPEN, 'slot-open');
  assert.equal(nodes.NodeKind.FORMULA, 'Formula');
  assert.equal(nodes.ExprKind.BINARY, 'Binary');
  assert.equal(values.TypeName.DURATION, 'duration');
  assert.equal(values.DURATION_UNITS.week, 604800);
  assert.equal(typeof evaluator.evaluate, 'function');
  assert.equal(evaluator.ResultKind.SUSP, 'Susp');
  assert.equal(typeof runMachine.start, 'function');
  assert.equal(runMachine.Status.WAITING, 'waiting');
  assert.equal(typeof validateMod.validate, 'function');
  assert.equal(typeof analyzeMod.analyze, 'function');
  assert.equal(analyzeMod.Streamability.FULL, 'full');
  assert.equal(typeof expandMod.expand, 'function');
  assert.equal(typeof finalizeMod.finalize, 'function');
  assert.equal(typeof asyncDriver.drive, 'function');
  assert.equal(asyncDriver.ProviderOutcome.UNRESOLVED, 'Unresolved');
});

test('module barrels re-export the contract entry points', () => {
  assert.equal(typeof lexer.tokenize, 'function');
  assert.equal(lexer.TokenType, tokens.TokenType);
  assert.equal(typeof parser.parse, 'function');
  assert.equal(typeof ast.createDocument, 'function');
  assert.equal(ast.NodeKind, nodes.NodeKind);
});

test('version constants start at 1 (clarifications §11)', () => {
  assert.equal(versions.AST_VERSION, 1);
  assert.equal(versions.STATE_VERSION, 1);
  assert.equal(versions.ANALYSIS_VERSION, 1);
  assert.deepEqual(versions.migrations, []);
});

test('the error policy exposes the normative diagnostic codes', () => {
  assert.equal(errors.DiagnosticCode.SYNTAX_ERROR, 'SYNTAX_ERROR');
  assert.equal(errors.DiagnosticCode.UNKNOWN_CAPABILITY, 'UNKNOWN_CAPABILITY');
  const diag = errors.createDiagnostic('UNDECLARED_NAME', {
    phase: 'validate',
    data: { name: 'foo' },
  });
  assert.equal(diag.code, 'UNDECLARED_NAME');
  assert.equal(diag.severity, 'error');
  assert.equal(diag.recoverable, true);
  assert.deepEqual(diag.data, { name: 'foo' });
});

test('placeholders throw NotImplementedError (temporary v1 contract)', () => {
  const engine = api.createEngine();
  assert.throws(() => engine.parse('x'), errors.NotImplementedError);
  assert.throws(() => api.defineType('money', {}), errors.NotImplementedError);
});
