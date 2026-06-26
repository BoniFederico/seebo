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
 *  - {@link DiagnosticCode.NON_EXHAUSTIVE_MATCH} — a `match` with no `*` default arm (IMPL §3/B.3).
 *
 * A malformed template (which makes `parse` throw, unlike `tokenize`/`validate`) is surfaced
 * here as a single non-recoverable {@link DiagnosticCode.SYNTAX_ERROR}.
 */

import { parse } from '../parser/index.js';
import { collectDeclarations, extractRequirement } from '../eval/symbols.js';
import { createDiagnostic, DiagnosticCode, SeeboError } from '../util/errors.js';

/** Builtin producer names that are valid call targets besides the type builders. */
const BUILTIN_PRODUCERS = new Set(['require', 'var', 'now', 'date']);

/** Builtin type names usable as producers/builders (SPEC §1.5). */
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

  /** @type {import('../util/errors.js').Diagnostic[]} */
  const diagnostics = [];

  /** @param {import('../ast/nodes.js').Expr} expr */
  function walk(expr) {
    if (!expr || typeof expr !== 'object') return;
    const e = /** @type {any} */ (expr);
    switch (e.kind) {
      case 'Ref':
        if (!symbols.has(e.name)) {
          diagnostics.push(
            diag(DiagnosticCode.UNDECLARED_NAME, e, `'${e.name}' is not declared`, { name: e.name })
          );
        }
        return;
      case 'Ternary':
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
        walk(e.cond);
        walk(e.then);
        walk(e.else);
        return;
      case 'Call':
        validateCall(e);
        for (const arg of e.args) walk(arg);
        return;
      case 'Method':
        walk(e.receiver);
        for (const arg of e.args) walk(arg);
        return;
      case 'Member':
        walk(e.receiver);
        return;
      case 'Namespace':
        if (!libraries.has(e.ns)) {
          diagnostics.push(
            diag(DiagnosticCode.UNKNOWN_FUNCTION, e, `library '${e.ns}' is not enabled`, {
              name: `${e.ns}.${e.name}`,
            })
          );
        }
        for (const arg of e.args) walk(arg);
        return;
      case 'Unary':
        walk(e.arg);
        return;
      case 'Binary':
        walk(e.left);
        walk(e.right);
        return;
      case 'ObjectLit':
        for (const entry of e.entries) walk(entry.value);
        return;
      case 'ArrayLit':
        for (const el of e.elements) walk(el);
        return;
      default:
        return;
    }
  }

  /** @param {import('../ast/nodes.js').CallNode} call */
  function validateCall(call) {
    const callee = call.callee;
    if (callee === 'require') {
      validateRequire(call);
      return;
    }
    if (BUILTIN_PRODUCERS.has(callee) || TYPE_NAMES.has(callee)) return;
    diagnostics.push(
      diag(DiagnosticCode.UNKNOWN_FUNCTION, call, `unknown function '${callee}'`, { name: callee })
    );
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
