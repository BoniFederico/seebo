/**
 * @file Suspendable evaluator (IMPL §5, §6.4). Three layers, deliberately separated:
 *
 *  1. **Pure evaluation helpers** — {@link ./operators.js} and {@link ./methods.js}
 *     (no env, no suspension, no I/O).
 *  2. **Execution state + evaluation** — this file: {@link evaluate} threads an env
 *     (`resolved`), collects unmet `Need`s, and propagates the three-way result
 *     `Ok | Susp | Err`; {@link createEvaluator} is the suspendable handle (step/resume).
 *  3. **Async driver integration** — {@link ../driver/async_driver.js} (the only async
 *     layer; satisfies Needs via capabilities between passes).
 *
 * Suspension model (IMPL §6.4): v1 uses **full re-evaluation** — there are no
 * continuation frames or a saved stack. A `Need` (unmet requirement) yields `Susp`;
 * lazy operators (`and`/`or`/`??`/ternary, and the desugared `match`) only evaluate the
 * branches they need, so a `Need` gated behind an undecided condition is NOT emitted
 * (this realizes the phases). `step()` runs one pure pass; `resume(satisfied)` merges new
 * values into `resolved` and steps again — the observable "suspend/resume".
 */

import {
  makeInt,
  makeFloat,
  makeBool,
  makeString,
  makeObject,
  makeArray,
  makeDatetime,
  makeDuration,
  fromJs,
  isValue,
  isNumeric,
  objectGet,
  emptyValue,
} from '../runtime/values.js';
import { toText } from '../runtime/stringify.js';
import { createDiagnostic, DiagnosticCode, SeeboError } from '../util/errors.js';
import { DEFAULT_LIMITS } from '../util/limits.js';
import { applyUnary, applyBinary, isEmpty } from './operators.js';
import { applyMethod } from './methods.js';
import { collectDeclarations, extractRequirement } from './symbols.js';

/** Evaluation outcome tags (SPEC §1.6, IMPL §5). @type {Readonly<Record<string,string>>} */
export const ResultKind = Object.freeze({ OK: 'Ok', SUSP: 'Susp', ERR: 'Err' });

const TYPE_NAMES = new Set([
  'int',
  'float',
  'bool',
  'string',
  'datetime',
  'duration',
  'object',
  'array',
]);

/**
 * @typedef {Object} Ok @property {'Ok'} kind @property {import('../runtime/values.js').Value} value
 * @typedef {Object} Susp @property {'Susp'} kind @property {RequirementDescriptor} need
 * @typedef {Object} Err @property {'Err'} kind @property {import('../util/errors.js').Diagnostic} diagnostic
 * @typedef {Ok | Susp | Err} EvalResult
 */

/**
 * Requirement descriptor (SPEC §1.6); `phase`/`options` are analyze-derived (IMPL §9).
 * @typedef {Object} RequirementDescriptor
 * @property {string} id
 * @property {import('../runtime/values.js').TypeDescriptor} type
 * @property {string} capability
 * @property {string} [label]
 * @property {string} [description]
 * @property {boolean} [optional]
 * @property {number} [priority]
 * @property {string} [group]
 * @property {Record<string, unknown>} [resolverHints]
 * @property {number} [phase]
 * @property {unknown[]} [options]
 */

/**
 * Capability provider: given a requirement, returns its value (synchronously or via a
 * Promise), or `undefined` to mean "not me" (SPEC §2.2 / IMPL §7.1).
 *
 * @callback CapabilityFn
 * @param {RequirementDescriptor} req
 * @returns {unknown | Promise<unknown>}
 */

/**
 * Evaluation context (execution state for one pass).
 * @typedef {Object} EvalContext
 * @property {Record<string, unknown>} resolved   Satisfied values by id (Value or raw JS).
 * @property {Map<string, { kind: string, descriptor: RequirementDescriptor }>} symbols
 * @property {Map<string, RequirementDescriptor>} needs  Accumulated active Needs (by id).
 * @property {import('../index.js').EngineConfig} [config]
 * @property {() => Date} clock
 * @property {number} [steps]  Evaluator step counter for the current pass (IMPL §13).
 * @property {number} [maxSteps]  Step budget for the pass; when set, exceeding it yields `STEP_LIMIT_EXCEEDED`.
 */

