/**
 * @file Parser barrel (IMPL §3). Exposes the SPEC §2.3 public `parse(template, config)`
 * which tokenizes (via the lexer) and delegates to the token-consuming
 * {@link ./parser.js} `parse(tokens, options)`. Re-exports the `PRECEDENCE` table.
 */

import { tokenize } from '../lexer/lexer.js';
import { parse as parseTokens, PRECEDENCE } from './parser.js';
import { DEFAULT_LIMITS } from '../util/limits.js';
import { SeeboError, DiagnosticCode } from '../util/errors.js';

export { PRECEDENCE };

/**
 * In-memory parse cache (IMPL §11 / §6.1). Opt-in via `optimizations.astCache`. Keyed by the
 * config object identity (a `WeakMap`, so it is collected with the engine and never mixes
 * vocabularies/delimiters across engines) and then by the template string. The AST is a pure
 * function of `(config, template)`, so returning a shared, read-only Document is sound.
 * @type {WeakMap<object, Map<string, import('../ast/nodes.js').Document>>}
 */
const AST_CACHE = new WeakMap();

/** Upper bound on cached templates per engine; cleared wholesale when exceeded. */
const MAX_CACHE_ENTRIES = 512;

/**
 * Parses a template string into the AST (SPEC §2.3). Throws a `SYNTAX_ERROR` with a
 * position on malformed input. As the gateway to all execution, it also enforces the
 * resource limits (IMPL §13): input length and token count here, AST node count and
 * nesting depth inside the token parser. Capability sugar and library namespaces are
 * resolved when the engine config provides the registered names (IMPL §3). With
 * `optimizations.astCache` the result is memoized per `(config, template)` (IMPL §11).
 *
 * @param {string} template
 * @param {import('../index.js').EngineConfig} [config]
 * @returns {import('../ast/nodes.js').Document}
 * @throws {import('../util/errors.js').SeeboError}  On malformed input or an exceeded limit.
 */
export function parse(template, config) {
  const bucket = cacheBucket(config);
  if (bucket) {
    const hit = bucket.get(template);
    if (hit) return hit;
    const doc = parseUncached(template, config);
    if (bucket.size >= MAX_CACHE_ENTRIES) bucket.clear();
    bucket.set(template, doc);
    return doc;
  }
  return parseUncached(template, config);
}

/** Returns the per-config cache bucket when `astCache` is enabled, else `undefined`. @param {import('../index.js').EngineConfig} [config] */
function cacheBucket(config) {
  if (!config || !config.optimizations?.astCache) return undefined;
  let bucket = AST_CACHE.get(config);
  if (!bucket) {
    bucket = new Map();
    AST_CACHE.set(config, bucket);
  }
  return bucket;
}

/**
 * The actual parse work (tokenize + token parse) plus the parse-time resource limits.
 * @param {string} template
 * @param {import('../index.js').EngineConfig} [config]
 * @returns {import('../ast/nodes.js').Document}
 */
function parseUncached(template, config) {
  const limits = config?.limits ?? {};
  const maxInputBytes = limits.maxInputBytes ?? DEFAULT_LIMITS.maxInputBytes;
  if (template.length > maxInputBytes) {
    throw new SeeboError(`template exceeds maxInputBytes (${maxInputBytes})`, {
      code: DiagnosticCode.INPUT_LIMIT_EXCEEDED,
    });
  }

  const tokens = tokenize(template, config);
  const maxTokens = limits.maxTokens ?? DEFAULT_LIMITS.maxTokens;
  if (tokens.length > maxTokens) {
    throw new SeeboError(`template exceeds maxTokens (${maxTokens})`, {
      code: DiagnosticCode.TOKEN_LIMIT_EXCEEDED,
    });
  }

  return parseTokens(tokens, {
    source: template,
    delimiters: config?.delimiters,
    capabilities: config?.capabilities ? Object.keys(config.capabilities) : [],
    libraries: libraryNames(config),
    macros: macroFamilies(config),
    limits,
  });
}

/**
 * Library namespaces enabled for `Namespace` parsing — from the built registry when present,
 * else derived from `config.libraries` (names or `defineLibrary` descriptors).
 * @param {import('../index.js').EngineConfig} [config] @returns {string[]}
 */
function libraryNames(config) {
  const reg = /** @type {any} */ (config)?.registry;
  if (reg?.libraryNames) return [...reg.libraryNames];
  return (config?.libraries ?? [])
    .map((l) => (typeof l === 'string' ? l : /** @type {any} */ (l)?.name))
    .filter(Boolean);
}

/**
 * Custom macro → family map for the parser — from the built registry when present, else
 * derived from `config.macros` (`defineMacro` descriptors).
 * @param {import('../index.js').EngineConfig} [config] @returns {Record<string, 'aggregator'|'layout'>}
 */
function macroFamilies(config) {
  const reg = /** @type {any} */ (config)?.registry;
  if (reg?.macroFamilies) return reg.macroFamilies;
  /** @type {Record<string, 'aggregator'|'layout'>} */
  const out = {};
  for (const m of config?.macros ?? []) {
    if (m && typeof m.name === 'string') {
      out[m.name] = m.family ?? (m.phase === 'expand' ? 'aggregator' : 'layout');
    }
  }
  return out;
}
