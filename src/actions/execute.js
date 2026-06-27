/**
 * @file Action **execution layer** (SPEC §2.8) — the only place an action's effect is ever
 * performed. Exposed publicly through `seebo/actions`. This module is deliberately the single
 * async, effectful counterpart to the pure core: it looks up handlers, enforces policy, checks
 * permissions and confirmation, dry-runs, retries, emits audit events, calls handlers, returns
 * structured receipts and runs compensation.
 *
 * The pure core (`src/eval`, `src/run`, `src/analyze`, `src/validate`) MUST NOT import this
 * file. The dependency only flows the other way: this module imports the pure contracts/policy
 * to stay consistent with what the core prepared.
 *
 * Errors are never thrown from the public API — failures are returned as structured {@link
 * import('./contracts.js').ActionReceipt}s carrying an {@link import('./contracts.js').ActionError}.
 */

import {
  ActionStatus,
  ActionErrorCode,
  ActionEventType,
  PlanStatus,
  isFailureStatus,
} from './contracts.js';
import { decideAction, checkPermissions, checkHandlerEnvironment } from './policy.js';
import { findDuplicateActionId } from './plan.js';

/**
 * Executes a single prepared action (SPEC §2.8). Resolves to a {@link
 * import('./contracts.js').ActionReceipt} for success, skip or failure — it never throws.
 *
 * @param {import('./contracts.js').ActionDescriptor} action
 * @param {import('./contracts.js').ActionExecutionContext} [context]
 * @returns {Promise<import('./contracts.js').ActionReceipt>}
 */
export async function executeAction(action, context = {}) {
  return runOne(action, context, context.dryRun === true);
}

/**
 * Dry-runs a single prepared action (SPEC §2.8): calls the handler's `dryRun` when present,
 * never the real `execute`. Returns a receipt with `dryRun: true`.
 *
 * @param {import('./contracts.js').ActionDescriptor} action
 * @param {import('./contracts.js').ActionExecutionContext} [context]
 * @returns {Promise<import('./contracts.js').ActionReceipt>}
 */
export async function dryRunAction(action, context = {}) {
  return runOne(action, context, true);
}

/**
 * Executes a whole action plan (SPEC §2.8). Actions run sequentially in plan order; one
 * failure does not stop the rest unless `failFast` is set. Duplicate ids fail closed.
 *
 * @param {import('./contracts.js').ActionPlan} plan
 * @param {import('./contracts.js').ActionExecutionContext} [context]
 * @returns {Promise<import('./contracts.js').ActionExecutionResult>}
 */
export async function executeActionPlan(plan, context = {}) {
  return runPlan(plan, context, context.dryRun === true);
}

/**
 * Dry-runs a whole action plan (SPEC §2.8): no `execute` handler is ever called.
 *
 * @param {import('./contracts.js').ActionPlan} plan
 * @param {import('./contracts.js').ActionExecutionContext} [context]
 * @returns {Promise<import('./contracts.js').ActionExecutionResult>}
 */
export async function dryRunActionPlan(plan, context = {}) {
  return runPlan(plan, context, true);
}

/**
 * Compensates (rolls back) a single previously-succeeded action (SPEC §2.8). Looks up the
 * handler's `compensate`; returns a receipt with status `compensated` or `compensationFailed`.
 * A handler without `compensate` yields a `COMPENSATION_UNSUPPORTED` failure receipt.
 *
 * @param {import('./contracts.js').ActionReceipt} receipt  The receipt of the action to undo.
 * @param {import('./contracts.js').ActionExecutionContext} [context]
 * @returns {Promise<import('./contracts.js').ActionReceipt>}
 */
