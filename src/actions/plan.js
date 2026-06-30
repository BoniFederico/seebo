/**
 * @file Pure action-plan helpers (SPEC §2.8, IMPL §16). The bridge between an `action({...})`
 * AST call and an {@link import('./contracts.js').ActionDescriptor}. Everything here is pure
 * and synchronous: it builds descriptors, normalizes input deterministically and derives a
 * stable idempotency key. It performs NO effect and imports NO executor code — so the
 * evaluator, `run`, `analyze` and `validate` can depend on it without breaking the purity rule.
 *
 * Security: action `input` flows through {@link import('../runtime/sanitize.js').sanitizeJson}
 * (drops `__proto__`, rejects non-JSON/cyclic, bounds depth/size) exactly like every other
 * value, so a hostile template cannot pollute prototypes through an action.
 */

import { createHash } from 'node:crypto';
import { sanitizeJson } from '../runtime/sanitize.js';
import { SeeboError, DiagnosticCode } from '../util/errors.js';
import { ActionStatus } from './contracts.js';

/** Fields read off a declared action descriptor; everything else lands in `metadata`. */
const KNOWN_FIELDS = new Set([
  'id',
  'type',
  'input',
  'confirm',
  'environment',
  'dryRun',
  'idempotencyKey',
  'permissions',
  'retry',
  'metadata',
  'compensable',
]);

/**
 * Builds an {@link import('./contracts.js').ActionDescriptor} from the already-evaluated
 * fields of an `action({...})` call (SPEC §2.8). Pure; throws a {@link SeeboError} only on a
 * structurally invalid descriptor (missing `id`/`type`), mirroring `need`.
 *
 * @param {Record<string, unknown>} fields  Plain-JS values of the descriptor object.
 * @param {Object} [opts]
 * @param {boolean} [opts.blocked=false]  `true` when some input requirement is still unresolved.
 * @param {string} [opts.defaultEnvironment='test']  Environment when the descriptor pins none.
 * @param {import('../util/errors.js').Diagnostic[]} [opts.diagnostics]  Reasons it is blocked.
 * @returns {import('./contracts.js').ActionDescriptor}
 * @throws {SeeboError}  `SYNTAX_ERROR` when `id`/`type` are missing or not strings.
 */
export function buildActionDescriptor(fields, opts = {}) {
  const id = fields.id;
  const type = fields.type;
  if (typeof id !== 'string' || id.length === 0) {
    throw actionSyntax("action(...) descriptor needs a non-empty string 'id'");
  }
  if (typeof type !== 'string' || type.length === 0) {
    throw actionSyntax(`action '${id}' needs a non-empty string 'type'`);
  }

  const blocked = opts.blocked === true;
  const input = normalizeActionInput(fields.input);
  const environment =
    typeof fields.environment === 'string' && fields.environment.length > 0
      ? fields.environment
      : (opts.defaultEnvironment ?? 'test');
  const requiresConfirmation = fields.confirm === true;
  const dryRun = fields.dryRun === true;
  const permissions = normalizePermissions(fields.permissions, id);
  const retry = normalizeRetry(fields.retry, id);
  const metadata = collectMetadata(fields);

  const idempotencyKey =
    typeof fields.idempotencyKey === 'string' && fields.idempotencyKey.length > 0
      ? fields.idempotencyKey
      : computeIdempotencyKey({ id, type, environment, input });

  /** @type {import('./contracts.js').ActionDescriptor} */
  const descriptor = {
    id,
    type,
    input,
    status: blocked
      ? ActionStatus.BLOCKED
      : requiresConfirmation
        ? ActionStatus.PENDING_CONFIRMATION
        : ActionStatus.READY,
    environment,
    requiresConfirmation,
    dryRun,
    idempotencyKey,
    permissions,
  };
  if (retry) descriptor.retry = retry;
  if (metadata) descriptor.metadata = metadata;
  if (fields.compensable === true) descriptor.compensable = true;
  if (blocked && opts.diagnostics && opts.diagnostics.length > 0) {
    descriptor.diagnostics = opts.diagnostics;
  }
  return descriptor;
}

/**
 * Deterministically normalizes an action's `input` to sanitized JSON (SPEC §2.8). A missing
 * input becomes `{}`. The result is a plain, pollution-safe object suitable for hashing.
 * @param {unknown} input  Raw input value (already reduced to plain JS by the evaluator).
 * @returns {Record<string, unknown>}
 * @throws {SeeboError}  When `input` is present but not a plain object.
 */
