/**
 * @file `analyze` as a compiler (SPEC §2.3, IMPL §9): requirement graph, execution
 * plan, capabilities, metrics and `streamability`. Static and pure. v1 placeholder.
 */

import { ANALYSIS_VERSION } from '../util/versions.js';
import { NotImplementedError } from '../util/errors.js';

export { ANALYSIS_VERSION };

/**
 * Streaming suitability classes (SPEC §2.3, normative criterion IMPL §9).
 * @type {Readonly<Record<string, string>>}
 */
export const Streamability = Object.freeze({
  FULL: 'full',
  PARTIAL: 'partial',
  BUFFERED: 'buffered',
});

/**
 * Output of `analyze` (SPEC §2.3).
 * @typedef {Object} Analysis
 * @property {number} analysisVersion
 * @property {import('../ast/index.js').Document} ast
 * @property {import('../eval/index.js').RequirementDescriptor[]} requirements
 * @property {{ edges: Array<[string, string]> }} requirementGraph
 * @property {Array<{ phase: number, requirements: string[] }>} executionPlan
 * @property {string[]} capabilitiesUsed
 * @property {Record<string, import('../runtime/index.js').Value>} staticValues
 * @property {boolean} deterministic
 * @property {'full'|'partial'|'buffered'} streamability
 * @property {Array<{ nodes: string[] }>} potentialCycles
 * @property {number} maxPhases
 * @property {number} worstCaseRequirements
 */

/**
 * Describes what is needed to complete the document without executing it. v1 placeholder.
 *
 * @param {string} _template
 * @param {import('../index.js').EngineConfig} [_config]
 * @returns {Analysis}
 */
export function analyze(_template, _config) {
  throw new NotImplementedError('analyze.analyze');
}