/* ----------------------------------------------------------------------------------- *
 * Document evaluation + suspendable handle
 * ----------------------------------------------------------------------------------- */

/**
 * Evaluates a whole document against a `resolved` environment (one pure pass).
 * @param {import('../ast/nodes.js').Document} ast
 * @param {Record<string, unknown>} resolved
 * @param {import('../index.js').EngineConfig} [config]
 * @returns {{ status: 'completed'|'waiting'|'failed', output?: string, pending: RequirementDescriptor[], diagnostics?: import('../util/errors.js').Diagnostic[] }}
 */
export function evaluateDocument(ast, resolved, config) {
  /** @type {EvalContext} */
  const ctx = {
    resolved: resolved ?? {},
    symbols: collectDeclarations(ast),
    needs: new Map(),
    config,
    clock: config?.clock ?? (() => new Date()),
    steps: 0,
    maxSteps: config?.limits?.maxSteps ?? DEFAULT_LIMITS.maxSteps,
  };

  let output = '';
  for (const node of ast.nodes) {
    if (node.kind === 'Text') {
      output += /** @type {any} */ (node).value;
    } else if (node.kind === 'Comment') {
      // removed at emission (SPEC §1.2)
    } else if (node.kind === 'Macro') {
      // Layout macros are positional markers applied by finalize (post-pass): emit their
      // canonical `@{NAME(args)}` source so finalize can act on it. Aggregator macros are
      // expanded by the pre-pass (IMPL §10.1) and emit nothing if they reach here.
      const macro = /** @type {import('../ast/nodes.js').MacroNode} */ (node);
      if (macro.family === 'layout') output += renderMacroMarker(macro, config);
    } else if (node.kind === 'Formula') {
      const res = evaluate(/** @type {any} */ (node).expr, ctx);
      if (res.kind === 'Ok') output += toText(res.value, config?.locale);
      else if (res.kind === 'Err') {
        return { status: 'failed', pending: [], diagnostics: [res.diagnostic] };
      }
      // Susp: the Need is recorded in ctx.needs; the slot stays a hole this pass.
    }
  }

  const pending = [...ctx.needs.values()];
  if (pending.length > 0) return { status: 'waiting', pending };
  return { status: 'completed', output, pending: [] };
}

/**
 * Creates a suspendable evaluator handle over a parsed AST (IMPL §6.4). `step()` runs one
 * pass; `resume(satisfied)` merges values and steps again. Optionally accepts an async
 * `driver(pending) → Promise<Record<id, value>>` for `run()`.
 *
 * @param {import('../ast/nodes.js').Document} ast
 * @param {{ resolved?: Record<string, unknown>, config?: import('../index.js').EngineConfig }} [options]
 * @param {(pending: RequirementDescriptor[]) => Promise<Record<string, unknown>>} [driver]
 */
export function createEvaluator(ast, options = {}, driver) {
  let resolved = { ...(options.resolved ?? {}) };
  let phase = 0;
  /** @type {ReturnType<typeof evaluateDocument> | null} */
  let last = null;

  function snapshot() {
    return { ...(last ?? { status: 'running', pending: [] }), phase, resolved: { ...resolved } };
  }

  function step() {
    phase += 1;
    last = evaluateDocument(ast, resolved, options.config);
    return snapshot();
  }

  /** @param {Record<string, unknown>} satisfied */
  function resume(satisfied) {
    resolved = { ...resolved, ...(satisfied ?? {}) };
    return step();
  }

  async function run() {
    if (!driver) throw new SeeboError('createEvaluator: no driver provided for run()');
    let snap = step();
    while (snap.status === 'waiting') {
      const satisfied = await driver(snap.pending);
      if (!satisfied || Object.keys(satisfied).length === 0) break; // no progress
      snap = resume(satisfied);
    }
    return snap;
  }

  return {
    ast,
    step,
    resume,
    run,
    snapshot,
    needs: () => (last ? last.pending : []),
  };
}

