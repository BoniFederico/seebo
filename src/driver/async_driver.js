/**
 * @file Async driver (IMPL §7) — the ONLY asynchronous layer. It satisfies the `Need`s
 * emitted by the pure `run` (IMPL §6) by querying the registered capabilities, classifies
 * each provider result into one of the four normative outcomes (IMPL §7.1), then re-runs
 * the pure state machine until completion or a stable `waiting` (stopped capabilities) /
 * `failed`. `stebo` is the convenience orchestrator expand → drive → finalize (SPEC §2.5).
 */

import { start, run } from '../run/run.js';
import { STATE_VERSION } from '../util/versions.js';
import { expand } from '../macros/expand.js';
import { finalize } from '../macros/finalize.js';
import { fromJs, validate, withFormat, withConstraints } from '../runtime/values.js';
import { createDiagnostic, DiagnosticCode, SeeboError } from '../util/errors.js';

/**
 * Normative provider outcomes (IMPL §7.1).
 * @type {Readonly<Record<string, string>>}
 */
export const ProviderOutcome = Object.freeze({
  RESOLVED: 'Resolved',
  UNRESOLVED: 'Unresolved',
  PROVIDER_ERROR: 'ProviderError',
  INVALID_VALUE: 'InvalidValue',
});

/**
 * @typedef {(req: import('../eval/evaluator.js').RequirementDescriptor) => unknown | Promise<unknown>} CapabilityProvider
 * @typedef {Object} DriveOptions @property {string[]} [stopOn]
 * @typedef {Object} SteboArgs
 * @property {string} template
 * @property {Record<string, string>} [templates]
 * @property {Record<string, unknown>} [values]
 * @property {string[]} [stopOn]
 */

/**
 * Drives a state (or template) toward completion (IMPL §7.3). Needs whose capability is in
 * `stopOn` (e.g. interactive `user`) are left in `pending` and returned to the caller.
 *
 * @param {import('../run/run.js').PublicState | string} stateOrTemplate
 * @param {DriveOptions} [opts]
 * @param {import('../index.js').EngineConfig} [config]
 * @returns {Promise<import('../run/run.js').PublicState>}
 */
export async function drive(stateOrTemplate, opts, config) {
  const cfg = config ?? {};
  const stopOn = new Set(opts?.stopOn ?? []);
  const maxPhases = cfg.limits?.maxPhases ?? 10;

  let state =
    typeof stateOrTemplate === 'string' ? start(stateOrTemplate, undefined, cfg) : stateOrTemplate;
  state = run(state, cfg);

  let guard = 0;
  while (state.status === 'waiting') {
    if (++guard > maxPhases) {
      return failed(state, DiagnosticCode.MAX_PHASES_EXCEEDED, { limit: maxPhases });
    }
    const { satisfied, failure } = await resolvePending(state.pending, cfg, stopOn);
    if (failure) return { ...state, status: 'failed', pending: [], diagnostics: [failure] };
    if (Object.keys(satisfied).length === 0) break; // no progress (all stopped/unresolved)
    state = run({ ...state, resolved: { ...state.resolved, ...satisfied } }, cfg);
  }
  return state;
}

/**
 * Convenience orchestrator (SPEC §2.5): expand → drive → finalize. `values` pre-populate
 * `resolved` (clarifications §10) so already-provided Needs do not reappear.
 *
 * @param {SteboArgs} args
 * @param {import('../index.js').EngineConfig} [config]
 * @returns {Promise<import('../run/run.js').PublicState>}
 */
export async function stebo(args, config) {
  const cfg = config ?? {};

  // (a) pre-pass: EXPAND aggregators. A cyclic/over-deep inclusion is a fatal run error.
  let composed;
  try {
    composed = await expand({ template: args.template, templates: args.templates }, cfg);
  } catch (e) {
    return expandFailure(args.template, e);
  }

  // (b) multi-phase resolution via the driver (§6.3/§7).
  let state = start(composed, args.values, cfg);
  state = await drive(state, { stopOn: args.stopOn }, cfg);

  // (c) post-pass: FINALIZE layout macros on the resolved text.
  if (state.status === 'completed' && typeof state.output === 'string') {
    state = { ...state, output: finalize(state.output, cfg) };
  }
  return state;
}

/**
 * Builds a `failed` PublicState from an EXPAND error (IMPL §10.1 / B.5).
 * @param {string} template @param {unknown} e @returns {import('../run/run.js').PublicState}
 */
function expandFailure(template, e) {
  const code = e instanceof SeeboError && e.code ? e.code : DiagnosticCode.INCLUSION_CYCLE;
  return {
    stateVersion: STATE_VERSION,
    template,
    resolved: {},
    pending: [],
    phase: 0,
    status: 'failed',
    diagnostics: [
      createDiagnostic(code, {
        severity: 'error',
        phase: 'run',
        recoverable: false,
        message: e instanceof Error ? e.message : String(e),
      }),
    ],
  };
}

/* ----------------------------------------------------------------------------------- *
 * Need resolution
 * ----------------------------------------------------------------------------------- */

/**
 * Resolves the pending Needs that are not stopped, returning the satisfied values or the
 * first failure diagnostic.
 * @param {import('../eval/evaluator.js').RequirementDescriptor[]} pending
 * @param {import('../index.js').EngineConfig} cfg
 * @param {Set<string>} stopOn
 * @returns {Promise<{ satisfied: Record<string, import('../runtime/values.js').Value>, failure?: import('../util/errors.js').Diagnostic }>}
 */
