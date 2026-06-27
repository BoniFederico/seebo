/**
 * @file Pure action-policy evaluation (SPEC §2.8, IMPL §16). Deterministic, fail-closed
 * decisions: given a descriptor, a policy and an execution context, decide whether an action
 * may run, must be confirmed, or must be denied. No I/O, no executor coupling — so `validate`
 * can reuse the same allow/deny logic the executor enforces at runtime.
 *
 * Fail-closed rule: when a dangerous ambiguity exists (e.g. an action type not on a present
 * allow-list, or an environment outside an explicit allow-list), the decision is `deny`.
 */

import { ActionErrorCode } from './contracts.js';

/**
 * Action-control policy (SPEC §2.8). All fields optional; an absent allow-list imposes no
 * restriction, an absent deny-list denies nothing. Folded into {@link
 * import('../index.js').ActionPolicy} on the engine policy.
 * @typedef {Object} ResolvedActionPolicy
 * @property {string[]} [allowedActions]  When present, only these action types may run.
 * @property {string[]} [deniedActions]  Action types that may never run (wins over allow).
 * @property {boolean} [requireConfirmation]  Force confirmation for *every* action.
 * @property {string[]} [requireConfirmationFor]  Force confirmation for these action types.
 * @property {string[]} [allowedEnvironments]  When present, only these environments are allowed.
 * @property {Record<string, string[]>} [actionEnvironmentRules]  Per-type environment allow-lists.
 * @property {boolean} [failFast]  Default `failFast` for plan execution.
 */

/**
 * One policy decision (SPEC §2.8).
 * @typedef {Object} PolicyDecision
 * @property {'allow'|'confirm'|'deny'} effect  The verdict.
 * @property {string} [code]  When `deny`, a {@link import('./contracts.js').ActionErrorCode}.
 * @property {string} [reason]  Human-readable explanation.
 */

/**
 * Decides whether an action may run under a policy and execution context (SPEC §2.8). Pure and
 * fail-closed. Does not check permissions — see {@link checkPermissions} — so `validate` (which
 * has no actor) can reuse the type/environment/confirmation parts.
 *
 * @param {import('./contracts.js').ActionDescriptor} descriptor
 * @param {ResolvedActionPolicy} [policy]
 * @param {{ environment?: string, confirmedActions?: string[] }} [ctx]
 * @returns {PolicyDecision}
 */
export function decideAction(descriptor, policy = {}, ctx = {}) {
  const type = descriptor.type;

  // Deny-list wins over everything.
  if (policy.deniedActions && policy.deniedActions.includes(type)) {
    return deny(ActionErrorCode.POLICY_DENIED, `action type '${type}' is denied by policy`);
  }
  // Allow-list: fail closed when present and the type is absent.
  if (policy.allowedActions && !policy.allowedActions.includes(type)) {
    return deny(ActionErrorCode.POLICY_DENIED, `action type '${type}' is not in allowedActions`);
  }

  // Environment allow-lists (global then per-type); fail closed when present and excluded.
  const env = descriptor.environment;
  if (policy.allowedEnvironments && !policy.allowedEnvironments.includes(env)) {
    return deny(
      ActionErrorCode.ENVIRONMENT_DENIED,
      `environment '${env}' is not in allowedEnvironments`
    );
  }
  const perTypeEnvs = policy.actionEnvironmentRules?.[type];
  if (perTypeEnvs && !perTypeEnvs.includes(env)) {
    return deny(
      ActionErrorCode.ENVIRONMENT_DENIED,
      `environment '${env}' is not allowed for action type '${type}'`
    );
  }

  // Confirmation: descriptor flag OR policy-forced.
  const mustConfirm =
    descriptor.requiresConfirmation === true ||
    policy.requireConfirmation === true ||
    (policy.requireConfirmationFor?.includes(type) ?? false);
  if (mustConfirm) {
    const confirmed = ctx.confirmedActions?.includes(descriptor.id) ?? false;
    if (!confirmed) {
      return {
        effect: 'confirm',
        code: ActionErrorCode.CONFIRMATION_REQUIRED,
        reason: `action '${descriptor.id}' requires explicit confirmation`,
      };
    }
  }

  return { effect: 'allow' };
}

/**
 * Verifies that the actor holds every required permission (SPEC §2.8). Required permissions are
 * the union of the descriptor's `permissions` and the handler's `requiredPermissions`.
 * @param {import('./contracts.js').ActionDescriptor} descriptor
 * @param {string[]} handlerRequired  `requiredPermissions` from the handler.
 * @param {string[] | undefined} granted  Permissions granted to the actor.
 * @returns {PolicyDecision}
 */
export function checkPermissions(descriptor, handlerRequired, granted) {
  const required = unique([...(descriptor.permissions ?? []), ...(handlerRequired ?? [])]);
  if (required.length === 0) return { effect: 'allow' };
  const have = new Set(granted ?? []);
  const missing = required.filter((p) => !have.has(p));
  if (missing.length > 0) {
    return deny(
      ActionErrorCode.PERMISSION_DENIED,
      `missing permission(s): ${missing.join(', ')}`,
      missing
    );
  }
  return { effect: 'allow' };
}

/**
 * Checks the descriptor's environment against a handler's `allowedEnvironments` (SPEC §2.8).
 * An absent handler allow-list imposes no restriction.
 * @param {import('./contracts.js').ActionDescriptor} descriptor
 * @param {string[] | undefined} handlerEnvironments
 * @returns {PolicyDecision}
 */
export function checkHandlerEnvironment(descriptor, handlerEnvironments) {
  if (!handlerEnvironments) return { effect: 'allow' };
  if (!handlerEnvironments.includes(descriptor.environment)) {
    return deny(
      ActionErrorCode.ENVIRONMENT_DENIED,
      `handler '${descriptor.type}' does not allow environment '${descriptor.environment}'`
    );
  }
  return { effect: 'allow' };
}

/** @param {string} code @param {string} reason @param {string[]} [missing] @returns {PolicyDecision} */
function deny(code, reason, missing) {
  /** @type {PolicyDecision} */
  const d = { effect: 'deny', code, reason };
  if (missing) /** @type {any} */ (d).missing = missing;
  return d;
}

/** @param {string[]} arr @returns {string[]} */
function unique(arr) {
  return [...new Set(arr)];
}