/* ----------------------------------------------------------------------------------- *
 * Expression evaluation (the three-way, suspendable core)
 * ----------------------------------------------------------------------------------- */

/**
 * Evaluates one expression node (IMPL §5). Pure w.r.t. external state; records active
 * Needs into `ctx.needs`.
 * @param {import('../ast/nodes.js').Expr} expr
 * @param {EvalContext} ctx
 * @returns {EvalResult}
 */
export function evaluate(expr, ctx) {
  // Step budget (IMPL §13): bounds work per pass against pathological expressions.
  if (ctx.maxSteps !== undefined && (ctx.steps = (ctx.steps ?? 0) + 1) > ctx.maxSteps) {
    return err(
      DiagnosticCode.STEP_LIMIT_EXCEEDED,
      expr,
      `evaluation exceeded maxSteps (${ctx.maxSteps})`,
      {
        limit: ctx.maxSteps,
      }
    );
  }
  const e = /** @type {any} */ (expr);
  switch (e.kind) {
    case 'Lit':
      return evalLit(e);
    case 'Ref':
      return resolveRef(e.name, ctx, expr);
    case 'Unary':
      return evalUnary(e, ctx);
    case 'Binary':
      return evalBinary(e, ctx);
    case 'Ternary':
      return evalTernary(e, ctx);
    case 'Call':
      return evalCall(e, ctx);
    case 'Method':
      return evalMethod(e, ctx);
    case 'Member':
      return evalMember(e, ctx);
    case 'ObjectLit':
      return evalObjectLit(e, ctx);
    case 'ArrayLit':
      return evalArrayLit(e, ctx);
    case 'Namespace':
      return evalNamespace(e, ctx);
    default:
      return err(DiagnosticCode.TYPE_ERROR_RUNTIME, expr, `unsupported expression '${e.kind}'`);
  }
}

/** @param {import('../ast/nodes.js').LitNode} e */
function evalLit(e) {
  switch (e.type) {
    case 'int':
      return ok(makeInt(/** @type {number} */ (e.value)));
    case 'float':
      return ok(makeFloat(/** @type {number} */ (e.value)));
    case 'bool':
      return ok(makeBool(/** @type {boolean} */ (e.value)));
    case 'string':
      return ok(makeString(/** @type {string} */ (e.value)));
    default:
      return err(DiagnosticCode.TYPE_ERROR_RUNTIME, e, `unsupported literal '${e.type}'`);
  }
}

/**
 * Renders a layout macro back to its canonical `@{NAME(args)}` marker so the FINALIZE
 * post-pass ({@link ../macros/finalize.js}) can apply it positionally (IMPL §10.2). Only
 * literal arguments are reconstructed (layout macros take numeric/string literals).
 * @param {import('../ast/nodes.js').MacroNode} macro @param {import('../index.js').EngineConfig} [config]
 * @returns {string}
 */
function renderMacroMarker(macro, config) {
  const d = config?.delimiters ?? {};
  const sigil = d.macro ?? '@';
  const open = d.open ?? '{';
  const close = d.close ?? '}';
  const args = macro.args.map(macroArgSource).join(',');
  const call = macro.args.length > 0 ? `${macro.name}(${args})` : macro.name;
  return `${sigil}${open}${call}${close}`;
}

/** Source form of a layout-macro literal argument. @param {import('../ast/nodes.js').Expr} expr @returns {string} */
function macroArgSource(expr) {
  const e = /** @type {any} */ (expr);
  if (e && e.kind === 'Lit') return String(e.value);
  return '';
}

/** @param {string} name @param {EvalContext} ctx @param {import('../ast/nodes.js').Expr} node */
function resolveRef(name, ctx, node) {
  if (Object.prototype.hasOwnProperty.call(ctx.resolved, name)) {
    return ok(asValue(ctx.resolved[name]));
  }
  const decl = ctx.symbols.get(name);
  if (decl) return resolveDeclaration(decl, ctx);
  return err(DiagnosticCode.UNDECLARED_NAME, node, `'${name}' is not declared`, { name });
}