async function resolvePending(pending, cfg, stopOn) {
  /** @type {Record<string, import('../runtime/values.js').Value>} */
  const satisfied = {};
  const allowed = cfg.policy?.allowedCapabilities;

  for (const need of pending) {
    const cap = need.capability;
    if (stopOn.has(cap)) continue; // returned to the caller

    if (allowed && !allowed.includes(cap)) {
      return { satisfied, failure: diag(DiagnosticCode.CAPABILITY_FORBIDDEN, { capability: cap }) };
    }
    const provider = cfg.capabilities?.[cap];
    if (typeof provider !== 'function') continue; // no provider → leave for a later turn

    const outcome = await callProvider(provider, need, cfg);
    auditEvent(cfg, need, outcome.kind);

    if (outcome.kind === ProviderOutcome.RESOLVED) {
      satisfied[need.id] = /** @type {import('../runtime/values.js').Value} */ (outcome.value);
    } else if (outcome.kind === ProviderOutcome.UNRESOLVED) {
      // leave in pending
    } else if (outcome.kind === ProviderOutcome.PROVIDER_ERROR) {
      return {
        satisfied,
        failure: diag(DiagnosticCode.CAPABILITY_ERROR, { capability: cap, cause: outcome.message }),
      };
    } else {
      return {
        satisfied,
        failure: diag(DiagnosticCode.CAPABILITY_INVALID_VALUE, {
          capability: cap,
          got: redacted(cfg, cap, outcome.message),
        }),
      };
    }
  }
  return { satisfied };
}

/**
 * Invokes one provider and classifies the result (IMPL §7.1), applying the timeout and the
 * `policy.retry` attempts (no retry by default — clarifications §6).
 * @param {CapabilityProvider} provider
 * @param {import('../eval/evaluator.js').RequirementDescriptor} need
 * @param {import('../index.js').EngineConfig} cfg
 * @returns {Promise<{ kind: string, value?: import('../runtime/values.js').Value, message?: string }>}
 */
async function callProvider(provider, need, cfg) {
  const attempts = Math.max(0, cfg.policy?.retry?.attempts ?? 0);
  const backoffMs = Math.max(0, cfg.policy?.retry?.backoffMs ?? 0);
  const timeoutMs = cfg.limits?.timeoutMs;

  let lastError = 'provider error';
  for (let attempt = 0; attempt <= attempts; attempt++) {
    try {
      const raw = await withTimeout(Promise.resolve(provider(need)), timeoutMs);
      if (raw === undefined) return { kind: ProviderOutcome.UNRESOLVED };

      let value;
      try {
        value = fromJs(raw);
      } catch (e) {
        return { kind: ProviderOutcome.INVALID_VALUE, message: message(e) };
      }
      // Enforce the requirement's declared type & constraints (IMPL §7.1 InvalidValue):
      // a capability can never inject a value the type system would reject.
      const wantType = need.type?.type;
      if (wantType && value.type !== wantType) {
        return {
          kind: ProviderOutcome.INVALID_VALUE,
          message: `expected ${wantType}, got ${value.type}`,
        };
      }
      value = withConstraints(withFormat(value, need.type?.format), need.type?.constraints);
      const violation = validate(value);
      if (violation) return { kind: ProviderOutcome.INVALID_VALUE, message: violation.message };
      return { kind: ProviderOutcome.RESOLVED, value };
    } catch (e) {
      lastError = message(e);
      if (attempt < attempts && backoffMs > 0) await delay(backoffMs);
    }
  }
  return { kind: ProviderOutcome.PROVIDER_ERROR, message: lastError };
}

/* ----------------------------------------------------------------------------------- *
 * Helpers
 * ----------------------------------------------------------------------------------- */

/**
 * @template T @param {Promise<T>} promise @param {number} [ms] @returns {Promise<T>}
 */
function withTimeout(promise, ms) {
  if (!ms || ms <= 0) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`capability timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/** @param {number} ms */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @param {unknown} e */
function message(e) {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Emits an audit event (no secret value), honoring `policy.audit` (clarifications §6).
 * @param {import('../index.js').EngineConfig} cfg
 * @param {import('../eval/evaluator.js').RequirementDescriptor} need
 * @param {string} outcome
 */
function auditEvent(cfg, need, outcome) {
  const audit = cfg.policy?.audit;
  if (typeof audit === 'function') {
    audit({ capability: need.capability, id: need.id, outcome });
  }
}

/**
 * Masks a value for a redacted capability (clarifications §6, IMPL §13).
 * @param {import('../index.js').EngineConfig} cfg @param {string} cap @param {unknown} value
 */
function redacted(cfg, cap, value) {
  return cfg.policy?.redact?.includes(cap) ? '«redacted»' : value;
}

/** @param {string} code @param {Record<string, unknown>} data */
function diag(code, data) {
  return createDiagnostic(code, {
    severity: 'error',
    phase: 'driver',
    recoverable: false,
    message: code,
    data,
  });
}

/**
 * @param {import('../run/run.js').PublicState} state @param {string} code @param {Record<string, unknown>} data
 * @returns {import('../run/run.js').PublicState}
 */
function failed(state, code, data) {
  return {
    ...state,
    status: 'failed',
    pending: [],
    diagnostics: [
      createDiagnostic(code, {
        severity: 'error',
        phase: 'run',
        recoverable: false,
        message: code,
        data,
      }),
    ],
  };
}
