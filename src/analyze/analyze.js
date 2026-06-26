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
 * Requirement dependency graph (SPEC §2.3, IMPL §9). An edge `A → B` means requirement
 * B is active only in a branch whose condition depends on A.
 * @typedef {Object} RequirementGraph
 * @property {Array<[string, string]>} edges  Directed edges as `[from, to]` pairs of requirement ids.
 */

/**
 * One execution phase in the static plan (SPEC §2.3): which requirements become active
 * in that phase. Named `ExecutionPhase` to avoid collision with {@link import('../util/errors.js').Phase}.
 * @typedef {Object} ExecutionPhase
 * @property {number} phase  Phase index (1-based, matching {@link import('../run/run.js').PublicState} `.phase`).
 * @property {string[]} requirements  Requirement ids that become active in this phase.
 */

/**
 * A statically detected cycle (inclusion or requirement graph), IMPL §9.
 * @typedef {Object} Cycle
 * @property {string[]} nodes  Ordered list of node ids forming the cycle.
 */

/**
 * Output of `analyze` (SPEC §2.3). Carries `analysisVersion` (SPEC §2.1). Produced once
 * per template; consumed by `run` and the driver to drive scheduling and streaming.
 *
 * @typedef {Object} Analysis
 * @property {number} analysisVersion  Schema version; see {@link ANALYSIS_VERSION}.
 * @property {import('../ast/nodes.js').Document} ast  Parsed AST for the analyzed template.
 * @property {import('../eval/evaluator.js').RequirementDescriptor[]} requirements  All requirements declared in the template.
 * @property {RequirementGraph} requirementGraph  Dependency graph between requirements.
 * @property {ExecutionPhase[]} executionPlan  Ordered list of execution phases with their active requirements.
 * @property {string[]} capabilitiesUsed  Names of capabilities referenced by the template.
 * @property {Record<string, import('../runtime/values.js').Value>} staticValues  Values that can be computed statically (no capability needed).
 * @property {boolean} deterministic  `true` when the template produces the same output for the same inputs.
 * @property {string} streamability  One of {@link Streamability}: streaming suitability of the template.
 * @property {Cycle[]} potentialCycles  Cycles detected in the requirement or inclusion graph.
 * @property {number} maxPhases  Upper bound on the number of `run` steps required.
 * @property {number} worstCaseRequirements  Upper bound on the number of requirements across all phases.
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