export async function compensateAction(receipt, context = {}) {
  const env = makeEnv(context);
  const handler = lookupHandler(receipt.type, context);
  const started = env.now();
  // Adapt the receipt to the descriptor shape the shared helpers expect (id/environment/…).
  const subject = receiptToSubject(receipt);

  if (!handler) {
    return failReceipt(subject, ActionStatus.COMPENSATION_FAILED, started, env, {
      code: ActionErrorCode.HANDLER_NOT_FOUND,
      message: `no handler registered for action type '${receipt.type}'`,
    });
  }
  if (typeof handler.compensate !== 'function') {
    return failReceipt(subject, ActionStatus.COMPENSATION_FAILED, started, env, {
      code: ActionErrorCode.COMPENSATION_UNSUPPORTED,
      message: `action type '${receipt.type}' does not support compensation`,
    });
  }

  emit(env, ActionEventType.COMPENSATION_STARTED, subject, context);
  try {
    const handlerCtx = handlerContext(subject, context, { dryRun: false, attempt: 1 });
    const out = await handler.compensate(receipt, handlerCtx);
    const finished = env.now();
    emit(env, ActionEventType.COMPENSATION_SUCCEEDED, subject, context);
    return finalizeReceipt(
      subject,
      ActionStatus.COMPENSATED,
      started,
      finished,
      env,
      context,
      out,
      1,
      false
    );
  } catch (ex) {
    const error = toActionError(ex, ActionErrorCode.COMPENSATION_FAILED);
    const r = failReceipt(subject, ActionStatus.COMPENSATION_FAILED, started, env, error);
    emit(env, ActionEventType.COMPENSATION_FAILED, subject, context, error);
    return r;
  }
}

/** Adapts a prior {@link import('./contracts.js').ActionReceipt} to a descriptor-shaped subject for shared helpers. @param {import('./contracts.js').ActionReceipt} receipt @returns {import('./contracts.js').ActionDescriptor} */
function receiptToSubject(receipt) {
  return {
    id: receipt.actionId,
    type: receipt.type,
    input: {},
    status: ActionStatus.SUCCEEDED,
    environment: receipt.environment,
    requiresConfirmation: false,
    dryRun: false,
    idempotencyKey: receipt.idempotencyKey,
    permissions: [],
    metadata: receipt.metadata,
  };
}

/**
 * Compensates a list of succeeded receipts in **reverse** order (SPEC §2.8) — the natural undo
 * order for a sequence of effects. Stops compensating subsequent receipts only if `failFast`.
 *
 * @param {import('./contracts.js').ActionReceipt[]} receipts
 * @param {import('./contracts.js').ActionExecutionContext} [context]
 * @returns {Promise<import('./contracts.js').ActionExecutionResult>}
 */
export async function compensateActionPlan(receipts, context = {}) {
  const failFast = resolveFailFast(context);
  const ordered = [...receipts].reverse();
  /** @type {import('./contracts.js').ActionReceipt[]} */
  const out = [];
  for (const r of ordered) {
    const receipt = await compensateAction(r, context);
    out.push(receipt);
    if (failFast && isFailureStatus(receipt.status)) break;
  }
  return summarize(out, false);
}

/* ----------------------------------------------------------------------------------- *
 * Internals
 * ----------------------------------------------------------------------------------- */

/**
 * Resolves and runs one action through the policy → permission → (dry-run|execute) → retry
 * pipeline, returning a single receipt.
 * @param {import('./contracts.js').ActionDescriptor} action
 * @param {import('./contracts.js').ActionExecutionContext} context
 * @param {boolean} dryRun
 * @returns {Promise<import('./contracts.js').ActionReceipt>}
 */
