/**
 * @file Stringification of typed values (SPEC §1.3, IMPL §4.3/§4.4). `toText` renders a
 * value to its final text at slot emission (SPEC §1.1, principle 1), driven by the
 * value's `format`/`constraints`. Pure; depends only on the value (and an optional
 * `locale`, accepted for forward-compatibility — the float decimal separator comes from
 * `format.decimalSep`, defaulting to ',' per SPEC §1.3).
 */

import { DURATION_UNITS } from './values.js';

/**
 * Renders a typed value to text. For a **custom type** (SPEC §2.6) the optional `registry`
 * supplies the type's `stringify(value, format)`; without one, a JSON/primitive fallback is
 * used so a registered type always renders.
 * @param {import('./values.js').Value} value
 * @param {string} [_locale]
 * @param {import('./registry.js').Registry} [registry]
 * @returns {string}
 */
export function toText(value, _locale, registry) {
  switch (value.type) {
    case 'int':
      return formatInt(value);
    case 'float':
      return formatFloat(value);
    case 'bool':
      return value.value ? labelTrue(value) : labelFalse(value);
    case 'string':
      return /** @type {string} */ (value.value);
    case 'datetime':
      return formatDatetime(value);
    case 'duration':
      return formatDuration(value);
    case 'object':
    case 'array':
      return JSON.stringify(value.value);
    default:
      return formatCustom(value, registry);
  }
}

/**
 * Renders a custom-type value via its registered `stringify`, or a safe default.
 * @param {import('./values.js').Value} value
 * @param {import('./registry.js').Registry} [registry]
 * @returns {string}
 */
function formatCustom(value, registry) {
  const def = registry?.getType?.(value.type);
  if (def && typeof def.stringify === 'function') {
    return String(def.stringify(value.value, value.format ?? {}));
  }
  const v = value.value;
  return v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/* ----------------------------------------------------------------------------------- *
 * Numbers
 * ----------------------------------------------------------------------------------- */

/** @param {import('./values.js').Value} v */
function formatInt(v) {
  const sep = stringField(v.format, 'thousands', '');
  const n = /** @type {number} */ (v.value);
  const sign = n < 0 ? '-' : '';
  return sign + group(Math.abs(n).toString(), sep);
}

/** @param {import('./values.js').Value} v */
function formatFloat(v) {
  const precision = numField(v.constraints, 'precision', 2);
  const decimalSep = stringField(v.format, 'decimalSep', ',');
  const thousands = stringField(v.format, 'thousands', '');
  const n = /** @type {number} */ (v.value);
  const sign = n < 0 ? '-' : '';
  const fixed = Math.abs(n).toFixed(precision);
  const dot = fixed.indexOf('.');
  const intPart = dot === -1 ? fixed : fixed.slice(0, dot);
  let fracPart = dot === -1 ? '' : fixed.slice(dot + 1);
  // `trimZeros` (set by duration totals, IMPL §4.3 / SPEC §1.5): render the natural value
  // without padding zeros, so `duration(50*3600).totalHours()` is "50", not "50,00". General
  // floats keep their fixed `precision`.
  if (v.format && v.format.trimZeros === true) fracPart = fracPart.replace(/0+$/, '');
  const grouped = group(intPart, thousands);
  return sign + (fracPart ? grouped + decimalSep + fracPart : grouped);
}

/**
 * Inserts a thousands separator into a run of digits (no-op when `sep` is empty).
 * @param {string} digits @param {string} sep
 */
function group(digits, sep) {
  if (!sep) return digits;
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

/* ----------------------------------------------------------------------------------- *
 * Booleans
 * ----------------------------------------------------------------------------------- */

/** @param {import('./values.js').Value} v */
function labelTrue(v) {
  return stringField(v.format, 'trueLabel', 'true');
}
/** @param {import('./values.js').Value} v */
function labelFalse(v) {
  return stringField(v.format, 'falseLabel', 'false');
}

/* ----------------------------------------------------------------------------------- *
 * Datetime (SPEC §1.3, clarifications §5 token subset)
 * ----------------------------------------------------------------------------------- */

/** @param {import('./values.js').Value} v */
function formatDatetime(v) {
  const pattern = stringField(v.format, 'pattern', 'YYYY-MM-DDTHH:mm:ssZ');
  const d = new Date(/** @type {number} */ (v.value));
  /** @type {Record<string, string>} */
  const parts = {
    YYYY: String(d.getUTCFullYear()).padStart(4, '0'),
    MM: pad2(d.getUTCMonth() + 1),
    DD: pad2(d.getUTCDate()),
    HH: pad2(d.getUTCHours()),
    mm: pad2(d.getUTCMinutes()),
    ss: pad2(d.getUTCSeconds()),
    Z: 'Z',
  };
  return pattern.replace(/YYYY|MM|DD|HH|mm|ss|Z/g, (tok) => parts[tok]);
}

/* ----------------------------------------------------------------------------------- *
 * Duration (SPEC §1.3, IMPL §4.4): leftmost token accumulates overflow.
 * ----------------------------------------------------------------------------------- */

/** Duration pattern tokens, longest-first for greedy matching. */
const DURATION_TOKENS = [
  { token: 'HH', factor: 3600, pad: true },
  { token: 'mm', factor: 60, pad: true },
  { token: 'ss', factor: 1, pad: true },
  { token: 'W', factor: 604800, pad: false },
  { token: 'D', factor: 86400, pad: false },
  { token: 'H', factor: 3600, pad: false },
  { token: 'm', factor: 60, pad: false },
  { token: 's', factor: 1, pad: false },
];

/** @param {import('./values.js').Value} v */
function formatDuration(v) {
  const pattern = stringField(v.format, 'pattern', 'HH:mm:ss');
  const precisionUnit = stringField(v.constraints, 'precision', 'second');
  const factor = DURATION_UNITS[precisionUnit] ?? 1;
  const raw = /** @type {number} */ (v.value);
  const truncated = Math.trunc(raw / factor) * factor; // truncate to the precision unit
  const sign = truncated < 0 ? '-' : '';
  let remaining = Math.abs(truncated);

  // Parse the pattern into literal/unit parts.
  /** @type {Array<{ lit: string } | { factor: number, pad: boolean }>} */
  const parts = [];
  for (let i = 0; i < pattern.length; ) {
    const match = DURATION_TOKENS.find((t) => pattern.startsWith(t.token, i));
    if (match) {
      parts.push({ factor: match.factor, pad: match.pad });
      i += match.token.length;
    } else {
      parts.push({ lit: pattern[i] });
      i += 1;
    }
  }

  // Assign values left-to-right: the leftmost unit absorbs all higher-unit overflow.
  let out = '';
  for (const part of parts) {
    if ('lit' in part) {
      out += part.lit;
      continue;
    }
    const val = Math.floor(remaining / part.factor);
    remaining %= part.factor;
    out += part.pad ? pad2(val) : String(val);
  }
  return sign + out;
}

/* ----------------------------------------------------------------------------------- *
 * Helpers
 * ----------------------------------------------------------------------------------- */

/** @param {number} n */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Reads a string field from a (possibly missing) format/constraints object.
 * @param {Record<string, unknown> | undefined} obj @param {string} key @param {string} dflt
 */
function stringField(obj, key, dflt) {
  const v = obj ? obj[key] : undefined;
  return typeof v === 'string' ? v : dflt;
}

/**
 * Reads a numeric field from a (possibly missing) format/constraints object.
 * @param {Record<string, unknown> | undefined} obj @param {string} key @param {number} dflt
 */
function numField(obj, key, dflt) {
  const v = obj ? obj[key] : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}
