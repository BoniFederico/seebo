/**
 * @file Public entry point for the `seebo/actions` subpath (SPEC §2.8). The generic action
 * **execution layer** plus the public action contracts/utilities.
 *
 * This is the ONLY module that performs an action's effect. The pure core never imports it; it
 * is reachable solely through `import { … } from 'seebo/actions'`, keeping preparation
 * (engine core) and execution (here) strictly separated.
 *
 * @example
 * import { createEngine } from 'seebo';
 * import { executeActionPlan } from 'seebo/actions';
 *
 * const engine = createEngine();
 * engine.defineAction('jira.createIssue', { async execute(input, ctx) { ... } });
 * const result = engine.run(engine.start(template));
 * const exec = await executeActionPlan(result.actions, { engine, environment: 'test' });
 */

export {
  executeAction,
  executeActionPlan,
  dryRunAction,
  dryRunActionPlan,
  compensateAction,
  compensateActionPlan,
} from './execute.js';

// Public contracts/utilities (enums, helpers) — useful for hosts inspecting receipts/events.
export {
  ActionStatus,
  ActionErrorCode,
  ActionEventType,
  PlanStatus,
  nonRetryable,
  isFailureStatus,
} from './contracts.js';

// Pure helpers a host may want to mirror the core's behaviour (e.g. precompute an idempotency
// key, or detect duplicate ids before execution). These run no effect.
export { computeIdempotencyKey, normalizeActionInput, findDuplicateActionId } from './plan.js';

// Policy decision helpers (pure) — exposed so a host can pre-flight a plan against its policy.
export { decideAction, checkPermissions, checkHandlerEnvironment } from './policy.js';
