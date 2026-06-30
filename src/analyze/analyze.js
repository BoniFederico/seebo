/**
 * @file Public contract for `analyze` (SPEC §2.3, IMPL §9): analyze acts as a compiler.
 * Static and pure: no real data, no capability queried. Source of truth for the
 * `Analysis` shape and its sub-structures.
 */

import { ANALYSIS_VERSION } from '../util/versions.js';
import { parse } from '../parser/index.js';
import {
  collectDeclarations,
  extractRequirement,
  extractActionStatic,
  applyCapabilityContract,
} from '../eval/symbols.js';
import { evaluate } from '../eval/evaluator.js';

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
 * @property {ActionSummary[]} actions  Statically-detected action declarations, in document order (SPEC §2.8).
 */

/**
 * Best-effort static summary of one `action({...})` declaration (SPEC §2.8). Fields that are
 * not syntactically constant are reported as `undefined` with `dynamicInput`/`dynamic` set, so
 * a host can tell what is statically known from what is only resolvable at run time.
 * @typedef {Object} ActionSummary
 * @property {string | undefined} id  Action id when a string literal; `undefined` if dynamic.
 * @property {string | undefined} type  Action type when a string literal; `undefined` if dynamic.
 * @property {string | undefined} environment  Environment when a string literal; `undefined` otherwise.
 * @property {boolean} requiresConfirmation  `true` when `confirm: true` is declared literally.
 * @property {string[]} permissions  Literal permissions declared on the descriptor.
 * @property {boolean} dynamicInput  `true` when the `input` depends on requirements/expressions.
 * @property {boolean} duplicateId  `true` when this id repeats an earlier action id.
 */

/** Backward-acting layout macros (rewrite already-emitted text) → force buffering. */
const BACKWARD_MACROS = new Set(['COLLAPSE', 'REMOVE_LINE', 'REMOVE_LEFT']);
/** Aggregator macros (pre-pass inclusion) → may reorder ⇒ buffering. */
const AGGREGATOR_MACROS = new Set(['ABSORB', 'MERGE']);

/**
 * In-memory analysis cache (IMPL §11). Opt-in via `optimizations.astCache`, keyed by config
 * identity then template. `Analysis` is a pure function of `(config, template)`.
 * @type {WeakMap<object, Map<string, Analysis>>}
 */
const ANALYSIS_CACHE = new WeakMap();

/** Upper bound on cached analyses per engine; cleared wholesale when exceeded. */
const MAX_CACHE_ENTRIES = 512;

/**
 * Statically describes what is needed to complete the document, without executing it
 * (SPEC §2.3, IMPL §9). Pure: no data is fetched and no capability is queried. With
 * `optimizations.astCache` the result is memoized per `(config, template)` (IMPL §11).
 *
 * @param {string} template  Raw template source.
 * @param {import('../index.js').EngineConfig} [config]
 * @returns {Analysis}
 * @throws {import('../util/errors.js').SeeboError}  On unrecoverable syntax errors (via `parse`).
 */
export function analyze(template, config) {
  const bucket = cacheBucket(config);
  if (bucket) {
    const hit = bucket.get(template);
    if (hit) return hit;
    const a = analyzeUncached(template, config);
    if (bucket.size >= MAX_CACHE_ENTRIES) bucket.clear();
    bucket.set(template, a);
    return a;
  }
  return analyzeUncached(template, config);
}

/** Returns the per-config analysis cache bucket when `astCache` is enabled. @param {import('../index.js').EngineConfig} [config] */
function cacheBucket(config) {
  if (!config || !config.optimizations?.astCache) return undefined;
  let bucket = ANALYSIS_CACHE.get(config);
  if (!bucket) {
    bucket = new Map();
    ANALYSIS_CACHE.set(config, bucket);
  }
  return bucket;
}

/**
 * The actual analysis work (uncached).
 * @param {string} template
 * @param {import('../index.js').EngineConfig} [config]
 * @returns {Analysis}
 */