/** @param {{ kind: string, descriptor: RequirementDescriptor }} decl @param {EvalContext} ctx */
function resolveDeclaration(decl, ctx) {
  if (decl.kind === 'var') return resolveValueOrDefault(decl.descriptor, ctx, true);
  return resolveRequirement(decl.descriptor, ctx);
}

/**
 * Resolution precedence for a requirement (SPEC §1.7, IMPL §5):
 * resolved → default → (optional ⇒ empty) → Need.
 * @param {RequirementDescriptor} d @param {EvalContext} ctx @returns {EvalResult}
 */
function resolveRequirement(d, ctx) {
  if (Object.prototype.hasOwnProperty.call(ctx.resolved, d.id)) {
    return ok(asValue(ctx.resolved[d.id]));
  }
  const type = d.type ?? { type: 'string' };
  if (type.default !== undefined) return ok(fromJs(type.default));
  if (d.optional === true) return ok(emptyValue(type.type));
  ctx.needs.set(d.id, d);
  return susp(d);
}

/** @param {RequirementDescriptor} d @param {EvalContext} ctx @param {boolean} isVar */
function resolveValueOrDefault(d, ctx, isVar) {
  if (Object.prototype.hasOwnProperty.call(ctx.resolved, d.id)) {
    return ok(asValue(ctx.resolved[d.id]));
  }
  const type = d.type ?? { type: 'string' };
  if (type.default !== undefined) return ok(fromJs(type.default));
  if (isVar) {
    return errDiag(
      createDiagnostic(DiagnosticCode.CONSTRAINT_VIOLATION, {
        phase: 'run',
        recoverable: false,
        message: `missing value for var '${d.id}'`,
        data: { id: d.id },
      })
    );
  }
  ctx.needs.set(d.id, d);
  return susp(d);
}

/** @param {import('../ast/nodes.js').UnaryNode} e @param {EvalContext} ctx */
function evalUnary(e, ctx) {
  const r = evaluate(e.arg, ctx);
  if (r.kind !== 'Ok') return r;
  return tryApply(() => applyUnary(e.op, r.value), e);
}

/** @param {import('../ast/nodes.js').BinaryNode} e @param {EvalContext} ctx */
function evalBinary(e, ctx) {
  if (e.op === 'and' || e.op === 'or') return evalLogical(e, ctx);
  if (e.op === '??') return evalCoalesce(e, ctx);

  // Strict operators: evaluate BOTH operands so independent Needs are collected in batch.
  const l = evaluate(e.left, ctx);
  const r = evaluate(e.right, ctx);
  if (l.kind === 'Err') return l;
  if (r.kind === 'Err') return r;
  if (l.kind === 'Susp') return l;
  if (r.kind === 'Susp') return r;
  return tryApply(() => applyBinary(e.op, l.value, r.value), e);
}

/**
 * Lazy `and`/`or` (SPEC §1.4): the right branch is only evaluated when needed.
 * @param {import('../ast/nodes.js').BinaryNode} e @param {EvalContext} ctx @returns {EvalResult}
 */
function evalLogical(e, ctx) {
  const l = evaluate(e.left, ctx);
  if (l.kind !== 'Ok') return l;
  if (l.value.type !== 'bool')
    return err(DiagnosticCode.TYPE_ERROR_RUNTIME, e, `'${e.op}' expects bool`);
  const leftBool = /** @type {boolean} */ (l.value.value);
  if (e.op === 'and' && !leftBool) return ok(makeBool(false));
  if (e.op === 'or' && leftBool) return ok(makeBool(true));
  const r = evaluate(e.right, ctx);
  if (r.kind !== 'Ok') return r;
  if (r.value.type !== 'bool')
    return err(DiagnosticCode.TYPE_ERROR_RUNTIME, e, `'${e.op}' expects bool`);
  return ok(r.value);
}

