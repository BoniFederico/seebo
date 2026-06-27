/**
 * @file Public contracts for the `action` construct (SPEC §2.8, additive). Single source of
 * truth for the action-related typedefs and the stable status/error/event enums.
 *
 * Two strictly separated worlds share these contracts:
 *  - the **pure core** (evaluator / run / analyze / validate) which only *prepares*
 *    {@link ActionDescriptor}s into an {@link ActionPlan} — it never executes them;
 *  - the **execution layer** exposed from `seebo/actions` ({@link ../actions/execute.js})
 *    which performs the prepared effects on explicit host request.
 *
 * Importing this file pulls in NO I/O and NO executor code, so the core can depend on it
 * freely without breaking the purity rule (the core must never reach the execution helpers).
 */

/**
 * Action lifecycle states (SPEC §2.8). The pure core only ever emits the first three
 * (`blocked`/`ready`/`pendingConfirmation`); the remaining states are produced exclusively
 * by the execution layer. Stable string values: part of the public contract.
 * @type {Readonly<Record<string, string>>}
 */
export const ActionStatus = Object.freeze({
  /** Inputs are missing or invalid; the action is not yet preparable (core). */
  BLOCKED: 'blocked',
  /** All inputs resolved and policy allows direct execution without confirmation (core). */
  READY: 'ready',
  /** Ready, but requires explicit confirmation before it may run (core). */
  PENDING_CONFIRMATION: 'pendingConfirmation',
  /** A handler is currently running for this action (executor). */
  EXECUTING: 'executing',
  /** The handler completed successfully (executor). */
  SUCCEEDED: 'succeeded',
  /** The handler failed, possibly after exhausting retries (executor). */
  FAILED: 'failed',
  /** The action was intentionally not executed (unconfirmed / policy-denied) (executor). */
  SKIPPED: 'skipped',
  /** A previously succeeded action was rolled back via its `compensate` handler (executor). */
  COMPENSATED: 'compensated',
  /** Compensation was attempted but the `compensate` handler failed (executor). */
  COMPENSATION_FAILED: 'compensationFailed',
});

/**
 * Stable, structured action error codes (SPEC §2.8). Returned inside receipts/results rather
 * than thrown, mirroring the engine's diagnostic discipline. Never renamed.
 * @type {Readonly<Record<string, string>>}
 */
export const ActionErrorCode = Object.freeze({
  INVALID_ACTION_DESCRIPTOR: 'INVALID_ACTION_DESCRIPTOR',
  DUPLICATE_ACTION_ID: 'DUPLICATE_ACTION_ID',
  HANDLER_NOT_FOUND: 'HANDLER_NOT_FOUND',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  POLICY_DENIED: 'POLICY_DENIED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  ENVIRONMENT_DENIED: 'ENVIRONMENT_DENIED',
  CONFIRMATION_REQUIRED: 'CONFIRMATION_REQUIRED',
  DRY_RUN_UNSUPPORTED: 'DRY_RUN_UNSUPPORTED',
  ACTION_BLOCKED: 'ACTION_BLOCKED',
  EXECUTION_FAILED: 'EXECUTION_FAILED',
  TIMEOUT: 'TIMEOUT',
  RETRY_EXHAUSTED: 'RETRY_EXHAUSTED',
  COMPENSATION_UNSUPPORTED: 'COMPENSATION_UNSUPPORTED',
  COMPENSATION_FAILED: 'COMPENSATION_FAILED',
});

/**
 * Stable audit event types emitted by the execution layer (SPEC §2.8). Delivered to the
 * `audit` hook; the core never writes to the console. Never renamed.
 * @type {Readonly<Record<string, string>>}
 */
export const ActionEventType = Object.freeze({
  DECLARED: 'action.declared',
  BLOCKED: 'action.blocked',
  READY: 'action.ready',
  CONFIRMATION_REQUIRED: 'action.confirmation_required',
  DRY_RUN_STARTED: 'action.dry_run_started',
  DRY_RUN_SUCCEEDED: 'action.dry_run_succeeded',
  DRY_RUN_FAILED: 'action.dry_run_failed',
  EXECUTION_STARTED: 'action.execution_started',
  EXECUTION_SUCCEEDED: 'action.execution_succeeded',
  EXECUTION_FAILED: 'action.execution_failed',
  RETRY_SCHEDULED: 'action.retry_scheduled',
  COMPENSATION_STARTED: 'action.compensation_started',
  COMPENSATION_SUCCEEDED: 'action.compensation_succeeded',
  COMPENSATION_FAILED: 'action.compensation_failed',
  POLICY_DENIED: 'action.policy_denied',
});

/**
 * Plan-level execution outcome of {@link executeActionPlan}/{@link dryRunActionPlan}.
 * @type {Readonly<Record<string, string>>}
 */
export const PlanStatus = Object.freeze({
  /** Every eligible action succeeded (or was a no-op dry-run). */
  COMPLETED: 'completed',
  /** Some actions succeeded and some failed/were skipped. */
  PARTIAL: 'partial',
  /** No action succeeded. */
  FAILED: 'failed',
  /** Nothing ran (empty plan or all actions skipped). */
  SKIPPED: 'skipped',
});