function analyzeUncached(template, config) {
  const cfg = config ?? {};
  const ast = parse(template, cfg);
  const symbols = collectDeclarations(ast);

  /** Requirement ids declared in the document (excludes pure `var`s). @type {Set<string>} */
  const reqIds = new Set();
  for (const [id, decl] of symbols) if (decl.kind === 'require') reqIds.add(id);

  // Requirement graph: edge A → B iff B is declared inside a branch whose governing
  // condition references A (IMPL §9). Built by walking with the set of ids referenced by
  // the conditions that gate the current position.
  /** @type {Map<string, string[]>} */
  const governing = new Map();
  for (const node of ast.nodes) {
    if (node.kind === 'Formula') walkGraph(/** @type {any} */ (node).expr, [], governing);
    else if (node.kind === 'Macro')
      for (const a of /** @type {any} */ (node).args) walkGraph(a, [], governing);
  }

  /** @type {Array<[string, string]>} */
  const edges = [];
  for (const [id, gids] of governing) {
    for (const g of gids) edges.push([g, id]);
  }

  // Phases (longest path) + cycle detection over the requirement graph.
  /** @type {Map<string, number>} */
  const phaseMemo = new Map();
  /** @type {Cycle[]} */
  const potentialCycles = [];
  /** @param {string} id @param {Set<string>} stack @returns {number} */
  const phaseOf = (id, stack) => {
    const cached = phaseMemo.get(id);
    if (cached !== undefined) return cached;
    const gids = governing.get(id) ?? [];
    if (gids.length === 0) {
      phaseMemo.set(id, 1);
      return 1;
    }
    if (stack.has(id)) {
      potentialCycles.push({ nodes: [...stack, id] });
      return 1; // break the cycle
    }
    stack.add(id);
    let max = 0;
    for (const g of gids) {
      const gp = reqIds.has(g) ? phaseOf(g, stack) : 1; // free vars are phase-1 roots
      if (gp > max) max = gp;
    }
    stack.delete(id);
    const p = 1 + max;
    phaseMemo.set(id, p);
    return p;
  };

  // Requirements, enriched with derived `phase`/`options` (IMPL §9), in declaration order.
  /** @type {import('../eval/evaluator.js').RequirementDescriptor[]} */
  const requirements = [];
  /** @type {string[]} */
  const capabilitiesUsed = [];
  for (const [id, decl] of symbols) {
    if (decl.kind !== 'require') continue;
    // Merge the capability contract so the reported requirement carries the inherited type/label
    // (SPEC §1.6); the template still wins on any field it declares.
    const d = applyCapabilityContract(
      decl.descriptor,
      /** @type {any} */ (cfg).capabilityContracts
    );
    const options = optionsOf(d);
    /** @type {import('../eval/evaluator.js').RequirementDescriptor} */
    const enriched = { ...d, phase: phaseOf(id, new Set()) };
    if (options !== undefined) enriched.options = options;
    requirements.push(enriched);
    if (d.capability && !capabilitiesUsed.includes(d.capability))
      capabilitiesUsed.push(d.capability);
  }

  // Execution plan: requirements grouped by phase, ordered by phase then declaration.
  /** @type {Map<number, string[]>} */
  const byPhase = new Map();
  for (const r of requirements) {
    const list = byPhase.get(/** @type {number} */ (r.phase)) ?? [];
    list.push(r.id);
    byPhase.set(/** @type {number} */ (r.phase), list);
  }
  const executionPlan = [...byPhase.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([phase, reqs]) => ({ phase, requirements: reqs }));

  // Actions (SPEC §2.8): statically-detected `action({...})` declarations in document order,
  // with best-effort metadata and duplicate-id flagging.
  const actions = collectActionSummaries(ast);

  // Static metrics.
  const deterministic = isDeterministic(ast);
  const staticValues = computeStaticValues(ast, symbols, cfg);
  const maxReqPhase = requirements.reduce(
    (m, r) => Math.max(m, /** @type {number} */ (r.phase)),
    0
  );
  const phaseCap = cfg.limits?.maxPhases ?? Number.POSITIVE_INFINITY;
  const maxPhases = Math.min(maxReqPhase, phaseCap);
  const worstCaseRequirements = requirements.reduce(
    (m, r) => Math.max(m, pathReqCount(r.id, governing, reqIds, new Set())),
    0
  );

  return {
    analysisVersion: ANALYSIS_VERSION,
    ast,
    requirements,
    requirementGraph: { edges },
    executionPlan,
    capabilitiesUsed,
    staticValues,
    deterministic,
    streamability: streamabilityOf(ast),
    potentialCycles,
    maxPhases,
    worstCaseRequirements,
    actions,
  };
}

