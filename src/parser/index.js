/**
 * @file Parser: recursive descent (LL(1)) + Pratt/precedence-climbing for infix
 * operators (IMPL §3). Desugaring of `match` into ternaries and capability→require
 * normalization. v1 placeholder.
 */

import { NotImplementedError } from '../util/errors.js';

/**
 * Infix operator precedence table (IMPL §3, implementation authority; must match
 * SPEC §1.4). `assoc`: associativity; `binding`: binding power.
 * @type {Readonly<Record<string, { level: number, assoc: 'left'|'right', binding: number }>>}
 */
export const PRECEDENCE = Object.freeze({
  '*': { level: 3, assoc: 'left', binding: 560 },
  '/': { level: 3, assoc: 'left', binding: 560 },
  '+': { level: 4, assoc: 'left', binding: 540 },
  '-': { level: 4, assoc: 'left', binding: 540 },
  '<': { level: 5, assoc: 'left', binding: 520 },
  '<=': { level: 5, assoc: 'left', binding: 520 },
  '>': { level: 5, assoc: 'left', binding: 520 },
  '>=': { level: 5, assoc: 'left', binding: 520 },
  '==': { level: 6, assoc: 'left', binding: 500 },
  '!=': { level: 6, assoc: 'left', binding: 500 },
  in: { level: 6, assoc: 'left', binding: 500 },
  and: { level: 7, assoc: 'left', binding: 480 },
  or: { level: 8, assoc: 'left', binding: 460 },
  '??': { level: 9, assoc: 'right', binding: 440 },
  '?:': { level: 10, assoc: 'right', binding: 420 },
});

/**
 * Builds the template AST. **Throws** an error with position if the syntax is
 * malformed (SPEC §2.3).
 *
 * @param {string} _template
 * @param {import('../index.js').EngineConfig} [_config]
 * @returns {import('../ast/index.js').Document}
 */
export function parse(_template, _config) {
  throw new NotImplementedError('parser.parse');
}