/**
 * Lazy `??` (SPEC §1.4): returns left if non-empty, else the right branch.
 * @param {import('../ast/nodes.js').BinaryNode} e @param {EvalContext} ctx @returns {EvalResult}
 */
function evalCoalesce(e, ctx) {
  const l = evaluate(e.left, ctx);
  if (l.kind !== 'Ok') return l;
  if (!isEmpty(l.value)) return l;
  return evaluate(e.right, ctx);
}

/**
 * Lazy ternary (SPEC §1.4): only the taken branch is evaluated → gates Needs (phases).
 * @param {import('../ast/nodes.js').TernaryNode} e @param {EvalContext} ctx @returns {EvalResult}
 */
function evalTernary(e, ctx) {
  const c = evaluate(e.cond, ctx);
  if (c.kind !== 'Ok') return c;
  if (c.value.type !== 'bool')
    return err(DiagnosticCode.TYPE_ERROR_RUNTIME, e, 'ternary condition must be bool');
  return c.value.value ? evaluate(e.then, ctx) : evaluate(e.else, ctx);
}

/** @param {import('../ast/nodes.js').CallNode} e @param {EvalContext} ctx */
function evalCall(e, ctx) {
  if (e.callee === 'require') {
    let descriptor;
    try {
      descriptor = extractRequirement(e);
    } catch (ex) {
      return errFrom(ex, e);
    }
    return resolveRequirement(descriptor, ctx);
  }
  if (e.callee === 'var') return resolveRef(varName(e), ctx, e);
  if (e.callee === 'now') return ok(makeDatetime(ctx.clock().getTime()));
  if (e.callee === 'date') return evalDate(e, ctx);
  if (TYPE_NAMES.has(e.callee)) {
    if (e.args.length === 0) {
      return err(
        DiagnosticCode.TYPE_ERROR_RUNTIME,
        e,
        `'${e.callee}()' is a type builder, not a value`
      );
    }
    const args = evalList(e.args, ctx);
    if (args.blocking) return args.blocking;
    return tryApply(() => construct(e.callee, /** @type {any} */ (args.values)), e);
  }
  // Custom producer registered via defineFunction (SPEC §2.6), consulted only after builtins.
  const producer = registryOf(ctx)?.getProducer(e.callee);
  if (producer) {
    const args = evalList(e.args, ctx);
    if (args.blocking) return args.blocking;
    return callExtension(producer, undefined, /** @type {any} */ (args.values), e);
  }
  return err(DiagnosticCode.UNKNOWN_FUNCTION, e, `unknown function '${e.callee}'`, {
    name: e.callee,
  });
}

/** @param {import('../ast/nodes.js').MethodNode} e @param {EvalContext} ctx */
function evalMethod(e, ctx) {
  const recv = evaluate(e.receiver, ctx);
  if (recv.kind !== 'Ok') return recv;
  const args = evalList(e.args, ctx);
  if (args.blocking) return args.blocking;
  try {
    return ok(applyMethod(recv.value, e.name, /** @type {any} */ (args.values)));
  } catch (ex) {
    // Builtins win; a custom transformer (defineFunction with a receiver) is consulted only
    // when the builtin dispatch reports the method as unknown (SPEC §2.6).
    const custom =
      ex instanceof SeeboError && ex.code === DiagnosticCode.UNKNOWN_METHOD
        ? registryOf(ctx)?.getTransformer(recv.value.type, e.name)
        : undefined;
    if (custom) return callExtension(custom, recv.value, /** @type {any} */ (args.values), e);
    return errFrom(ex, e);
  }
}

/** @param {import('../ast/nodes.js').NamespaceNode} e @param {EvalContext} ctx @returns {EvalResult} */
function evalNamespace(e, ctx) {
  const fn = registryOf(ctx)?.getLibraryFn(e.ns, e.name);
  if (!fn) {
    return err(
      DiagnosticCode.UNKNOWN_FUNCTION,
      e,
      `library function '${e.ns}.${e.name}' is not registered`,
      {
        name: `${e.ns}.${e.name}`,
      }
    );
  }
  const args = evalList(e.args, ctx);
  if (args.blocking) return args.blocking;
  return callExtension(fn, undefined, /** @type {any} */ (args.values), e);
}

