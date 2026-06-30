/**
 * @file Static validity analysis (SPEC §2.3 / §1.10, IMPL §8). Pure and accumulating:
 * `validate` never throws — it returns a list of {@link import('../util/errors.js').Diagnostic}
 * (empty = valid). It parses the template, builds the static symbol table (IMPL §8) and
 * walks the AST reporting:
 *
 *  - {@link DiagnosticCode.UNDECLARED_NAME} — a reference to an undeclared identifier;
 *  - {@link DiagnosticCode.UNKNOWN_FUNCTION} — a call to an unknown producer/library;
 *  - {@link DiagnosticCode.UNKNOWN_CAPABILITY} — a `need` citing an unregistered capability;
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
import {
  collectDeclarations,
  extractRequirement,
  extractActionStatic,
  applyCapabilityContract,
} from '../eval/symbols.js';
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
  const capabilityContracts = /** @type {any} */ (cfg).capabilityContracts;
  const allowedCapabilities = cfg.policy?.allowedCapabilities;
  const allowedTypes = cfg.policy?.allowedTypes;
  const allowedFunctions = cfg.policy?.allowedFunctions;
  const libraries = new Set(cfg.libraries ?? []);
  const registry = /** @type {any} */ (cfg).registry;
  const actionPolicy = /** @type {any} */ (cfg.policy)?.action ?? {};
  /** Action ids seen so far, for duplicate detection across the document. @type {Set<string>} */
  const seenActionIds = new Set();

  /**
   * Emits {@link DiagnosticCode.POLICY_FORBIDDEN} when an allow-list is present and excludes
   * `name`. A missing allow-list (`undefined`) imposes no restriction (SPEC §2.2).
   * @param {string[] | undefined} allowList @param {'type'|'function'} kind
   * @param {string} name @param {import('../ast/nodes.js').Expr} node
   */
  function checkPolicy(allowList, kind, name, node) {
    if (allowList && !allowList.includes(name)) {
      diagnostics.push(
        diag(DiagnosticCode.POLICY_FORBIDDEN, node, `${kind} '${name}' is forbidden by policy`, {
          kind,
          name,
        })
      );
    }
  }

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
        // A library function is part of the function vocabulary (`policy.allowedFunctions`),
        // gated by its qualified `ns.name`.
        checkPolicy(allowedFunctions, 'function', `${e.ns}.${e.name}`, e);
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
    if (callee === 'need') {
      validateRequire(call);
      for (const arg of call.args) walk(arg);
      return declaredCallType(call);
    }
    if (callee === 'bind') {
      validateBind(call);
      // The bound type is the descriptor's type; the descriptor (2nd arg) is walked by validateBind.
      return declaredBindType(call);
    }
    if (callee === 'action') {
      validateAction(call);
      for (const arg of call.args) walk(arg);
      return 'string'; // an action declaration emits the empty string
    }
    if (TYPE_NAMES.has(callee)) {
      checkPolicy(allowedTypes, 'type', callee, call);
      checkArity(call, callee, 0, 1);
      for (const arg of call.args) walk(arg);
      return /** @type {import('./infer.js').InferredType} */ (callee);
    }
    if (callee in PRODUCERS) {
      checkPolicy(allowedFunctions, 'function', callee, call);
      const p = PRODUCERS[callee];
      checkArity(call, callee, p.min, p.max);
      checkArgs(call.callee, call.args, p.args ?? []);
      return p.ret;
    }
    const custom = registry?.getProducer?.(callee);
    if (custom) {
      checkPolicy(allowedFunctions, 'function', callee, call);
      if (custom.arity) checkArity(call, callee, custom.arity.min, custom.arity.max);
      for (const arg of call.args) walk(arg);
      return 'unknown';
    }
    // A custom type constructor `T(value)` (defineType): one value argument (SPEC §2.6).
    if (registry?.getType?.(callee)) {
      checkPolicy(allowedTypes, 'type', callee, call);
      checkArity(call, callee, 1, 1);
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
      // A custom transformer registered for this receiver type takes over (SPEC §2.6); as a
      // function it is also subject to `policy.allowedFunctions`.
      if (registry?.getTransformer?.(recvType, method.name)) {
        checkPolicy(allowedFunctions, 'function', method.name, method);
        return 'unknown';
      }
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
        diag(
          DiagnosticCode.ARITY_MISMATCH,
          node,
          `'${name}' expects ${want} argument(s), got ${n}`,
          {
            name,
          }
        )
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
   * Resolves the declared base type of a `need(...)` call: the descriptor's `type`, after merging
   * the capability contract (so an inherited type is reported), normalized to `'unknown'` for
   * custom (non-builtin) types.
   * @param {import('../ast/nodes.js').CallNode} call
   * @returns {import('./infer.js').InferredType}
   */
  function declaredCallType(call) {
    try {
      const d = applyCapabilityContract(extractRequirement(call), capabilityContracts);
      return normalizeType(/** @type {any} */ (d).type?.type);
    } catch {
      return 'unknown';
    }
  }

  /**
   * Resolves the inferred type of a `bind('name', descriptor)` — the type of its descriptor
   * (the 2nd argument), obtained by walking it. A malformed/missing descriptor is `'unknown'`.
   * @param {import('../ast/nodes.js').CallNode} call
   * @returns {import('./infer.js').InferredType}
   */
  function declaredBindType(call) {
    const desc = /** @type {any} */ (call.args[1]);
    if (!desc) return 'unknown';
    // Side-effect-free type inference (diagnostics are emitted by validateBind, not here):
    if (desc.kind === 'Call') {
      if (desc.callee === 'need') return declaredCallType(desc); // requirement's (inherited) type
      if (desc.callee === 'action') return 'string'; // an action binding renders the empty string
      if (TYPE_NAMES.has(desc.callee)) return /** @type {any} */ (desc.callee); // bare builder `int()`
    }
    if (desc.kind === 'Method') return builderBaseType(desc); // builder chain root, e.g. int().default(1)
    return 'unknown';
  }

  /**
   * Validates a `bind('name', descriptor)` declaration: the name must be a string literal, and a
   * descriptor must be present. The descriptor (a type-builder, `need(...)` or `action(...)`) is
   * walked so its own diagnostics (capability/action checks) are reported.
   * @param {import('../ast/nodes.js').CallNode} call
   */
  function validateBind(call) {
    const nameNode = /** @type {any} */ (call.args[0]);
    if (!nameNode || nameNode.kind !== 'Lit' || nameNode.type !== 'string') {
      diagnostics.push(diag(DiagnosticCode.SYNTAX_ERROR, call, 'bind(...) expects a string name'));
    }
    const desc = /** @type {any} */ (call.args[1]);
    if (desc === undefined) {
      diagnostics.push(
        diag(
          DiagnosticCode.SYNTAX_ERROR,
          call,
          'bind(...) needs a descriptor (type, need(...) or action(...))'
        )
      );
      return;
    }
    // The descriptor must be a type-builder, `need(...)` or `action(...)`; anything else (a bare
    // literal, an arbitrary expression) is reported clearly rather than leaving the bound name
    // unregistered (which would surface as a misleading `UNDECLARED_NAME` at the use site).
    if (!isBindDescriptor(desc)) {
      diagnostics.push(
        diag(
          DiagnosticCode.SYNTAX_ERROR,
          desc,
          'bind(...) descriptor must be a type, need(...) or action(...)'
        )
      );
      return;
    }
    // Walk `need(...)`/`action(...)` so their own diagnostics (capability/action checks) surface.
    // A type-builder descriptor (`int().constraints({...})`) is NOT walked as an expression: its
    // chained `.constraints`/`.format`/`.default` are builder configuration, not value methods, so
    // walking it would mis-report `UNKNOWN_METHOD`. Its well-formedness is checked at run/extract.
    if (desc.kind === 'Call' && (desc.callee === 'need' || desc.callee === 'action')) {
      walk(desc);
    }
  }

  /**
   * Validates a `need({...})` call: the capability must be registered and allowed by policy. The
   * `capability` is read directly from the descriptor object, so it is checked even when the `id`
   * is supplied by an enclosing `bind` (and therefore absent from the descriptor itself).
   * @param {import('../ast/nodes.js').CallNode} call
   */
  function validateRequire(call) {
    const cap = capabilityOf(call);
    if (cap === undefined) return; // malformed descriptor; surfaced as a syntax issue by parse/run
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

  /**
   * Validates an `action({...})` declaration statically (SPEC §2.8): required fields, duplicate
   * id, unknown/forbidden type, invalid flags/retry/environment. Best-effort: dynamic fields are
   * deferred to run/execution time.
   * @param {import('../ast/nodes.js').CallNode} call
   */
  function validateAction(call) {
    const obj = call.args[0];
    if (!obj || obj.kind !== 'ObjectLit') {
      diagnostics.push(
        diag(DiagnosticCode.INVALID_ACTION, call, 'action(...) expects a descriptor object')
      );
      return;
    }
    /** @type {Record<string, import('../ast/nodes.js').Expr>} */
    const byKey = {};
    for (const e of /** @type {import('../ast/nodes.js').ObjectLitNode} */ (obj).entries) {
      if (e.key !== '__proto__') byKey[e.key] = e.value;
    }

    let info;
    try {
      info = extractActionStatic(call);
    } catch {
      diagnostics.push(diag(DiagnosticCode.INVALID_ACTION, call, 'malformed action descriptor'));
      return;
    }

    if (byKey.id === undefined) {
      diagnostics.push(diag(DiagnosticCode.INVALID_ACTION, call, "action(...) needs an 'id'"));
    } else if (info.id === undefined && isLiteralKind(byKey.id)) {
      diagnostics.push(
        diag(DiagnosticCode.INVALID_ACTION, byKey.id, "action 'id' must be a string")
      );
    }
    if (byKey.type === undefined) {
      diagnostics.push(diag(DiagnosticCode.INVALID_ACTION, call, "action(...) needs a 'type'"));
    } else if (info.type === undefined && isLiteralKind(byKey.type)) {
      diagnostics.push(
        diag(DiagnosticCode.INVALID_ACTION, byKey.type, "action 'type' must be a string")
      );
    }

    // Duplicate id (only statically detectable for literal ids).
    if (info.id !== undefined) {
      if (seenActionIds.has(info.id)) {
        diagnostics.push(
          diag(DiagnosticCode.DUPLICATE_ACTION_ID, call, `duplicate action id '${info.id}'`, {
            id: info.id,
          })
        );
      }
      seenActionIds.add(info.id);
    }

    // Unknown/forbidden type against registered handlers and action policy.
    if (info.type !== undefined) {
      if (registry?.hasAction && !registry.hasAction(info.type)) {
        diagnostics.push(
          diag(
            DiagnosticCode.UNKNOWN_ACTION_TYPE,
            byKey.type ?? call,
            `no handler registered for action type '${info.type}'`,
            {
              type: info.type,
            }
          )
        );
      }
      if (
        Array.isArray(actionPolicy.deniedActions) &&
        actionPolicy.deniedActions.includes(info.type)
      ) {
        diagnostics.push(
          diag(
            DiagnosticCode.POLICY_FORBIDDEN,
            call,
            `action type '${info.type}' is denied by policy`,
            {
              kind: 'action',
              name: info.type,
            }
          )
        );
      } else if (
        Array.isArray(actionPolicy.allowedActions) &&
        !actionPolicy.allowedActions.includes(info.type)
      ) {
        diagnostics.push(
          diag(
            DiagnosticCode.POLICY_FORBIDDEN,
            call,
            `action type '${info.type}' is not in allowedActions`,
            {
              kind: 'action',
              name: info.type,
            }
          )
        );
      }
    }

    // Flag/retry shape checks where statically present.
    checkActionFlag(byKey.confirm, 'confirm', 'bool');
    checkActionFlag(byKey.dryRun, 'dryRun', 'bool');
    checkActionRetry(byKey.retry);

    // Environment against policy allow-list (only for literal environments).
    if (
      info.environment !== undefined &&
      Array.isArray(actionPolicy.allowedEnvironments) &&
      !actionPolicy.allowedEnvironments.includes(info.environment)
    ) {
      diagnostics.push(
        diag(
          DiagnosticCode.POLICY_FORBIDDEN,
          byKey.environment ?? call,
          `environment '${info.environment}' is not allowed by policy`,
          {
            kind: 'environment',
            name: info.environment,
          }
        )
      );
    }
  }

  /** @param {import('../ast/nodes.js').Expr | undefined} expr @param {string} name @param {'bool'} kind */
  function checkActionFlag(expr, name, kind) {
    const e = /** @type {any} */ (expr);
    if (e && e.kind === 'Lit' && e.type !== kind) {
      diagnostics.push(
        diag(DiagnosticCode.INVALID_ACTION, expr, `action '${name}' must be a ${kind}`)
      );
    }
  }

  /** @param {import('../ast/nodes.js').Expr | undefined} expr */
  function checkActionRetry(expr) {
    const e = /** @type {any} */ (expr);
    if (!e) return;
    if (e.kind !== 'ObjectLit') {
      diagnostics.push(
        diag(DiagnosticCode.INVALID_ACTION, expr, "action 'retry' must be an object")
      );
      return;
    }
    for (const entry of e.entries) {
      const v = /** @type {any} */ (entry.value);
      if (
        entry.key === 'attempts' &&
        v.kind === 'Lit' &&
        (v.type !== 'int' || /** @type {number} */ (v.value) < 0)
      ) {
        diagnostics.push(
          diag(
            DiagnosticCode.INVALID_ACTION,
            entry.value,
            "action 'retry.attempts' must be a non-negative integer"
          )
        );
      }
      if (
        entry.key === 'strategy' &&
        v.kind === 'Lit' &&
        v.value !== 'fixed' &&
        v.value !== 'exponential'
      ) {
        diagnostics.push(
          diag(
            DiagnosticCode.INVALID_ACTION,
            entry.value,
            "action 'retry.strategy' must be 'fixed' or 'exponential'"
          )
        );
      }
    }
  }

  for (const node of ast.nodes) {
    if (node.kind === 'Formula') walk(/** @type {any} */ (node).expr);
    else if (node.kind === 'Macro') for (const a of /** @type {any} */ (node).args) walk(a);
  }
  return diagnostics;
}

/** `true` when an expression is a literal node (used to decide whether a non-string id/type is a static error). @param {import('../ast/nodes.js').Expr} expr @returns {boolean} */
function isLiteralKind(expr) {
  return /** @type {any} */ (expr)?.kind === 'Lit';
}

/**
 * `true` when `expr` is a valid `bind` descriptor: `need(...)`, `action(...)`, or a type-builder
 * (`int()`, `string().constraints({...})` — a `Call` to a builtin type, or a `Method` chain rooted
 * in one). Anything else (a bare literal, an arbitrary expression) is rejected by `validate`.
 * @param {import('../ast/nodes.js').Expr} expr
 * @returns {boolean}
 */
function isBindDescriptor(expr) {
  const e = /** @type {any} */ (expr);
  if (!e || typeof e !== 'object') return false;
  if (e.kind === 'Call')
    return e.callee === 'need' || e.callee === 'action' || TYPE_NAMES.has(e.callee);
  if (e.kind === 'Method') return isBindDescriptor(e.receiver); // builder chain (.constraints/.default/…)
  return false;
}

/**
 * Returns the base type at the root of a type-builder chain (`int().default(1)` → `'int'`), or
 * `'unknown'` if the root is not a builtin type builder. Side-effect free.
 * @param {import('../ast/nodes.js').Expr} expr
 * @returns {import('./infer.js').InferredType}
 */
function builderBaseType(expr) {
  let e = /** @type {any} */ (expr);
  while (e && e.kind === 'Method') e = e.receiver;
  if (e && e.kind === 'Call' && TYPE_NAMES.has(e.callee)) {
    return /** @type {import('./infer.js').InferredType} */ (e.callee);
  }
  return 'unknown';
}

/**
 * Reads the literal `capability` string from a `need({...})` descriptor, independent of the `id`
 * (which a `bind` may supply). Returns `undefined` when the descriptor is missing/non-literal.
 * @param {import('../ast/nodes.js').CallNode} call
 * @returns {string | undefined}
 */
function capabilityOf(call) {
  const obj = /** @type {any} */ (call.args[0]);
  if (!obj || obj.kind !== 'ObjectLit') return undefined;
  for (const entry of obj.entries) {
    if (entry.key === 'capability') {
      const v = /** @type {any} */ (entry.value);
      return v.kind === 'Lit' && v.type === 'string' ? /** @type {string} */ (v.value) : undefined;
    }
  }
  return undefined;
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