async function runOne(action, context, dryRun) {
  const env = makeEnv(context);
  const started = env.now();

  const invalid = validateDescriptor(action);
  if (invalid) return skipReceipt(action, started, env, context, dryRun, invalid);

  emit(env, ActionEventType.DECLARED, action, context);

  // The core may already have marked the action blocked (unresolved inputs).
  if (action.status === ActionStatus.BLOCKED) {
    const error = {
      code: ActionErrorCode.ACTION_BLOCKED,
      message: `action '${action.id}' is blocked: inputs are not resolved`,
    };
    emit(env, ActionEventType.BLOCKED, action, context, error);
    return skipReceipt(action, started, env, context, dryRun, error);
  }

  const handler = lookupHandler(action.type, context);
  if (!handler) {
    const error = {
      code: ActionErrorCode.HANDLER_NOT_FOUND,
      message: `no handler registered for action type '${action.type}'`,
    };
    return skipReceipt(action, started, env, context, dryRun, error);
  }

  // Policy (type/environment/confirmation) then handler env then permissions — all fail-closed.
  const policy = resolveActionPolicy(context);
  const decision = decideAction(action, policy, {
    environment: context.environment,
    confirmedActions: context.confirmedActions,
  });
  if (decision.effect === 'deny') {
    const error = {
      code: decision.code ?? ActionErrorCode.POLICY_DENIED,
      message: decision.reason ?? 'denied by policy',
    };
    emit(env, ActionEventType.POLICY_DENIED, action, context, error);
    return skipReceipt(action, started, env, context, dryRun, error);
  }
  if (decision.effect === 'confirm') {
    const error = {
      code: ActionErrorCode.CONFIRMATION_REQUIRED,
      message: decision.reason ?? 'confirmation required',
    };
    emit(env, ActionEventType.CONFIRMATION_REQUIRED, action, context, error);
    return skipReceipt(action, started, env, context, dryRun, error);
  }

  const envCheck = checkHandlerEnvironment(action, handler.allowedEnvironments);
  if (envCheck.effect === 'deny') {
    const error = {
      code: envCheck.code ?? ActionErrorCode.ENVIRONMENT_DENIED,
      message: envCheck.reason ?? 'environment denied',
    };
    emit(env, ActionEventType.POLICY_DENIED, action, context, error);
    return skipReceipt(action, started, env, context, dryRun, error);
  }

  const permCheck = checkPermissions(
    action,
    handler.requiredPermissions ?? [],
    context.permissions
  );
  if (permCheck.effect === 'deny') {
    const error = {
      code: permCheck.code ?? ActionErrorCode.PERMISSION_DENIED,
      message: permCheck.reason ?? 'permission denied',
    };
    emit(env, ActionEventType.POLICY_DENIED, action, context, error);
    return skipReceipt(action, started, env, context, dryRun, error);
  }

  // Optional handler-side validation.
  if (typeof handler.validate === 'function') {
    let verdict;
    try {
      verdict = handler.validate(
        action.input,
        handlerContext(action, context, { dryRun, attempt: 1 })
      );
    } catch (ex) {
      verdict = ex instanceof Error ? ex.message : String(ex);
    }
    if (verdict !== true) {
      const error = {
        code: ActionErrorCode.VALIDATION_ERROR,
        message: typeof verdict === 'string' ? verdict : `action '${action.id}' failed validation`,
      };
      return skipReceipt(action, started, env, context, dryRun, error);
    }
  }

  emit(
    env,
    dryRun ? ActionEventType.DRY_RUN_STARTED : ActionEventType.EXECUTION_STARTED,
    action,
    context
  );
  return invokeWithRetry(action, handler, context, env, dryRun, started);
}

/**
 * Invokes the handler's `dryRun`/`execute`, applying the retry policy. Idempotency key is
 * constant across attempts. Returns the terminal receipt.
 * @param {import('./contracts.js').ActionDescriptor} action
 * @param {import('./contracts.js').ActionHandler} handler
 * @param {import('./contracts.js').ActionExecutionContext} context
 * @param {ReturnType<typeof makeEnv>} env
 * @param {boolean} dryRun
 * @param {number} started
 * @returns {Promise<import('./contracts.js').ActionReceipt>}
 */
async function invokeWithRetry(action, handler, context, env, dryRun, started) {
  if (dryRun && typeof handler.dryRun !== 'function') {
    // No dry-run support: a deterministic simulated receipt that performs no effect.
    const finished = env.now();
    emit(env, ActionEventType.DRY_RUN_SUCCEEDED, action, context);
    return finalizeReceipt(
      action,
      ActionStatus.SUCCEEDED,
      started,
      finished,
      env,
      context,
      { simulated: true, input: redactInput(action, context) },
      0,
      true
    );
  }

  const fn = dryRun ? /** @type {Function} */ (handler.dryRun) : handler.execute;
  /** @type {import('./contracts.js').ActionRetry} */
  const retry = dryRun ? { attempts: 0, backoffMs: 0, strategy: 'fixed' } : resolveRetry(action);
  const maxAttempts = 1 + Math.max(0, retry.attempts);

  /** @type {import('./contracts.js').ActionError | undefined} */
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const handlerCtx = handlerContext(action, context, { dryRun, attempt });
      const out = await fn(action.input, handlerCtx);
      const finished = env.now();
      emit(
        env,
        dryRun ? ActionEventType.DRY_RUN_SUCCEEDED : ActionEventType.EXECUTION_SUCCEEDED,
        action,
        context
      );
      return finalizeReceipt(
        action,
        ActionStatus.SUCCEEDED,
        started,
        finished,
        env,
        context,
        out,
        attempt,
        dryRun
      );
    } catch (ex) {
      lastError = toActionError(
        ex,
        dryRun ? ActionErrorCode.DRY_RUN_UNSUPPORTED : ActionErrorCode.EXECUTION_FAILED
      );
      const retryable = lastError.retryable !== false && attempt < maxAttempts;
      emit(
        env,
        dryRun ? ActionEventType.DRY_RUN_FAILED : ActionEventType.EXECUTION_FAILED,
        action,
        context,
        lastError
      );
      if (!retryable) break;
      emit(env, ActionEventType.RETRY_SCHEDULED, action, context, lastError);
      await env.sleep(backoffFor(retry, attempt));
    }
  }

  const finished = env.now();
  const error = lastError ?? { code: ActionErrorCode.EXECUTION_FAILED, message: 'action failed' };
  if (error.retryable !== false && maxAttempts > 1) error.code = ActionErrorCode.RETRY_EXHAUSTED;
  return failReceipt(action, ActionStatus.FAILED, started, env, error, finished, context);
}

