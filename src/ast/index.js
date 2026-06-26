/**
 * @file AST barrel: re-exports the node contract ({@link ./nodes.js}), the AST version, and
 * the node factories used to build documents programmatically.
 */

import { AST_VERSION } from '../util/versions.js';

export { AST_VERSION };
export { NodeKind, ExprKind } from './nodes.js';

/**
 * Creates an empty AST document, already tagged with the current version.
 * @param {import('./nodes.js').Node[]} [nodes=[]]
 * @returns {import('./nodes.js').Document}
 */
export function createDocument(nodes = []) {
  return { astVersion: AST_VERSION, nodes };
}

/**
 * Generic node factory: tags `props` with `kind` to produce a node/expression record matching
 * the {@link ./nodes.js} contract. The parser builds its nodes inline; this is for hosts that
 * assemble an AST programmatically.
 * @param {string} kind  One of {@link NodeKind} / {@link ExprKind}.
 * @param {Record<string, unknown>} [props]  Remaining node fields (e.g. `position`, `value`).
 * @returns {import('./nodes.js').Node | import('./nodes.js').Expr}
 */
export function createNode(kind, props = {}) {
  return /** @type {any} */ ({ kind, ...props });
}
