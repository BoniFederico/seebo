/**
 * @file Static validity analysis (SPEC §2.3 / §1.10, IMPL §8). Pure and accumulating:
 * `validate` never throws — it returns a list of {@link import('../util/errors.js').Diagnostic}
 * (empty = valid). It parses the template, builds the static symbol table (IMPL §8) and
 * walks the AST reporting:
 *
 *  - {@link DiagnosticCode.UNDECLARED_NAME} — a reference to an undeclared identifier;
 *  - {@link DiagnosticCode.UNKNOWN_FUNCTION} — a call to an unknown producer/library;
 *  - {@link DiagnosticCode.UNKNOWN_CAPABILITY} — a `require` citing an unregistered capability;
 *  - {@link DiagnosticCode.POLICY_FORBIDDEN} — a capability excluded by `policy.allowedCapabilities`;
 *  - {@link DiagnosticCode.NON_EXHAUSTIVE_MATCH} — a `match` with no `*` default arm (IMPL §3/B.3);
 *  - {@link DiagnosticCode.UNKNOWN_METHOD} — a method that does not exist on the (statically
 *    inferred) receiver type;
 *  - {@link DiagnosticCode.ARITY_MISMATCH} — a builtin/custom call or method with the wrong
 *    number of arguments;
 *  - {@link DiagnosticCode.TYPE_ERROR} — an operator/argument type violation provable from
 *    statically known types.
 *
 * The last three rely on a conservative static type inferencer ({@link ./infer.js}): any type
 * that cannot be proven collapses to `'unknown'`, which suppresses the corresponding check so
 * `validate` never produces a false positive.
 *
 * A malformed template (which makes `parse` throw, unlike `tokenize`/`validate`) is surfaced
 * here as a single non-recoverable {@link DiagnosticCode.SYNTAX_ERROR}.
 */

import { parse } from '../parser/index.js';
import { collectDeclarations, extractRequirement } from '../eval/symbols.js';
import { createDiagnostic, DiagnosticCode, SeeboError } from '../util/errors.js';
import {
  TYPE_NAMES,
  PRODUCERS,
  methodSig,
  argMatches,
  binaryResult,
  unaryResult,
} from './infer.js';

/**
 * Runs the static validity analysis over a template. Pure; never throws.
 *
 * @param {string} template  Raw template source.
 * @param {import('../index.js').EngineConfig} [config]
 * @returns {import('../util/errors.js').Diagnostic[]}  Diagnostics in source order; empty when valid.
 */