/** Reads the extension registry from the evaluation context, if any. @param {EvalContext} ctx @returns {import('../runtime/registry.js').Registry | undefined} */
function registryOf(ctx) {
  return /** @type {any} */ (ctx.config)?.registry;
}

/**
 * Invokes a registered extension (`defineFunction`/`defineLibrary`) over plain JS values and
 * wraps the result back into a typed {@link import('../runtime/values.js').Value} via
 * {@link fromJs} (SPEC §2.6). Extension code never sees internal `Value`s.
 * @param {{ arity?: { min: number, max: number }, eval: (...args: any[]) => unknown }} def
 * @param {import('../runtime/values.js').Value | undefined} self  Receiver for a transformer; `undefined` for a producer/library fn.
 * @param {import('../runtime/values.js').Value[]} args  Evaluated argument values.
 * @param {import('../ast/nodes.js').Expr} node
 * @returns {EvalResult}
 */
function callExtension(def, self, args, node) {
  if (def.arity) {
    const n = args.length;
    if (n < def.arity.min || n > def.arity.max) {
      return err(DiagnosticCode.ARITY_MISMATCH, node, 'wrong number of arguments', {
        expected: def.arity,
        got: n,
      });
    }
  }
  const jsArgs = args.map((v) => v.value);
  const callArgs = self ? [self.value, ...jsArgs] : jsArgs;
  return tryApply(() => fromJs(def.eval(...callArgs)), node);
}

/** @param {import('../ast/nodes.js').MemberNode} e @param {EvalContext} ctx */
function evalMember(e, ctx) {
  const recv = evaluate(e.receiver, ctx);
  if (recv.kind !== 'Ok') return recv;
  return tryApply(() => objectGet(recv.value, e.key), e);
}

/** @param {import('../ast/nodes.js').ObjectLitNode} e @param {EvalContext} ctx */
function evalObjectLit(e, ctx) {
  // `__proto__` keys are skipped (see below) and makeObject re-sanitizes, so a plain
  // accumulator is safe and keeps object values as ordinary POJOs.
  /** @type {Record<string, unknown>} */
  const out = {};
  /** @type {EvalResult|null} */
  let blocking = null;
  for (const entry of e.entries) {
    const v = evaluate(entry.value, ctx);
    if (v.kind === 'Err') return v;
    if (v.kind === 'Susp') blocking = blocking ?? v;
    else if (entry.key !== '__proto__') out[entry.key] = v.value.value;
  }
  if (blocking) return blocking;
  return tryApply(() => makeObject(out), e);
}

/** @param {import('../ast/nodes.js').ArrayLitNode} e @param {EvalContext} ctx */
function evalArrayLit(e, ctx) {
  const args = evalList(e.elements, ctx);
  if (args.blocking) return args.blocking;
  const values = /** @type {import('../runtime/values.js').Value[]} */ (args.values);
  return tryApply(() => makeArray(values.map((v) => v.value)), e);
}

/* ----------------------------------------------------------------------------------- *
 * Producers: construct / convert / date
 * ----------------------------------------------------------------------------------- */

/**
 * Constructs or converts a value for a type producer `T(arg)` (SPEC §1.5).
 * @param {string} type @param {import('../runtime/values.js').Value[]} args
 * @returns {import('../runtime/values.js').Value}
 */
