/**
 * @file Safe JSON sanitization for `object`/`array` values (clarifications §7).
 *
 * Security (task constraint): never trust input objects. `sanitizeJson` deep-clones only
 * JSON-shaped data (null, finite number, string, boolean, plain object, array), DROPS
 * `__proto__` keys to prevent prototype pollution, rejects non-plain objects (e.g. class
 * instances, `Date`), functions/symbols/bigint, non-finite numbers and circular
 * references, and enforces depth/size limits to bound work on hostile input.
 */

import { SeeboError, DiagnosticCode } from '../util/errors.js';

/**
 * Limits applied while sanitizing untrusted JSON values.
 * @type {Readonly<{ maxDepth: number, maxNodes: number }>}
 */
export const VALUE_LIMITS = Object.freeze({ maxDepth: 100, maxNodes: 100_000 });

/** @param {string} message */
function fail(message) {
  return new SeeboError(message, { code: DiagnosticCode.TYPE_ERROR_RUNTIME });
}

/**
 * Deep-clones `input` into a fresh JSON-only structure, applying the security rules above.
 *
 * @param {unknown} input
 * @param {{ maxDepth?: number, maxNodes?: number }} [limits]
 * @returns {unknown}
 */
export function sanitizeJson(input, limits = VALUE_LIMITS) {
  const maxDepth = limits.maxDepth ?? VALUE_LIMITS.maxDepth;
  const maxNodes = limits.maxNodes ?? VALUE_LIMITS.maxNodes;
  let nodes = 0;
  const seen = new WeakSet();

  /**
   * @param {unknown} v
   * @param {number} depth
   * @returns {unknown}
   */
  function clone(v, depth) {
    if (depth > maxDepth) throw fail('value nesting exceeds maxDepth');
    if (++nodes > maxNodes) throw fail('value exceeds maxNodes');

    if (v === null) return null;
    const t = typeof v;
    if (t === 'number') {
      if (!Number.isFinite(v)) throw fail('non-finite number is not a valid JSON value');
      return v;
    }
    if (t === 'string' || t === 'boolean') return v;
    if (t === 'undefined' || t === 'function' || t === 'symbol' || t === 'bigint') {
      throw fail(`unsupported value of type '${t}'`);
    }

    if (Array.isArray(v)) {
      if (seen.has(v)) throw fail('circular reference in value');
      seen.add(v);
      const out = v.map((item) => clone(item, depth + 1));
      seen.delete(v);
      return out;
    }

    // Plain objects only (reject class instances, Date, Map, etc.).
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) {
      throw fail('only plain objects are allowed as object values');
    }
    const obj = /** @type {object} */ (v);
    if (seen.has(obj)) throw fail('circular reference in value');
    seen.add(obj);
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const key of Object.keys(obj)) {
      // Drop `__proto__` (the only key whose assignment hits the prototype setter); other
      // keys are created with `defineProperty` so no inherited setter can ever run.
      if (key === '__proto__') continue;
      Object.defineProperty(out, key, {
        value: clone(/** @type {Record<string, unknown>} */ (obj)[key], depth + 1),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    seen.delete(obj);
    return out;
  }

  return clone(input, 0);
}
