/**
 * @file FINALIZE post-pass (SPEC §1.8, §2.5; IMPL §10.2): layout/removal macros
 * (`REMOVE_LINE`, `COLLAPSE`, `REMOVE_LEFT`, `REMOVE_RIGHT`). Runs on the **already
 * resolved text**, after formula evaluation.
 *
 * Layout macros are **positional markers**: each marker knows its own position in the
 * emitted text and removes itself plus the surrounding text it names. A marker reaches this
 * pass either (a) as a layout macro slot (`run` emits its canonical `@{NAME(args)}` source
 * into the output) or (b) as a string a formula produced (e.g. SPEC §2.7 emits the literal
 * `'@{REMOVE_LINE}'`). Both forms are handled identically here.
 *
 * Algorithm (IMPL §10.2): markers are applied **left-to-right**, recomputing offsets after
 * each edit (a removal that would fall inside an already-removed span is a no-op). Only the
 * recognized layout macro names are processed — the builtin set plus any **custom layout
 * macro** registered with an `apply` (SPEC §2.6); any other `@{…}` text is left untouched, so
 * arbitrary user data is not misinterpreted. Pure, synchronous, deterministic; no `eval`.
 *
 * Custom layout macros: a registered `defineMacro(name, { phase: 'finalize', apply })` is
 * invoked as `apply(slot, doc)` where `slot = { name, args, start, end }` (raw source `args`)
 * and `doc = { text }` is the full document; its return value (coerced to string) **replaces
 * the marker span**, which guarantees the marker is consumed and the pass terminates.
 */

import { SeeboError } from '../util/errors.js';
import { LAYOUT_MACRO_NAMES } from '../util/vocabulary.js';

const DEFAULT_DELIMITERS = { macro: '@', open: '{', close: '}' };

/** Builtin layout macro names recognized by FINALIZE (SPEC §1.8). */
const LAYOUT_MACROS = new Set(LAYOUT_MACRO_NAMES);

/** Hard cap on marker applications, defensive against pathological inputs. */
const MAX_MARKER_PASSES = 100_000;

/**
 * Applies the layout/removal macros found in the resolved text (IMPL §10.2).
 *
 * @param {string} resolvedText  Text emitted by `run`, possibly containing layout markers.
 * @param {import('../index.js').EngineConfig} [config]
 * @returns {string}  The finalized text.
 */
export function finalize(resolvedText, config) {
  const d = { ...DEFAULT_DELIMITERS, ...(config?.delimiters ?? {}) };
  const prefix = d.macro + d.open;
  const registry = /** @type {any} */ (config)?.registry;

  /** A name is recognized when it is a builtin layout macro or a custom layout macro with `apply`. */
  const customMacro = (/** @type {string} */ name) => {
    const def = registry?.getMacro?.(name);
    return def && def.family === 'layout' && typeof (/** @type {any} */ (def).apply) === 'function'
      ? def
      : undefined;
  };
  const isRecognized = (/** @type {string} */ name) =>
    LAYOUT_MACROS.has(name) || !!customMacro(name);

  let text = resolvedText;
  let collapseSeen = false;

  for (let pass = 0; pass < MAX_MARKER_PASSES; pass++) {
    const marker = findFirstMarker(text, prefix, d.close, isRecognized);
    if (!marker) break;
    if (LAYOUT_MACROS.has(marker.name)) {
      if (marker.name === 'COLLAPSE') collapseSeen = true;
      text = applyMarker(text, marker);
    } else {
      text = applyCustomMarker(text, marker, /** @type {any} */ (customMacro(marker.name)));
    }
  }

  if (collapseSeen) text = collapseBlankLines(text);
  return text;
}

/**
 * Applies a custom layout macro by replacing its marker span with the (stringified) result
 * of `apply(slot, doc)`. Replacing the span guarantees the marker is consumed (termination).
 * @param {string} text @param {Marker} m
 * @param {{ apply: (slot: object, doc: object) => unknown }} def
 * @returns {string}
 */
function applyCustomMarker(text, m, def) {
  const slot = { name: m.name, args: m.args, start: m.start, end: m.end };
  const replacement = def.apply(slot, { text });
  return text.slice(0, m.start) + String(replacement ?? '') + text.slice(m.end);
}