/**
 * Runs a plan sequentially, honoring `failFast`. Duplicate ids fail the whole plan closed.
 * @param {import('./contracts.js').ActionPlan} plan
 * @param {import('./contracts.js').ActionExecutionContext} context
 * @param {boolean} dryRun
 * @returns {Promise<import('./contracts.js').ActionExecutionResult>}
 */
async function runPlan(plan, context, dryRun) {
  const actions = Array.isArray(plan) ? plan : [];
  const env = makeEnv(context);
  const dup = findDuplicateActionId(actions);
  if (dup) {
    const started = env.now();
    const receipts = actions.map((a) =>
      buildReceipt(a, ActionStatus.SKIPPED, started, started, env, context, dryRun, {
        code: ActionErrorCode.DUPLICATE_ACTION_ID,
        message: `duplicate action id '${dup}' in plan`,
      })
    );
    return summarize(receipts, dryRun);
  }

  const failFast = resolveFailFast(context);
  /** @type {import('./contracts.js').ActionReceipt[]} */
  const receipts = [];
  for (const action of actions) {
    const receipt = await runOne(action, context, dryRun);
    receipts.push(receipt);
    if (failFast && isFailureStatus(receipt.status)) break;
  }
  return summarize(receipts, dryRun);
}

/** @param {import('./contracts.js').ActionReceipt[]} receipts @param {boolean} dryRun @returns {import('./contracts.js').ActionExecutionResult} */
function summarize(receipts, dryRun) {
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  for (const r of receipts) {
    if (r.status === ActionStatus.SUCCEEDED || r.status === ActionStatus.COMPENSATED) succeeded++;
    else if (r.status === ActionStatus.SKIPPED) skipped++;
    else if (isFailureStatus(r.status)) failed++;
  }
  // `completed` only when every receipt succeeded; `skipped` when nothing ran at all; `failed`
  // when nothing succeeded but something failed; otherwise the outcome is mixed → `partial`.
  let status;
  if (succeeded === 0 && failed === 0) status = PlanStatus.SKIPPED;
  else if (succeeded > 0 && failed === 0 && skipped === 0) status = PlanStatus.COMPLETED;
  else if (succeeded === 0) status = PlanStatus.FAILED;
  else status = PlanStatus.PARTIAL;
  return { status, dryRun, receipts, succeeded, failed, skipped };
}

/* --- receipt construction --- */

/** @param {import('./contracts.js').ActionDescriptor} action @returns {import('./contracts.js').ActionError | null} */
function validateDescriptor(action) {
  if (!action || typeof action !== 'object') {
    return {
      code: ActionErrorCode.INVALID_ACTION_DESCRIPTOR,
      message: 'action descriptor is not an object',
    };
  }
  if (typeof action.id !== 'string' || action.id.length === 0) {
    return {
      code: ActionErrorCode.INVALID_ACTION_DESCRIPTOR,
      message: 'action descriptor needs a string id',
    };
  }
  if (typeof action.type !== 'string' || action.type.length === 0) {
    return {
      code: ActionErrorCode.INVALID_ACTION_DESCRIPTOR,
      message: `action '${action.id}' needs a string type`,
    };
  }
  return null;
}

