/**
 * @file Parser barrel (IMPL §3). Exposes the SPEC §2.3 public `parse(template, config)`
 * which tokenizes (via the lexer) and delegates to the token-consuming
 * {@link ./parser.js} `parse(tokens, options)`. Re-exports the `PRECEDENCE` table.
 */

import { tokenize } from '../lexer/lexer.js';
import { parse as parseTokens, PRECEDENCE } from './parser.js';

export { PRECEDENCE };

/**
 * Parses a template string into the AST (SPEC §2.3). Throws a `SYNTAX_ERROR` with a
 * position on malformed input. Capability sugar and library namespaces are resolved when
 * the engine config provides the registered names (IMPL §3).
 *
 * @param {string} template
 * @param {import('../index.js').EngineConfig} [config]
 * @returns {import('../ast/nodes.js').Document}
 */
export function parse(template, config) {
  const tokens = tokenize(template, config);
  return parseTokens(tokens, {
    source: template,
    delimiters: config?.delimiters,
    capabilities: config?.capabilities ? Object.keys(config.capabilities) : [],
    libraries: libraryNames(config),
    macros: macroFamilies(config),
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