function construct(type, args) {
  const v = args[0];
  switch (type) {
    case 'string':
      return makeString(toText(v));
    case 'int':
      return convertInt(v);
    case 'float':
      return convertFloat(v);
    case 'bool':
      if (v.type !== 'bool') throw typeErr(`bool() expects a bool, got ${v.type}`);
      return v;
    case 'duration':
      if (!isNumeric(v)) throw typeErr('duration() expects a number of seconds');
      return makeDuration(/** @type {number} */ (v.value));
    case 'datetime':
      if (isNumeric(v)) return makeDatetime(/** @type {number} */ (v.value));
      // The explicit `datetime()` producer also accepts an ISO-8601 string (SPEC §1.5/§2.7).
      // This is distinct from `fromJs` inference, which never auto-parses strings (clarifications §7).
      if (v.type === 'string') return makeDatetime(parseIso(/** @type {string} */ (v.value)));
      throw typeErr('datetime() expects epoch milliseconds or an ISO-8601 string');
    case 'object':
      if (v.type !== 'object') throw typeErr(`object() expects an object, got ${v.type}`);
      return v;
    case 'array':
      if (v.type !== 'array') throw typeErr(`array() expects an array, got ${v.type}`);
      return v;
    default:
      throw typeErr(`unknown type '${type}'`);
  }
}

/**
 * Strictly parses a canonical ISO-8601 instant into epoch ms UTC (SPEC §2.7). Accepts
 * `YYYY-MM-DD` optionally followed by `THH:mm[:ss[.sss]]` and an optional trailing `Z`; all
 * times are interpreted as UTC. The regex is linear-time (no backtracking ⇒ ReDoS-safe).
 * @param {string} s @returns {number}
 */
function parseIso(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?Z?$/.exec(
    s.trim()
  );
  if (!m) throw typeErr(`datetime() cannot parse ISO-8601 string '${s}'`);
  const ms = (m[7] ?? '').padEnd(3, '0');
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0), +ms);
}

/** @param {import('../runtime/values.js').Value} v */
function convertInt(v) {
  if (v.type === 'int') return v;
  if (v.type === 'float') return makeInt(Math.trunc(/** @type {number} */ (v.value)));
  if (v.type === 'string') {
    const s = /** @type {string} */ (v.value).trim();
    if (!/^[+-]?\d+$/.test(s)) throw typeErr(`int() cannot parse '${s}'`);
    return makeInt(Number(s));
  }
  throw typeErr(`int() cannot convert ${v.type}`);
}

/** @param {import('../runtime/values.js').Value} v */
function convertFloat(v) {
  if (isNumeric(v)) return makeFloat(/** @type {number} */ (v.value));
  if (v.type === 'string') {
    const n = Number(/** @type {string} */ (v.value).trim());
    if (!Number.isFinite(n)) throw typeErr(`float() cannot parse '${v.value}'`);
    return makeFloat(n);
  }
  throw typeErr(`float() cannot convert ${v.type}`);
}

/** Datetime field widths for `date(pattern, text)` (clarifications §5). */
const DATE_TOKENS = { YYYY: 4, MM: 2, DD: 2, HH: 2, mm: 2, ss: 2 };

/** @param {import('../ast/nodes.js').CallNode} e @param {EvalContext} ctx */
function evalDate(e, ctx) {
  const args = evalList(e.args, ctx);
  if (args.blocking) return args.blocking;
  const [pat, txt] = /** @type {any} */ (args.values);
  if (!pat || pat.type !== 'string' || !txt || txt.type !== 'string') {
    return err(DiagnosticCode.TYPE_ERROR_RUNTIME, e, 'date(pattern, text) expects two strings');
  }
  return tryApply(() => makeDatetime(parseDate(pat.value, txt.value)), e);
}

/**
 * Minimal datetime parser over the normative token subset (clarifications §5).
 * @param {string} pattern @param {string} text @returns {number} epoch ms UTC
 */