/**
 * @param {import('./contracts.js').ActionDescriptor} action @param {ActionStatus[keyof ActionStatus]} status
 * @param {number} started @param {number} finished @param {ReturnType<typeof makeEnv>} env
 * @param {import('./contracts.js').ActionExecutionContext} context @param {boolean} dryRun
 * @param {import('./contracts.js').ActionError} [error]
 * @returns {import('./contracts.js').ActionReceipt}
 */
function buildReceipt(action, status, started, finished, env, context, dryRun, error) {
  /** @type {import('./contracts.js').ActionReceipt} */
  const receipt = {
    actionId: action.id,
    type: action.type,
    status,
    environment: action.environment,
    dryRun,
    idempotencyKey: action.idempotencyKey,
    startedAt: started,
    finishedAt: finished,
    durationMs: finished - started,
    attempts: 0,
  };
  if (context.actor) receipt.actor = context.actor;
  if (action.metadata) receipt.metadata = action.metadata;
  if (error) receipt.error = error;
  return receipt;
}

/**
 * A non-executing skip receipt (unconfirmed / denied / blocked / handler-not-found).
 * @param {import('./contracts.js').ActionDescriptor} action @param {number} started
 * @param {ReturnType<typeof makeEnv>} env @param {import('./contracts.js').ActionExecutionContext} context
 * @param {boolean} dryRun @param {import('./contracts.js').ActionError} error
 * @returns {import('./contracts.js').ActionReceipt}
 */
function skipReceipt(action, started, env, context, dryRun, error) {
  return buildReceipt(
    action,
    ActionStatus.SKIPPED,
    started,
    env.now(),
    env,
    context,
    dryRun,
    error
  );
}

/**
 * A failure receipt for a handler that ran and threw (or a compensation failure).
 * @param {import('./contracts.js').ActionDescriptor} action @param {ActionStatus[keyof ActionStatus]} status
 * @param {number} started @param {ReturnType<typeof makeEnv>} env @param {import('./contracts.js').ActionError} error
 * @param {number} [finished] @param {import('./contracts.js').ActionExecutionContext} [context]
 * @returns {import('./contracts.js').ActionReceipt}
 */
function failReceipt(action, status, started, env, error, finished, context) {
  const r = buildReceipt(
    action,
    status,
    started,
    finished ?? env.now(),
    env,
    context ?? {},
    false,
    error
  );
  return r;
}

/**
 * A success/compensation receipt enriched with the (redacted) handler output. `attempts` is
 * the number of handler invocations performed.
 * @param {import('./contracts.js').ActionDescriptor} action
 * @param {ActionStatus[keyof ActionStatus]} status @param {number} started @param {number} finished
 * @param {ReturnType<typeof makeEnv>} env @param {import('./contracts.js').ActionExecutionContext} context
 * @param {unknown} output @param {number} attempts @param {boolean} [dryRun]
 * @returns {import('./contracts.js').ActionReceipt}
 */
function finalizeReceipt(
  action,
  status,
  started,
  finished,
  env,
  context,
  output,
  attempts,
  dryRun
) {
  const r = buildReceipt(
    action,
    status,
    started,
    finished,
    env,
    context,
    dryRun ?? env.dryRunFlag,
    undefined
  );
  r.attempts = attempts;
  const safeOut = output === undefined ? undefined : redactValue(output, action, context, 'output');
  if (
    safeOut &&
    typeof safeOut === 'object' &&
    typeof (/** @type {any} */ (safeOut).externalId) === 'string'
  ) {
    r.externalId = /** @type {any} */ (safeOut).externalId;
  }
  if (safeOut !== undefined) r.output = safeOut;
  return r;
}

/* --- handler/context plumbing --- */

/** @param {string} type @param {import('./contracts.js').ActionExecutionContext} context @returns {import('./contracts.js').ActionHandler | undefined} */
function lookupHandler(type, context) {
  const registry = context.registry ?? context.engine?.config?.registry;
  return registry?.getAction?.(type);
}

/**
 * @param {import('./contracts.js').ActionDescriptor} action
 * @param {import('./contracts.js').ActionExecutionContext} context
 * @param {{ dryRun: boolean, attempt: number }} opts
 * @returns {import('./contracts.js').ActionHandlerContext}
 */