/* ----------------------------------------------------------------------------------- *
 * Descriptor / plan (produced by the pure core)
 * ----------------------------------------------------------------------------------- */

/**
 * Retry configuration for the execution layer (SPEC §2.8). Default: no automatic retry.
 * @typedef {Object} ActionRetry
 * @property {number} attempts  Number of *additional* attempts after the first (0 = no retry).
 * @property {number} backoffMs  Base delay between attempts, in milliseconds.
 * @property {'fixed'|'exponential'} [strategy]  Backoff growth strategy. Default: `'fixed'`.
 */

/**
 * One prepared action, produced by the pure core (`${ action({...}) }`) and consumed by the
 * execution layer (SPEC §2.8). Carries everything needed to execute *or* to explain why it
 * cannot be executed yet — but never any effect.
 * @typedef {Object} ActionDescriptor
 * @property {string} id  Unique action id within a run/plan.
 * @property {string} type  Handler type name (e.g. `'jira.createIssue'`).
 * @property {Record<string, unknown>} input  Resolved, sanitized JSON input; partial when blocked.
 * @property {string} status  One of {@link ActionStatus}; the core emits `blocked`/`ready`/`pendingConfirmation`.
 * @property {string} environment  Target environment (e.g. `'test'`, `'prod'`).
 * @property {boolean} requiresConfirmation  `true` when the action declares `confirm: true`.
 * @property {boolean} dryRun  Whether the descriptor was declared with `dryRun: true` (hint to the executor).
 * @property {string} idempotencyKey  Stable key for de-duplication/retries (see {@link computeIdempotencyKey}).
 * @property {string[]} permissions  Permissions required by the descriptor (merged with handler `requiredPermissions` at execution).
 * @property {ActionRetry} [retry]  Per-action retry policy; defaults applied by the executor.
 * @property {Record<string, unknown>} [metadata]  Free-form, host-defined audit metadata.
 * @property {boolean} [compensable]  Hint that the action declares/expects a compensation handler.
 * @property {import('../util/errors.js').Diagnostic[]} [diagnostics]  Reasons the action is not ready (when `status === 'blocked'`).
 */

/**
 * The full ordered set of prepared actions for one run (SPEC §2.8). Ordering follows document
 * order; ids are unique. Surfaced as `PublicState.actions` and `Analysis.actions`.
 * @typedef {ActionDescriptor[]} ActionPlan
 */

/* ----------------------------------------------------------------------------------- *
 * Execution layer (produced by seebo/actions)
 * ----------------------------------------------------------------------------------- */

/**
 * Structured action error embedded in a receipt/result (SPEC §2.8). Never thrown by the
 * public execution API.
 * @typedef {Object} ActionError
 * @property {string} code  One of {@link ActionErrorCode}.
 * @property {string} message  Human-readable, already redacted per policy.
 * @property {boolean} [retryable]  Whether the executor may retry this error.
 * @property {Record<string, unknown>} [data]  Code-specific structured payload.
 */

/**
 * Receipt of a single dry-run or real execution (SPEC §2.8). Always returned — success or
 * failure — so the host can record an audit trail.
 * @typedef {Object} ActionReceipt
 * @property {string} actionId  The action id this receipt is for.
 * @property {string} type  The action type.
 * @property {string} status  Terminal status from {@link ActionStatus}.
 * @property {string} environment  Environment the action targeted.
 * @property {boolean} dryRun  `true` when produced by a dry-run (no real effect).
 * @property {string} idempotencyKey  The idempotency key passed to the handler.
 * @property {number} startedAt  Epoch ms when execution started.
 * @property {number} finishedAt  Epoch ms when execution finished.
 * @property {number} durationMs  `finishedAt - startedAt`.
 * @property {number} attempts  Number of handler invocations performed (≥ 1 when a handler ran).
 * @property {string} [externalId]  External system id returned by the handler, if any.
 * @property {unknown} [output]  Handler result/preview, redacted per policy where applicable.
 * @property {string} [actor]  Actor on whose behalf the action ran, if provided.
 * @property {ActionError} [error]  Present when `status` is `failed`/`compensationFailed`.
 * @property {Record<string, unknown>} [metadata]  Echoed descriptor metadata.
 */

/**
 * Plan-level result of {@link executeActionPlan}/{@link dryRunActionPlan} (SPEC §2.8).
 * @typedef {Object} ActionExecutionResult
 * @property {string} status  One of {@link PlanStatus}.
 * @property {boolean} dryRun  Whether this was a dry-run of the whole plan.
 * @property {ActionReceipt[]} receipts  One receipt per attempted/skipped action, in plan order.
 * @property {number} succeeded  Count of receipts with `status === 'succeeded'`.
 * @property {number} failed  Count of receipts with a failed terminal status.
 * @property {number} skipped  Count of receipts with `status === 'skipped'`.
 */

