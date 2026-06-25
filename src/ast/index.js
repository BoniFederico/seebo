/**
 * @file AST definitions (public contract, IMPL §3.1) and node factories.
 * In v1 the typedefs and constants are present; the constructors are placeholders.
 */

import { AST_VERSION } from '../util/versions.js';
import { NotImplementedError } from '../util/errors.js';

export { AST_VERSION };

/**
 * Document-level node kinds (IMPL §3.1).
 * @type {Readonly<Record<string, string>>}
 */
export const NodeKind = Object.freeze({
  TEXT: 'Text',
  FORMULA: 'Formula',
  COMMENT: 'Comment',
  MACRO: 'Macro',
});

/**
 * Expression node kinds (IMPL §3.1).
 * @type {Readonly<Record<string, string>>}
 */
export const ExprKind = Object.freeze({
  LIT: 'Lit',
  REF: 'Ref',
  CALL: 'Call',
  METHOD: 'Method',
  MEMBER: 'Member',
  UNARY: 'Unary',
  BINARY: 'Binary',
  TERNARY: 'Ternary',
  NAMESPACE: 'Namespace',
});

/**
 * @typedef {{ start: number, end: number }} Position
 */

/**
 * Document: AST root (IMPL §3.1).
 * @typedef {Object} Document
 * @property {number} astVersion
 * @property {Node[]} nodes
 */

/**
 * @typedef {Object} Node Document node (Text | Formula | Comment | Macro).
 * @property {string} kind
 * @property {Position} position
 */

/**
 * @typedef {Object} Expr Expression node (see {@link ExprKind}).
 * @property {string} kind
 * @property {Position} position
 */

/**
 * Creates an empty AST document, already tagged with the current version.
 * @param {Node[]} [nodes=[]]
 * @returns {Document}
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
