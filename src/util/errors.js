/**
 * @file Seebo error policy: error classes, normative diagnostic codes and `Diagnostic`
 * constructors. Skeleton only in v1 (no language logic).
 *
 * Two distinct channels, per SPEC §2.1 / IMPL Appendix A:
 *  - **Diagnostic** (structured, accumulable data): the normal result of tokenize /
 *    validate / analyze and of non-fatal errors. See {@link createDiagnostic}.
 *  - **Error** (JS exception): used only where the SPEC mandates a `throw` (e.g. `parse`
 *    on malformed syntax) or for internal programming errors.
 */

/**
 * Stable diagnostic codes (IMPL Appendix A). Part of the public contract: never
 * renamed; adding new ones is non-breaking.
 * @type {Readonly<Record<string, string>>}
 */
export const DiagnosticCode = Object.freeze({
  SYNTAX_ERROR: 'SYNTAX_ERROR',
  UNDECLARED_NAME: 'UNDECLARED_NAME',
  UNKNOWN_FUNCTION: 'UNKNOWN_FUNCTION',
  UNKNOWN_METHOD: 'UNKNOWN_METHOD',
  ARITY_MISMATCH: 'ARITY_MISMATCH',
  TYPE_ERROR: 'TYPE_ERROR',
  NON_EXHAUSTIVE_MATCH: 'NON_EXHAUSTIVE_MATCH',
  UNKNOWN_CAPABILITY: 'UNKNOWN_CAPABILITY',
  POLICY_FORBIDDEN: 'POLICY_FORBIDDEN',
  RESERVED_NAME: 'RESERVED_NAME',
  NAME_CONFLICT: 'NAME_CONFLICT',
  CYCLE_DETECTED: 'CYCLE_DETECTED',
  STREAM_NOT_FULL: 'STREAM_NOT_FULL',
  TYPE_ERROR_RUNTIME: 'TYPE_ERROR_RUNTIME',
  CONSTRAINT_VIOLATION: 'CONSTRAINT_VIOLATION',
  DIVISION_BY_ZERO: 'DIVISION_BY_ZERO',
  INCLUSION_CYCLE: 'INCLUSION_CYCLE',
  DEPTH_EXCEEDED: 'DEPTH_EXCEEDED',
  MAX_PHASES_EXCEEDED: 'MAX_PHASES_EXCEEDED',
  OUTPUT_LIMIT_EXCEEDED: 'OUTPUT_LIMIT_EXCEEDED',
  TIMEOUT: 'TIMEOUT',
  CAPABILITY_FORBIDDEN: 'CAPABILITY_FORBIDDEN',
  CAPABILITY_ERROR: 'CAPABILITY_ERROR',
  CAPABILITY_INVALID_VALUE: 'CAPABILITY_INVALID_VALUE',
  UNSUPPORTED_STATE_VERSION: 'UNSUPPORTED_STATE_VERSION',
});

/**
 * Pipeline phase that produced a diagnostic (IMPL Appendix A).
 * @typedef {'createEngine'|'tokenize'|'parse'|'validate'|'analyze'|'run'|'driver'} Phase
 */

/**
 * Diagnostic severity level.
 * @typedef {'error'|'warning'|'info'} Severity
 */

/**
 * Structured diagnostic (IMPL Appendix A). Canonical shape of non-exceptional feedback.
 * Diagnostics are accumulate-able data; they are NOT thrown — use {@link SeeboError} for exceptions.
 * @typedef {Object} Diagnostic
 * @property {string}   code         Stable identifier from {@link DiagnosticCode}. Never renamed.
 * @property {Severity} severity     Severity level of the diagnostic.
 * @property {Phase}    phase        Pipeline phase that produced this diagnostic.
 * @property {boolean}  recoverable  `true` when the phase continued and may have accumulated more diagnostics.
 * @property {string}   message      Human-readable text, already localized or redacted per policy.
 * @property {{ start: number, end: number }} [position]  Byte offsets in the template source; absent for non-textual diagnostics.
 * @property {Record<string, unknown>} [data]  Code-specific structured payload for programmatic inspection (e.g. `{ name }`).
 */

/**
 * Builds a {@link Diagnostic}. Pure helper, no side effects.
 *
 * @param {string} code One of {@link DiagnosticCode}.
 * @param {Object} [opts]
 * @param {Severity} [opts.severity='error']
 * @param {Phase} [opts.phase='validate']
 * @param {boolean} [opts.recoverable=true]
 * @param {string} [opts.message='']
 * @param {{ start: number, end: number }} [opts.position]
 * @param {Record<string, unknown>} [opts.data]
 * @returns {Diagnostic}
 */
export function createDiagnostic(code, opts = {}) {
  const {
    severity = 'error',
    phase = 'validate',
    recoverable = true,
    message = '',
    position,
    data,
  } = opts;
  /** @type {Diagnostic} */
  const diag = { code, severity, phase, recoverable, message };
  if (position) diag.position = position;
  if (data) diag.data = data;
  return diag;
}

/**
 * Base Seebo error. All engine exceptions derive from it, so the host can tell an
 * engine failure apart from an arbitrary runtime error.
 * @extends {Error}
 */
export class SeeboError extends Error {
  /**
   * @param {string} message
   * @param {Object} [opts]
   * @param {string} [opts.code]
   * @param {{ start: number, end: number }} [opts.position]
   * @param {unknown} [opts.cause]
   */
  constructor(message, opts = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'SeeboError';
    /** @type {string|undefined} */
    this.code = opts.code;
    /** @type {{ start: number, end: number }|undefined} */
    this.position = opts.position;
  }
}

/**
 * Engine configuration error (`createEngine`): reserved word, name conflict, invalid
 * config. Non-recoverable (IMPL Appendix A, `createEngine` phase).
 * @extends {SeeboError}
 */
export class EngineConfigError extends SeeboError {
  /**
   * @param {string} message
   * @param {Object} [opts]
   * @param {string} [opts.code]
   * @param {Record<string, unknown>} [opts.data]
   */
  constructor(message, opts = {}) {
    super(message, opts);
    this.name = 'EngineConfigError';
    /** @type {Record<string, unknown>|undefined} */
    this.data = opts.data;
  }
}

/**
 * Marker for functionality not implemented yet. Used by the v1 scaffolding placeholders;
 * it will disappear as the modules are completed.
 * @extends {SeeboError}
 */
export class NotImplementedError extends SeeboError {
  /** @param {string} what Human-readable name of the missing functionality. */
  constructor(what) {
    super(`Not implemented yet: ${what}`, { code: 'NOT_IMPLEMENTED' });
    this.name = 'NotImplementedError';
  }
}