/**
 * Host-supplied execution context for the execution layer (SPEC §2.8). The host owns all
 * effectful capabilities (clients) and policy hooks; the engine never invents them.
 * @typedef {Object} ActionExecutionContext
 * @property {import('../index.js').Engine} [engine]  Engine whose action registry/policy to use.
 * @property {import('../runtime/registry.js').Registry} [registry]  Registry override (when no `engine`).
 * @property {boolean} [dryRun]  Force dry-run for the whole call. Default: `false`.
 * @property {string} [actor]  Identifier of the acting user/service.
 * @property {string[]} [permissions]  Permissions granted to `actor`.
 * @property {string} [environment]  Default environment when a descriptor does not pin one.
 * @property {string[]} [confirmedActions]  Ids of actions the host explicitly confirms.
 * @property {boolean} [failFast]  Stop the plan after the first failure. Default: `false`.
 * @property {string} [correlationId]  Correlation/run id threaded into audit events.
 * @property {Record<string, unknown>} [clients]  Effectful clients made available to handlers.
 * @property {import('../index.js').ActionPolicy} [policy]  Policy override (else engine policy).
 * @property {(event: import('./contracts.js').ActionAuditEvent) => void} [audit]  Audit sink. Default: noop.
 * @property {(value: unknown, context: { actionId: string, type: string, field: string }) => unknown} [redact]  Redaction hook for inputs/outputs. Default: identity.
 * @property {() => Date} [clock]  Clock override for deterministic receipts.
 * @property {(ms: number) => Promise<void>} [sleep]  Backoff sleeper override (testing).
 */

/**
 * Audit event delivered to the `audit` hook (SPEC §2.8). Effect-free data only.
 * @typedef {Object} ActionAuditEvent
 * @property {string} type  One of {@link ActionEventType}.
 * @property {string} actionId  The action id.
 * @property {string} actionType  The action type.
 * @property {string} environment  Target environment.
 * @property {string} [actor]  Acting user/service, if known.
 * @property {number} timestamp  Epoch ms when the event was emitted.
 * @property {string} [correlationId]  Correlation/run id, if provided.
 * @property {string} [idempotencyKey]  Idempotency key of the action.
 * @property {unknown} [input]  Sanitized/redacted input, when policy permits.
 * @property {unknown} [result]  Safe result/receipt summary, when policy permits.
 * @property {ActionError} [error]  Structured error, for failure events.
 */

/**
 * Concrete handler registered by the host via `defineAction`/`engine.defineAction`
 * (SPEC §2.8). The engine never authors these; it only looks them up at execution time.
 * @typedef {Object} ActionHandler
 * @property {string[]} [requiredPermissions]  Permissions every actor must hold to run this type.
 * @property {string[]} [allowedEnvironments]  Environments in which this type may run.
 * @property {(input: Record<string, unknown>, context: ActionHandlerContext) => unknown | Promise<unknown>} execute  Performs the real effect; returns a JSON-safe receipt payload.
 * @property {(input: Record<string, unknown>, context: ActionHandlerContext) => unknown | Promise<unknown>} [dryRun]  Simulates the effect without performing it.
 * @property {(receipt: ActionReceipt, context: ActionHandlerContext) => unknown | Promise<unknown>} [compensate]  Rolls back a previously succeeded action.
 * @property {(input: Record<string, unknown>, context: ActionHandlerContext) => (true | string)} [validate]  Optional pre-flight input check; return `true` or an error message.
 * @property {Record<string, unknown>} [metadata]  Static handler metadata/schema.
 */

/**
 * Context passed to a handler's `execute`/`dryRun`/`compensate` (SPEC §2.8).
 * @typedef {Object} ActionHandlerContext
 * @property {string} actionId  The action id.
 * @property {string} type  The action type.
 * @property {string} environment  Target environment.
 * @property {string} idempotencyKey  Stable idempotency key (constant across retries).
 * @property {boolean} dryRun  Whether this invocation is a dry-run.
 * @property {string} [actor]  Acting user/service.
 * @property {number} attempt  1-based attempt counter.
 * @property {string} [correlationId]  Correlation/run id.
 * @property {Record<string, unknown>} clients  Host-supplied effectful clients.
 * @property {Record<string, unknown>} [metadata]  Descriptor metadata.
 */

/**
 * Marks an error returned by a handler as non-retryable so the executor stops early
 * (SPEC §2.8). A handler may `throw nonRetryable(new Error('...'))` or set
 * `err.retryable = false` directly.
 * @param {Error} error  The error to mark.
 * @returns {Error}  The same error, with `retryable = false`.
 */
export function nonRetryable(error) {
  /** @type {any} */ (error).retryable = false;
  return error;
}

/**
 * Returns `true` when `status` is a terminal failure state.
 * @param {string} status  One of {@link ActionStatus}.
 * @returns {boolean}
 */
export function isFailureStatus(status) {
  return status === ActionStatus.FAILED || status === ActionStatus.COMPENSATION_FAILED;
}