export function validate(template, config) {
  const cfg = config ?? {};

  /** @type {import('../ast/nodes.js').Document} */
  let ast;
  try {
    ast = parse(template, cfg);
  } catch (e) {
    return [
      createDiagnostic(
        e instanceof SeeboError
          ? (e.code ?? DiagnosticCode.SYNTAX_ERROR)
          : DiagnosticCode.SYNTAX_ERROR,
        {
          phase: 'validate',
          recoverable: false,
          message: e instanceof Error ? e.message : String(e),
          position: e instanceof SeeboError ? e.position : undefined,
        }
      ),
    ];
  }

  const symbols = collectDeclarations(ast);
  const capabilities = new Set(Object.keys(cfg.capabilities ?? {}));
  const allowedCapabilities = cfg.policy?.allowedCapabilities;
  const libraries = new Set(cfg.libraries ?? []);
  const registry = /** @type {any} */ (cfg).registry;

  /** @type {import('../util/errors.js').Diagnostic[]} */
  const diagnostics = [];

  /**
   * Walks an expression, emitting diagnostics and returning its statically inferred type
   * (see {@link ./infer.js}). `'unknown'` means "not provable" and suppresses type checks.
   * @param {import('../ast/nodes.js').Expr} expr
   * @returns {import('./infer.js').InferredType}
   */
  function walk(expr) {
    if (!expr || typeof expr !== 'object') return 'unknown';
    const e = /** @type {any} */ (expr);
    switch (e.kind) {
      case 'Lit':
        return e.type === 'int' || e.type === 'float' || e.type === 'bool' || e.type === 'string'
          ? e.type
          : 'unknown';
      case 'Ref': {
        if (!symbols.has(e.name)) {
          diagnostics.push(
            diag(DiagnosticCode.UNDECLARED_NAME, e, `'${e.name}' is not declared`, { name: e.name })
          );
          return 'unknown';
        }
        return declaredType(symbols.get(e.name));
      }
      case 'Ternary': {
        if (e.nonExhaustiveMatch === true) {
          diagnostics.push(
            diag(
              DiagnosticCode.NON_EXHAUSTIVE_MATCH,
              e,
              'match is not exhaustive (no default arm)',
              {}
            )
          );
        }
        const cond = walk(e.cond);
        if (cond !== 'unknown' && cond !== 'bool') {
          diagnostics.push(
            diag(DiagnosticCode.TYPE_ERROR, e.cond, `ternary condition must be bool, got ${cond}`)
          );
        }
        const then = walk(e.then);
        const els = walk(e.else);
        return then === els ? then : 'unknown';
      }
      case 'Call':
        return validateCall(e);
      case 'Method':
        return validateMethod(e);
      case 'Member':
        walk(e.receiver);
        return 'unknown';
      case 'Namespace':
        if (!libraries.has(e.ns)) {
          diagnostics.push(
            diag(DiagnosticCode.UNKNOWN_FUNCTION, e, `library '${e.ns}' is not enabled`, {
              name: `${e.ns}.${e.name}`,
            })
          );
        }
        for (const arg of e.args) walk(arg);
        return 'unknown';
      case 'Unary': {
        const t = walk(e.arg);
        const res = unaryResult(e.op, t);
        if ('error' in res) diagnostics.push(diag(DiagnosticCode.TYPE_ERROR, e, res.error));
        return 'error' in res ? 'unknown' : res.ret;
      }
      case 'Binary': {
        const l = walk(e.left);
        const r = walk(e.right);
        const res = binaryResult(e.op, l, r);
        if ('error' in res) diagnostics.push(diag(DiagnosticCode.TYPE_ERROR, e, res.error));
        return 'error' in res ? 'unknown' : res.ret;
      }
      case 'ObjectLit':
        for (const entry of e.entries) walk(entry.value);
        return 'object';
      case 'ArrayLit':
        for (const el of e.elements) walk(el);
        return 'array';
      default:
        return 'unknown';
    }
  }

  /**
   * Validates a producer call and returns its inferred result type.
   * @param {import('../ast/nodes.js').CallNode} call
   * @returns {import('./infer.js').InferredType}
   */
  function validateCall(call) {
    const callee = call.callee;
    if (callee === 'require') {
      validateRequire(call);
      for (const arg of call.args) walk(arg);
      return declaredCallType(call);
    }
    if (callee === 'var') {
      for (const arg of call.args) walk(arg);
      return declaredCallType(call);
    }
    if (TYPE_NAMES.has(callee)) {
      checkArity(call, callee, 0, 1);
      for (const arg of call.args) walk(arg);
      return /** @type {import('./infer.js').InferredType} */ (callee);
    }
    if (callee in PRODUCERS) {
      const p = PRODUCERS[callee];
      checkArity(call, callee, p.min, p.max);
      checkArgs(call.callee, call.args, p.args ?? []);
      return p.ret;
    }
    const custom = registry?.getProducer?.(callee);
    if (custom) {
      if (custom.arity) checkArity(call, callee, custom.arity.min, custom.arity.max);
      for (const arg of call.args) walk(arg);
      return 'unknown';
    }
    diagnostics.push(
      diag(DiagnosticCode.UNKNOWN_FUNCTION, call, `unknown function '${callee}'`, { name: callee })
    );
    for (const arg of call.args) walk(arg);
    return 'unknown';
  }

  /**
   * Validates a transformer method call and returns its inferred result type.
   * @param {import('../ast/nodes.js').MethodNode} method
   * @returns {import('./infer.js').InferredType}
   */
  function validateMethod(method) {
    const recvType = walk(method.receiver);
    const argTypes = method.args.map(walk);

    // A non-builtin receiver type (unknown or a custom type) suppresses method/arity checks.
    if (!TYPE_NAMES.has(recvType)) return 'unknown';

    const s = methodSig(recvType, method.name);
    if (!s) {
      // A custom transformer registered for this receiver type takes over (SPEC §2.6).
      if (registry?.getTransformer?.(recvType, method.name)) return 'unknown';
      diagnostics.push(
        diag(
          DiagnosticCode.UNKNOWN_METHOD,
          method,
          `unknown method '${method.name}' on ${recvType}`,
          { type: recvType, name: method.name }
        )
      );
      return 'unknown';
    }

    checkArity(method, method.name, s.min, s.max);
    for (let i = 0; i < s.args.length && i < argTypes.length; i++) {
      if (!argMatches(s.args[i], argTypes[i])) {
        diagnostics.push(
          diag(
            DiagnosticCode.TYPE_ERROR,
            method.args[i],
            `'${method.name}' argument ${i + 1} expects ${s.args[i]}, got ${argTypes[i]}`
          )
        );
      }
    }
    return s.ret === 'self' ? recvType : s.ret;
  }

  /**
   * Emits {@link DiagnosticCode.ARITY_MISMATCH} when an argument count is out of range.
   * @param {import('../ast/nodes.js').Expr} node @param {string} name
   * @param {number} min @param {number} max
   */
  function checkArity(node, name, min, max) {
    const n = /** @type {any} */ (node).args.length;
    if (n < min || n > max) {
      const want = min === max ? `${min}` : `${min}..${max}`;
      diagnostics.push(
        diag(DiagnosticCode.ARITY_MISMATCH, node, `'${name}' expects ${want} argument(s), got ${n}`, {
          name,
        })
      );
    }
  }

  /**
   * Type-checks the positional arguments of a builtin producer.
   * @param {string} name @param {import('../ast/nodes.js').Expr[]} args
   * @param {import('./infer.js').ArgClass[]} expected
   */
  function checkArgs(name, args, expected) {
    for (let i = 0; i < expected.length && i < args.length; i++) {
      const t = walk(args[i]);
      if (!argMatches(expected[i], t)) {
        diagnostics.push(
          diag(
            DiagnosticCode.TYPE_ERROR,
            args[i],
            `'${name}' argument ${i + 1} expects ${expected[i]}, got ${t}`
          )
        );
      }
    }
  }

  /**
   * Resolves the declared base type of a `require`/`var` call (the descriptor's `type`),
   * normalized to `'unknown'` for custom (non-builtin) types.
   * @param {import('../ast/nodes.js').CallNode} call
   * @returns {import('./infer.js').InferredType}
   */
  function declaredCallType(call) {
    try {
      const d = extractRequirement(call);
      return normalizeType(/** @type {any} */ (d).type?.type);
    } catch {
      return 'unknown';
    }
  }

  /** @param {import('../ast/nodes.js').CallNode} call */
  function validateRequire(call) {
    let descriptor;
    try {
      descriptor = extractRequirement(call);
    } catch {
      // A malformed descriptor is reported as a syntax-level issue by parse/run; skip here.
      return;
    }
    const cap = descriptor.capability;
    if (cap && !capabilities.has(cap)) {
      diagnostics.push(
        diag(DiagnosticCode.UNKNOWN_CAPABILITY, call, `capability '${cap}' is not registered`, {
          capability: cap,
        })
      );
    }
    if (cap && allowedCapabilities && !allowedCapabilities.includes(cap)) {
      diagnostics.push(
        diag(DiagnosticCode.POLICY_FORBIDDEN, call, `capability '${cap}' is forbidden by policy`, {
          kind: 'capability',
          name: cap,
        })
      );
    }
  }

  for (const node of ast.nodes) {
    if (node.kind === 'Formula') walk(/** @type {any} */ (node).expr);
    else if (node.kind === 'Macro') for (const a of /** @type {any} */ (node).args) walk(a);
  }
  return diagnostics;
}

/**
 * Reads the declared base type of a symbol-table entry, normalized to `'unknown'`.
 * @param {{ descriptor?: { type?: { type?: string } } } | undefined} entry
 * @returns {import('./infer.js').InferredType}
 */
function declaredType(entry) {
  return normalizeType(entry?.descriptor?.type?.type);
}

/**
 * Maps a raw type name to the inference lattice: builtin base types pass through; anything
 * else (custom types, missing) becomes `'unknown'` so it suppresses static checks.
 * @param {string | undefined} name
 * @returns {import('./infer.js').InferredType}
 */
function normalizeType(name) {
  return name && TYPE_NAMES.has(name)
    ? /** @type {import('./infer.js').InferredType} */ (name)
    : 'unknown';
}

/**
 * Builds a `validate`-phase, recoverable diagnostic.
 * @param {string} code @param {import('../ast/nodes.js').Expr} node @param {string} message
 * @param {Record<string, unknown>} [data] @returns {import('../util/errors.js').Diagnostic}
 */
function diag(code, node, message, data) {
  return createDiagnostic(code, {
    severity: 'error',
    phase: 'validate',
    recoverable: true,
    message,
    position: /** @type {any} */ (node)?.position,
    data,
  });
}