/**
 * @typedef {Object} Marker
 * @property {string} name  Macro name.
 * @property {string[]} args  Raw argument strings.
 * @property {number} start  Offset of the marker's first char (the sigil).
 * @property {number} end    Offset just past the closing delimiter.
 */

/**
 * Finds the leftmost recognized layout marker in `text`, or `null`. Unknown `@{…}` blocks
 * are skipped (left in place). Linear scan; no backtracking.
 * @param {string} text @param {string} prefix  The `sigil+open` sequence. @param {string} close
 * @param {(name: string) => boolean} isRecognized  Predicate for processable macro names.
 * @returns {Marker | null}
 */
function findFirstMarker(text, prefix, close, isRecognized) {
  let from = 0;
  for (;;) {
    const at = text.indexOf(prefix, from);
    if (at < 0) return null;
    const parsed = parseMarker(text, at, prefix.length, close);
    if (parsed && isRecognized(parsed.name)) return parsed;
    from = at + prefix.length; // not a recognized marker → keep scanning
  }
}

/**
 * Parses a `@{ NAME (args) }` block starting at `at`, or `null` if it is not well-formed.
 * @param {string} text @param {number} at @param {number} prefixLen @param {string} close
 * @returns {Marker | null}
 */
function parseMarker(text, at, prefixLen, close) {
  let i = at + prefixLen;
  i = skipSpaces(text, i);
  const nameStart = i;
  while (i < text.length && /[A-Za-z0-9_]/.test(text[i])) i++;
  if (i === nameStart) return null;
  const name = text.slice(nameStart, i);
  i = skipSpaces(text, i);

  /** @type {string[]} */
  let args = [];
  if (text[i] === '(') {
    const closeParen = text.indexOf(')', i);
    if (closeParen < 0) return null;
    const inner = text.slice(i + 1, closeParen).trim();
    args = inner === '' ? [] : inner.split(',').map((s) => s.trim());
    i = closeParen + 1;
  }
  i = skipSpaces(text, i);
  if (!text.startsWith(close, i)) return null;
  return { name, args, start: at, end: i + close.length };
}

/**
 * Applies a single marker's removal to the text (IMPL §10.2).
 * @param {string} text @param {Marker} m @returns {string}
 */
function applyMarker(text, m) {
  switch (m.name) {
    case 'REMOVE_LINE':
      return removeLine(text, m.start, m.end);
    case 'REMOVE_RIGHT':
      return cut(text, m.start, m.end + intArg(m.args[0]));
    case 'REMOVE_LEFT':
      return cut(text, m.start - intArg(m.args[0]), m.end);
    case 'COLLAPSE':
    default:
      return cut(text, m.start, m.end); // remove itself; blank-line collapse done at the end
  }
}

/**
 * Removes the entire line containing `[start, end)` (including its trailing newline, or the
 * preceding newline when it is the last line).
 * @param {string} text @param {number} start @param {number} end @returns {string}
 */
function removeLine(text, start, end) {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1; // 0 when no preceding newline
  const nl = text.indexOf('\n', end);
  if (nl < 0) {
    const dropFrom = lineStart > 0 ? lineStart - 1 : 0; // also drop the preceding newline
    return text.slice(0, dropFrom);
  }
  return text.slice(0, lineStart) + text.slice(nl + 1);
}

/**
 * Removes `[from, to)` (clamped to bounds). Empty/negative ranges are a no-op.
 * @param {string} text @param {number} from @param {number} to @returns {string}
 */
function cut(text, from, to) {
  const a = Math.max(0, from);
  const b = Math.min(text.length, to);
  if (b <= a) return text;
  return text.slice(0, a) + text.slice(b);
}

/** Collapses runs of 2+ blank lines into a single blank line (SPEC §1.8 `COLLAPSE`). @param {string} text @returns {string} */
function collapseBlankLines(text) {
  return text.replace(/(?:[ \t]*\r?\n){3,}/g, '\n\n');
}

/** @param {string} text @param {number} i @returns {number} */
function skipSpaces(text, i) {
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
  return i;
}

/** Parses a non-negative integer argument, defaulting to 0. @param {string} [s] @returns {number} */
function intArg(s) {
  const n = Number.parseInt(s ?? '', 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new SeeboError(`layout macro expects a non-negative integer, got '${s}'`);
  }
  return n;
}