export function normalizeActionInput(input) {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw actionSyntax("action 'input' must be an object");
  }
  return /** @type {Record<string, unknown>} */ (sanitizeJson(input));
}

/**
 * Computes a stable idempotency key (SPEC §2.8): a hex SHA-256 over the canonical JSON of
 * `{ id, type, environment, input }`. Identical inputs across runs/retries yield the same key;
 * key generation is therefore deterministic and side-effect free.
 * @param {{ id: string, type: string, environment: string, input: Record<string, unknown> }} parts
 * @returns {string}  32-hex-char (128-bit) idempotency key.
 */
export function computeIdempotencyKey(parts) {
  const canonical = canonicalize({
    id: parts.id,
    type: parts.type,
    environment: parts.environment,
    input: parts.input,
  });
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 32);
}

/**
 * Recursively sorts object keys so two structurally-equal inputs serialize identically,
 * regardless of declaration order (deterministic hashing). Arrays keep their order.
 * @param {unknown} value
 * @returns {unknown}
 */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalize(/** @type {Record<string, unknown>} */ (value)[key]);
    }
    return out;
  }
  return value;
}

/** @param {unknown} perms @param {string} id @returns {string[]} */
function normalizePermissions(perms, id) {
  if (perms === undefined) return [];
  if (!Array.isArray(perms) || perms.some((p) => typeof p !== 'string')) {
    throw actionSyntax(`action '${id}' 'permissions' must be an array of strings`);
  }
  return /** @type {string[]} */ (perms);
}

/** @param {unknown} retry @param {string} id @returns {import('./contracts.js').ActionRetry | undefined} */
function normalizeRetry(retry, id) {
  if (retry === undefined) return undefined;
  if (typeof retry !== 'object' || retry === null || Array.isArray(retry)) {
    throw actionSyntax(`action '${id}' 'retry' must be an object`);
  }
  const r = /** @type {Record<string, unknown>} */ (retry);
  const attempts = r.attempts ?? 0;
  const backoffMs = r.backoffMs ?? 0;
  if (typeof attempts !== 'number' || !Number.isInteger(attempts) || attempts < 0) {
    throw actionSyntax(`action '${id}' 'retry.attempts' must be a non-negative integer`);
  }
  if (typeof backoffMs !== 'number' || !Number.isFinite(backoffMs) || backoffMs < 0) {
    throw actionSyntax(`action '${id}' 'retry.backoffMs' must be a non-negative number`);
  }
  const strategy = r.strategy ?? 'fixed';
  if (strategy !== 'fixed' && strategy !== 'exponential') {
    throw actionSyntax(`action '${id}' 'retry.strategy' must be 'fixed' or 'exponential'`);
  }
  return { attempts, backoffMs, strategy };
}

/** Collects non-reserved descriptor fields plus an explicit `metadata` object. @param {Record<string, unknown>} fields */
function collectMetadata(fields) {
  /** @type {Record<string, unknown>} */
  const meta = {};
  let has = false;
  if (fields.metadata && typeof fields.metadata === 'object' && !Array.isArray(fields.metadata)) {
    for (const [k, v] of Object.entries(/** @type {Record<string, unknown>} */ (fields.metadata))) {
      if (k === '__proto__') continue;
      meta[k] = v;
      has = true;
    }
  }
  for (const [k, v] of Object.entries(fields)) {
    if (KNOWN_FIELDS.has(k) || k === '__proto__') continue;
    meta[k] = v;
    has = true;
  }
  return has ? /** @type {Record<string, unknown>} */ (sanitizeJson(meta)) : undefined;
}

/**
 * Finds the first duplicate action id in document order (SPEC §2.8). Returns `undefined` when
 * ids are unique; used by `analyze`/`validate`/the executor to flag a {@link
 * import('./contracts.js').ActionErrorCode} `DUPLICATE_ACTION_ID`.
 * @param {ReadonlyArray<{ id: string }>} actions
 * @returns {string | undefined}
 */
export function findDuplicateActionId(actions) {
  const seen = new Set();
  for (const a of actions) {
    if (seen.has(a.id)) return a.id;
    seen.add(a.id);
  }
  return undefined;
}

/** @param {string} message @returns {SeeboError} */
function actionSyntax(message) {
  return new SeeboError(message, { code: DiagnosticCode.SYNTAX_ERROR });
}