function handlerContext(action, context, opts) {
  /** @type {import('./contracts.js').ActionHandlerContext} */
  const ctx = {
    actionId: action.id,
    type: action.type,
    environment: action.environment,
    idempotencyKey: action.idempotencyKey,
    dryRun: opts.dryRun,
    attempt: opts.attempt,
    clients: context.clients ?? {},
  };
  if (context.actor) ctx.actor = context.actor;
  if (context.correlationId) ctx.correlationId = context.correlationId;
  if (action.metadata) ctx.metadata = action.metadata;
  return ctx;
}

/** @param {import('./contracts.js').ActionExecutionContext} context */
function resolveActionPolicy(context) {
  if (context.policy) return context.policy;
  const engPolicy = /** @type {any} */ (context.engine?.config?.policy);
  return engPolicy?.action ?? {};
}

/** @param {import('./contracts.js').ActionExecutionContext} context @returns {boolean} */
function resolveFailFast(context) {
  if (typeof context.failFast === 'boolean') return context.failFast;
  return resolveActionPolicy(context).failFast === true;
}

/** @param {import('./contracts.js').ActionDescriptor} action @returns {import('./contracts.js').ActionRetry} */
function resolveRetry(action) {
  const r = action.retry ?? { attempts: 0, backoffMs: 0, strategy: 'fixed' };
  return {
    attempts: r.attempts ?? 0,
    backoffMs: r.backoffMs ?? 0,
    strategy: r.strategy ?? 'fixed',
  };
}

/** @param {import('./contracts.js').ActionRetry} retry @param {number} attempt @returns {number} */
function backoffFor(retry, attempt) {
  if (retry.backoffMs <= 0) return 0;
  return retry.strategy === 'exponential' ? retry.backoffMs * 2 ** (attempt - 1) : retry.backoffMs;
}

/* --- redaction + audit --- */

/** @param {import('./contracts.js').ActionDescriptor} action @param {import('./contracts.js').ActionExecutionContext} context */
function redactInput(action, context) {
  return redactValue(action.input, action, context, 'input');
}

/** @param {unknown} value @param {{ id: string, type: string }} action @param {import('./contracts.js').ActionExecutionContext} context @param {string} field */
function redactValue(value, action, context, field) {
  if (typeof context.redact !== 'function') return value;
  try {
    return context.redact(value, { actionId: action.id, type: action.type, field });
  } catch {
    return value; // a throwing redact hook must not break execution
  }
}

/**
 * Emits an audit event to the host hook (SPEC §2.8). Effect-free; a throwing hook is swallowed.
 * @param {ReturnType<typeof makeEnv>} env @param {string} type
 * @param {{ id: string, type: string, environment: string, idempotencyKey?: string, input?: unknown }} action
 * @param {import('./contracts.js').ActionExecutionContext} context
 * @param {import('./contracts.js').ActionError} [error]
 */
function emit(env, type, action, context, error) {
  if (typeof context.audit !== 'function') return;
  /** @type {import('./contracts.js').ActionAuditEvent} */
  const event = {
    type,
    actionId: action.id,
    actionType: action.type,
    environment: action.environment,
    timestamp: env.now(),
  };
  if (context.actor) event.actor = context.actor;
  if (context.correlationId) event.correlationId = context.correlationId;
  if (action.idempotencyKey) event.idempotencyKey = action.idempotencyKey;
  if (error) event.error = error;
  try {
    context.audit(event);
  } catch {
    /* an audit sink must never break execution */
  }
}

/** Builds the deterministic environment (clock/sleep) for one call. @param {import('./contracts.js').ActionExecutionContext} context */
function makeEnv(context) {
  const clock = context.clock ?? (() => new Date());
  return {
    now: () => clock().getTime(),
    sleep:
      context.sleep ??
      ((ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve())),
    dryRunFlag: context.dryRun === true,
  };
}

/** @param {unknown} ex @param {string} fallbackCode @returns {import('./contracts.js').ActionError} */
function toActionError(ex, fallbackCode) {
  if (ex && typeof ex === 'object') {
    const e = /** @type {any} */ (ex);
    /** @type {import('./contracts.js').ActionError} */
    const error = {
      code: typeof e.code === 'string' ? e.code : fallbackCode,
      message: typeof e.message === 'string' ? e.message : String(ex),
    };
    if (typeof e.retryable === 'boolean') error.retryable = e.retryable;
    if (e.data && typeof e.data === 'object') error.data = e.data;
    return error;
  }
  return { code: fallbackCode, message: String(ex) };
}
