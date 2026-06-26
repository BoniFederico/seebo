/**
 * @file Macros barrel: shared macro constants plus re-exports of the EXPAND/FINALIZE
 * contracts ({@link ./expand.js}, {@link ./finalize.js}).
 */

import { BUILTIN_MACRO_NAMES } from '../util/vocabulary.js';

export { expand } from './expand.js';
export { finalize } from './finalize.js';

/**
 * Macro families (IMPL §3.1: `MacroNode.family`).
 * @type {Readonly<Record<string, string>>}
 */
export const MacroFamily = Object.freeze({
  AGGREGATOR: 'aggregator',
  LAYOUT: 'layout',
});

/**
 * Builtin macros (SPEC §1.5, reserved words). Aggregators first, then layout. Re-exported
 * from the canonical {@link ../util/vocabulary.js}.
 * @type {ReadonlyArray<string>}
 */
export const BUILTIN_MACROS = BUILTIN_MACRO_NAMES;