/**
 * Walks the document collecting `action({...})` declarations in document order, with best-effort
 * static metadata and duplicate-id detection (SPEC §2.8).
 * @param {import('../ast/nodes.js').Document} ast
 * @returns {ActionSummary[]}
 */
function collectActionSummaries(ast) {
  /** @type {ActionSummary[]} */
  const out = [];
  const seen = new Set();
  /** @param {any} e */
  const visit = (e) => {
    if (!e || typeof e !== 'object') return;
    if (e.kind === 'Call' && e.callee === 'action') {
      try {
        const s = extractActionStatic(e);
        const duplicateId = s.id !== undefined && seen.has(s.id);
        if (s.id !== undefined) seen.add(s.id);
        out.push({
          id: s.id,
          type: s.type,
          environment: s.environment,
          requiresConfirmation: s.confirm,
          permissions: s.permissions,
          dynamicInput: s.dynamicInput,
          duplicateId,
        });
      } catch {
        /* malformed action descriptor — surfaced by validate */
      }
    }
    for (const child of children(e)) visit(child);
  };
  for (const node of ast.nodes) {
    if (node.kind === 'Formula') visit(/** @type {any} */ (node).expr);
    else if (node.kind === 'Macro') for (const a of /** @type {any} */ (node).args) visit(a);
  }
  return out;
}

/**
 * Records the governing requirement ids for every `require` declared under conditional
 * branches (the requirement-graph back-edges, IMPL §9).
 * @param {import('../ast/nodes.js').Expr} expr @param {string[]} gov @param {Map<string, string[]>} governing
 */
function walkGraph(expr, gov, governing) {
  if (!expr || typeof expr !== 'object') return;
  const e = /** @type {any} */ (expr);
  if (e.kind === 'Ternary') {
    const condIds = collectRefIds(e.cond);
    walkGraph(e.cond, gov, governing);
    const inner = union(gov, condIds);
    walkGraph(e.then, inner, governing);
    walkGraph(e.else, inner, governing);
    return;
  }
  if (e.kind === 'Call' && e.callee === 'need') {
    let id;
    try {
      id = extractRequirement(e).id;
    } catch {
      id = undefined;
    }
    if (id) governing.set(id, union(governing.get(id) ?? [], gov));
  }
  for (const child of children(e)) walkGraph(child, gov, governing);
}

/**
 * Longest chain of *requirement* dependencies ending at `id` (worst-case path cost, IMPL §9).
 * @param {string} id @param {Map<string, string[]>} governing @param {Set<string>} reqIds @param {Set<string>} stack
 * @returns {number}
 */
function pathReqCount(id, governing, reqIds, stack) {
  if (stack.has(id)) return 1; // cycle guard
  stack.add(id);
  const gids = governing.get(id) ?? [];
  let max = 0;
  for (const g of gids) {
    if (!reqIds.has(g)) continue;
    const c = pathReqCount(g, governing, reqIds, stack);
    if (c > max) max = c;
  }
  stack.delete(id);
  return 1 + max;
}

/** Distinct option values from a requirement's `type.constraints.values` (IMPL §9). @param {any} d @returns {unknown[] | undefined} */
function optionsOf(d) {
  const values = d?.type?.constraints?.values;
  return Array.isArray(values) ? values : undefined;
}

/** Collects identifier ids referenced by an expression: `Ref` names and inner `require` ids. @param {import('../ast/nodes.js').Expr} expr @returns {string[]} */
function collectRefIds(expr) {
  /** @type {string[]} */
  const out = [];
  /** @param {any} e */
  const visit = (e) => {
    if (!e || typeof e !== 'object') return;
    if (e.kind === 'Ref') out.push(e.name);
    else if (e.kind === 'Call' && e.callee === 'need') {
      try {
        out.push(extractRequirement(e).id);
      } catch {
        /* ignore malformed descriptor */
      }
    }
    for (const child of children(e)) visit(child);
  };
  visit(expr);
  return out;
}

/** @param {string[]} a @param {string[]} b @returns {string[]} */
function union(a, b) {
  const out = [...a];
  for (const x of b) if (!out.includes(x)) out.push(x);
  return out;
}

