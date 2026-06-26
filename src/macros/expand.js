/**
 * @file EXPAND pre-pass (SPEC §1.8, §2.5; IMPL §10.1): aggregator macros (`ABSORB`,
 * `MERGE`). Composes the document **before** formula resolution by inlining the referenced
 * templates, so the imported requirements later flow into the symbol table (IMPL §8).
 *
 * Properties:
 *  - **Deterministic**: same `{ template, templates }` ⇒ same composed output (`MERGE`
 *    selects by an anchored glob and emits matches in a stable, sorted order).
 *  - **Safe**: recursion is bounded by `limits.maxDepth` ({@link DiagnosticCode.DEPTH_EXCEEDED})
 *    and an inclusion chain detects cycles ({@link DiagnosticCode.INCLUSION_CYCLE}); the
 *    `MERGE` pattern is a linear-time glob, never an arbitrary regex (no ReDoS); no `eval`.
 *  - **Pure**: builds a flat string; everything that is not an aggregator slot (text,
 *    formulas, comments, layout macros) is copied verbatim for the later `run`/`finalize`.
 *
 * The async signature is kept for forward compatibility with asynchronous template sources;
 * with in-memory `templates` it behaves synchronously.
 */

import { parse } from '../parser/index.js';
import { SeeboError, DiagnosticCode } from '../util/errors.js';

const DEFAULT_MAX_DEPTH = 20;

/**
 * @typedef {Object} ExpandArgs
 * @property {string} template  Entry template source.
 * @property {Record<string, string>} [templates]  Named templates available to `ABSORB`/`MERGE`.
 */

/**
 * Expands the aggregator macros of a template into a flat document (IMPL §10.1).
 *
 * @param {ExpandArgs} args
 * @param {import('../index.js').EngineConfig} [config]
 * @returns {Promise<string>}  The composed template source.
 * @throws {SeeboError}  `INCLUSION_CYCLE` on a cyclic inclusion, `DEPTH_EXCEEDED` past `limits.maxDepth`.
 */
export async function expand(args, config) {
  const cfg = config ?? {};
  const templates = args.templates ?? {};
  const maxDepth = cfg.limits?.maxDepth ?? DEFAULT_MAX_DEPTH;
  return expandSource(args.template, templates, [], 0, maxDepth, cfg);
}

/**
 * Recursively expands a single source string. `chain` is the list of template names
 * currently being included (for cycle detection); `depth` is the current inclusion depth.
 * @param {string} source
 * @param {Record<string, string>} templates
 * @param {string[]} chain
 * @param {number} depth
 * @param {number} maxDepth
 * @param {import('../index.js').EngineConfig} cfg
 * @returns {string}
 */
function expandSource(source, templates, chain, depth, maxDepth, cfg) {
  const doc = parse(source, cfg);
  const aggregators = /** @type {import('../ast/nodes.js').MacroNode[]} */ (
    doc.nodes.filter((n) => n.kind === 'Macro' && /** @type {any} */ (n).family === 'aggregator')
  );
  if (aggregators.length === 0) return source;

  let out = '';
  let cursor = 0;
  for (const node of aggregators) {
    out += source.slice(cursor, node.position.start);
    out += expandAggregator(node, templates, chain, depth, maxDepth, cfg);
    cursor = node.position.end;
  }
  out += source.slice(cursor);
  return out;
}

/**
 * Expands one aggregator macro node (`ABSORB`/`MERGE`).
 * @param {import('../ast/nodes.js').MacroNode} node
 * @param {Record<string, string>} templates
 * @param {string[]} chain
 * @param {number} depth
 * @param {number} maxDepth
 * @param {import('../index.js').EngineConfig} cfg
 * @returns {string}
 */
function expandAggregator(node, templates, chain, depth, maxDepth, cfg) {
  if (node.name === 'ABSORB') {
    const name = litString(node.args[0]);
    if (name === undefined) throw syntax('ABSORB expects a template name string', node);
    return includeTemplate(name, templates, chain, depth, maxDepth, cfg);
  }
  if (node.name === 'MERGE') {
    const pattern = litString(node.args[0]);
    if (pattern === undefined) throw syntax('MERGE expects a pattern string', node);
    const separator = litString(node.args[1]) ?? '';
    const names = matchTemplateNames(pattern, templates);
    return names
      .map((name) => includeTemplate(name, templates, chain, depth, maxDepth, cfg))
      .join(separator);
  }
  // Unknown aggregator: leave it out (defensive; parser only tags ABSORB/MERGE as such).
  return '';
}

/**
 * Includes (and recursively expands) a named template, enforcing depth and cycle limits.
 * @param {string} name
 * @param {Record<string, string>} templates
 * @param {string[]} chain
 * @param {number} depth
 * @param {number} maxDepth
 * @param {import('../index.js').EngineConfig} cfg
 * @returns {string}
 */
function includeTemplate(name, templates, chain, depth, maxDepth, cfg) {
  if (chain.includes(name)) {
    throw new SeeboError(`inclusion cycle: ${[...chain, name].join(' → ')}`, {
      code: DiagnosticCode.INCLUSION_CYCLE,
    });
  }
  if (depth + 1 > maxDepth) {
    throw new SeeboError(`inclusion depth exceeded (limit ${maxDepth})`, {
      code: DiagnosticCode.DEPTH_EXCEEDED,
    });
  }
  if (!Object.prototype.hasOwnProperty.call(templates, name)) return ''; // missing ⇒ empty
  return expandSource(templates[name], templates, [...chain, name], depth + 1, maxDepth, cfg);
}

/**
 * Returns the template names matching an anchored glob `pattern`, in stable sorted order.
 * Only `*` (any run) and `?` (single char) are special; everything else is literal. The
 * translation is linear-time (no backtracking) to avoid ReDoS (SPEC §1.8).
 * @param {string} pattern
 * @param {Record<string, string>} templates
 * @returns {string[]}
 */
function matchTemplateNames(pattern, templates) {
  const re = globToRegExp(pattern);
  return Object.keys(templates)
    .filter((name) => re.test(name))
    .sort();
}

/** @param {string} glob @returns {RegExp} */
function globToRegExp(glob) {
  let body = '';
  for (const ch of glob) {
    if (ch === '*') body += '.*';
    else if (ch === '?') body += '.';
    else body += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${body}$`);
}

/** Reads a string literal argument, or `undefined` if absent/not a string. @param {import('../ast/nodes.js').Expr} [expr] @returns {string|undefined} */
function litString(expr) {
  const e = /** @type {any} */ (expr);
  if (e && e.kind === 'Lit' && e.type === 'string') return /** @type {string} */ (e.value);
  return undefined;
}

/** @param {string} message @param {import('../ast/nodes.js').Node} node @returns {SeeboError} */
function syntax(message, node) {
  return new SeeboError(message, {
    code: DiagnosticCode.SYNTAX_ERROR,
    position: /** @type {any} */ (node)?.position,
  });
}
