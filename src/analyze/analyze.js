/**
 * @file Public contract for `analyze` (SPEC §2.3, IMPL §9): analyze acts as a compiler.
 * Static and pure: no real data, no capability queried. Source of truth for the
 * `Analysis` shape and its sub-structures.
 */

import { ANALYSIS_VERSION } from '../util/versions.js';
import { NotImplementedError } from '../util/errors.js';

export { ANALYSIS_VERSION };

/**
 * Streaming suitability classes (SPEC §2.3; normative "safe points" criterion IMPL §9).
 * @type {Readonly<Record<string, string>>}
 */
export const Streamability = Object.freeze({
  FULL: 'full',
  PARTIAL: 'partial',
  BUFFERED: 'buffered',
});

/**
 * Requirement dependency graph (SPEC §2.3, IMPL §9). An edge `A → B` means B is active
 * only in a branch whose condition depends on A.
 * @typedef {Object} RequirementGraph
 * @property {Array<[string, string]>} edges
 */

/**
 * One execution phase (SPEC §2.3): which requirements become active in that phase.
 * @typedef {Object} Phase
 * @property {number} phase
 * @property {string[]} requirements
 */

/**
 * A statically detected cycle (inclusion or requirement graph), IMPL §9.
 * @typedef {Object} Cycle
 * @property {string[]} nodes
 */

/**
 * Output of `analyze` (SPEC §2.3). Carries `analysisVersion` (SPEC §2.1).
 *
 * @typedef {Object} Analysis
 * @property {number} analysisVersion
 * @property {import('../ast/nodes.js').Document} ast
 * @property {import('../eval/evaluator.js').RequirementDescriptor[]} requirements
 * @property {RequirementGraph} requirementGraph
 * @property {Phase[]} executionPlan
 * @property {string[]} capabilitiesUsed
 * @property {Record<string, import('../runtime/values.js').Value>} staticValues
 * @property {boolean} deterministic
 * @property {'full'|'partial'|'buffered'} streamability
 * @property {Cycle[]} potentialCycles
 * @property {number} maxPhases
 * @property {number} worstCaseRequirements
 */

/**
 * Describes what is needed to complete the document, without executing it. v1 placeholder.
 *
 * @param {string} _template
 * @param {import('../index.js').EngineConfig} [_config]
 * @returns {Analysis}
 */
export function analyze(_template, _config) {
  throw new NotImplementedError('analyze.analyze');
}
