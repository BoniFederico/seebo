/**
 * @file Versions of the public contracts that cross the engine↔application boundary.
 * See SPEC §2.1 and IMPL §15. The three versions evolve independently.
 */

/**
 * Version of the AST shape (IMPL §3.1). Bumped when a node's structure changes or a
 * node is added/removed.
 * @type {number}
 */
export const AST_VERSION = 1;

/**
 * Version of the `PublicState` shape (IMPL §6.1). Bumped when a field of the persisted
 * state changes.
 * @type {number}
 */
export const STATE_VERSION = 1;

/**
 * Version of the `Analysis` shape (IMPL §9). Bumped when the shape of the `analyze`
 * output changes.
 * @type {number}
 */
export const ANALYSIS_VERSION = 1;

/**
 * Registered state migrators, applied in sequence `v → v+1` (IMPL §15). Empty in v1;
 * minimal structure provided for future migrations.
 * @type {ReadonlyArray<{ from: number, to: number, migrate: (state: any) => any }>}
 */
export const migrations = Object.freeze([]);

/**
 * Brings a persisted `PublicState` to the current {@link STATE_VERSION} (IMPL §14).
 *
 * - **Backward** (supported): when `found < STATE_VERSION`, the registered migrators are
 *   applied in sequence `v → v+1` until the current version is reached. If the chain cannot
 *   reach it, the state is rejected rather than guessed.
 * - **Forward** (not guaranteed): when `found > STATE_VERSION`, the state is rejected — an
 *   engine never guesses the shape produced by a newer one.
 *
 * Pure: never mutates the input. A missing `stateVersion` is treated as the current version
 * (states produced by {@link import('../run/run.js').start} always carry it).
 *
 * @param {any} state  The persisted state to upgrade.
 * @returns {{ ok: true, state: any } | { ok: false, found: number }}  The migrated state, or
 *   a rejection carrying the offending version (the caller emits `UNSUPPORTED_STATE_VERSION`).
 */
export function migrateState(state) {
  const found = typeof state?.stateVersion === 'number' ? state.stateVersion : STATE_VERSION;
  if (found > STATE_VERSION) return { ok: false, found };
  if (found === STATE_VERSION) return { ok: true, state };

  let current = state;
  let version = found;
  // Apply migrators in order until we reach the current version (deterministic, finite).
  for (;;) {
    if (version === STATE_VERSION) return { ok: true, state: current };
    const step = migrations.find((m) => m.from === version);
    if (!step) return { ok: false, found }; // no path to the current version
    current = step.migrate(current);
    version = step.to;
  }
}