function parseDate(pattern, text) {
  const fields = { YYYY: 1970, MM: 1, DD: 1, HH: 0, mm: 0, ss: 0 };
  let pi = 0;
  let ti = 0;
  while (pi < pattern.length) {
    /** @type {keyof typeof DATE_TOKENS | null} */
    let matched = null;
    for (const name of /** @type {(keyof typeof DATE_TOKENS)[]} */ (Object.keys(DATE_TOKENS))) {
      if (pattern.startsWith(name, pi)) {
        matched = name;
        break;
      }
    }
    if (matched) {
      const width = DATE_TOKENS[matched];
      const slice = text.slice(ti, ti + width);
      if (!/^\d+$/.test(slice)) throw typeErr(`date: expected ${matched} at position ${ti}`);
      fields[matched] = Number(slice);
      pi += matched.length;
      ti += width;
    } else if (pattern[pi] === 'Z') {
      if (text[ti] !== 'Z') throw typeErr("date: expected 'Z'");
      pi += 1;
      ti += 1;
    } else {
      if (text[ti] !== pattern[pi]) throw typeErr(`date: expected '${pattern[pi]}' at ${ti}`);
      pi += 1;
      ti += 1;
    }
  }
  return Date.UTC(fields.YYYY, fields.MM - 1, fields.DD, fields.HH, fields.mm, fields.ss);
}

/* ----------------------------------------------------------------------------------- *
 * Helpers
 * ----------------------------------------------------------------------------------- */

/** @param {import('../ast/nodes.js').CallNode} e */
function varName(e) {
  const n = /** @type {any} */ (e.args[0]);
  return n && n.kind === 'Lit' ? String(n.value) : '';
}

/** @param {unknown} x @returns {import('../runtime/values.js').Value} */
function asValue(x) {
  return isValue(x) ? x : fromJs(x);
}

/**
 * Evaluates a list of expressions, collecting Needs (evaluates all even past a block).
 * @param {import('../ast/nodes.js').Expr[]} exprs @param {EvalContext} ctx
 * @returns {{ values: import('../runtime/values.js').Value[]|null, blocking: EvalResult|null }}
 */
function evalList(exprs, ctx) {
  /** @type {import('../runtime/values.js').Value[]} */
  const values = [];
  /** @type {EvalResult|null} */
  let blocking = null;
  for (const expr of exprs) {
    const r = evaluate(expr, ctx);
    if (r.kind === 'Err') return { values: null, blocking: r };
    if (r.kind === 'Susp') blocking = blocking ?? r;
    else values.push(r.value);
  }
  return { values: blocking ? null : values, blocking };
}

/** @param {() => import('../runtime/values.js').Value} fn @param {import('../ast/nodes.js').Expr} node */
function tryApply(fn, node) {
  try {
    return ok(fn());
  } catch (ex) {
    return errFrom(ex, node);
  }
}

/** @param {import('../runtime/values.js').Value} value @returns {Ok} */
function ok(value) {
  return { kind: 'Ok', value };
}
/** @param {RequirementDescriptor} need @returns {Susp} */
function susp(need) {
  return { kind: 'Susp', need };
}
/** @param {import('../util/errors.js').Diagnostic} diagnostic @returns {Err} */
function errDiag(diagnostic) {
  return { kind: 'Err', diagnostic };
}
/**
 * @param {string} code @param {import('../ast/nodes.js').Expr} node @param {string} message
 * @param {Record<string, unknown>} [data] @returns {Err}
 */
function err(code, node, message, data) {
  return errDiag(
    createDiagnostic(code, {
      severity: 'error',
      phase: 'run',
      recoverable: false,
      message,
      position: /** @type {any} */ (node)?.position,
      data,
    })
  );
}
/** @param {unknown} ex @param {import('../ast/nodes.js').Expr} node @returns {Err} */
function errFrom(ex, node) {
  if (ex instanceof SeeboError) {
    return errDiag(
      createDiagnostic(ex.code ?? DiagnosticCode.TYPE_ERROR_RUNTIME, {
        severity: 'error',
        phase: 'run',
        recoverable: false,
        message: ex.message,
        position: ex.position ?? /** @type {any} */ (node)?.position,
      })
    );
  }
  return err(
    DiagnosticCode.TYPE_ERROR_RUNTIME,
    node,
    ex instanceof Error ? ex.message : String(ex)
  );
}
/** @param {string} msg */
function typeErr(msg) {
  return new SeeboError(msg, { code: DiagnosticCode.TYPE_ERROR_RUNTIME });
}

/** Backwards-compatible re-export for the slice (run.js used these). */
export { toText as renderValue };
