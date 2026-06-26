/**
 * @file AST barrel: re-exports the node contract ({@link ./nodes.js}) and the AST
 * version, plus node factories (v1 placeholders).
 */

import { AST_VERSION } from '../util/versions.js';
import { NotImplementedError } from '../util/errors.js';

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
 * Generic node factory (v1 placeholder).
 * @param {string} _kind
 * @param {Record<string, unknown>} [_props]
 * @returns {never}
 */
export function createNode(_kind, _props) {
  throw new NotImplementedError('ast.createNode');
}