/**
 * `true` iff the document uses no non-deterministic producer (`now()` or `fake.*`).
 * v1 is conservative: since the normalized config always carries a clock, a fixed-clock
 * exception is not distinguishable, so any `now`/`fake` use marks the document as
 * non-deterministic (IMPL §9).
 * @param {import('../ast/nodes.js').Document} ast @returns {boolean}
 */
function isDeterministic(ast) {
  let deterministic = true;
  /** @param {any} e */
  const visit = (e) => {
    if (!e || typeof e !== 'object') return;
    if (isNondeterministicNode(e)) deterministic = false;
    for (const child of children(e)) visit(child);
  };
  for (const node of ast.nodes) {
    if (node.kind === 'Formula') visit(/** @type {any} */ (node).expr);
    else if (node.kind === 'Macro') for (const a of /** @type {any} */ (node).args) visit(a);
  }
  return deterministic;
}

/**
 * Evaluates the cold-resolvable formulas (pure, deterministic, no requirements) and
 * collects their values keyed by slot index (IMPL §9). Pure: empty `resolved` environment.
 * @param {import('../ast/nodes.js').Document} ast
 * @param {ReturnType<typeof collectDeclarations>} symbols
 * @param {import('../index.js').EngineConfig} cfg
 * @returns {Record<string, import('../runtime/values.js').Value>}
 */
function computeStaticValues(ast, symbols, cfg) {
  /** @type {Record<string, import('../runtime/values.js').Value>} */
  const out = {};
  let i = -1;
  for (const node of ast.nodes) {
    if (node.kind !== 'Formula') continue;
    i += 1;
    const expr = /** @type {any} */ (node).expr;
    if (usesNondeterministic(expr)) continue;
    /** @type {import('../eval/evaluator.js').EvalContext} */
    const ctx = {
      resolved: {},
      symbols,
      needs: new Map(),
      config: cfg,
      clock: cfg.clock ?? (() => new Date()),
    };
    const res = evaluate(expr, ctx);
    if (res.kind === 'Ok' && ctx.needs.size === 0) out[String(i)] = res.value;
  }
  return out;
}

/** @param {import('../ast/nodes.js').Expr} expr @returns {boolean} */
function usesNondeterministic(expr) {
  let found = false;
  /** @param {any} e */
  const visit = (e) => {
    if (!e || typeof e !== 'object' || found) return;
    if (isNondeterministicNode(e)) found = true;
    for (const child of children(e)) visit(child);
  };
  visit(expr);
  return found;
}

/** A node that introduces non-determinism: `now()` or a `fake.*` library call. @param {any} e @returns {boolean} */
function isNondeterministicNode(e) {
  if (e.kind === 'Call' && e.callee === 'now') return true;
  if (e.kind === 'Namespace' && e.ns === 'fake') return true;
  return false;
}

/**
 * Static streaming classification (IMPL §9). `full` when nothing rewrites emitted text;
 * `buffered` when an aggregator or a backward-acting layout macro is present; `partial`
 * when only forward-safe layout macros (`REMOVE_RIGHT`) appear.
 * @param {import('../ast/nodes.js').Document} ast @returns {string}
 */
function streamabilityOf(ast) {
  let backward = false;
  let forward = false;
  for (const node of ast.nodes) {
    if (node.kind !== 'Macro') continue;
    const name = /** @type {any} */ (node).name;
    if (AGGREGATOR_MACROS.has(name) || BACKWARD_MACROS.has(name)) backward = true;
    else if (name === 'REMOVE_RIGHT') forward = true;
  }
  if (backward) return Streamability.BUFFERED;
  if (forward) return Streamability.PARTIAL;
  return Streamability.FULL;
}

/** Child expressions of a node (mirror of the runtime walker). @param {any} e @returns {import('../ast/nodes.js').Expr[]} */
function children(e) {
  switch (e.kind) {
    case 'Unary':
      return [e.arg];
    case 'Binary':
      return [e.left, e.right];
    case 'Ternary':
      return [e.cond, e.then, e.else];
    case 'Call':
      return e.args;
    case 'Method':
      return [e.receiver, ...e.args];
    case 'Namespace':
      return e.args;
    case 'Member':
      return [e.receiver];
    case 'ArrayLit':
      return e.elements;
    case 'ObjectLit':
      return e.entries.map((/** @type {any} */ en) => en.value);
    default:
      return [];
  }
}
