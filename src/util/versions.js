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
 * @type {ReadonlyArray<{ from: number, to: number, migrate: (state: unknown) => unknown }>}
 */
export const migrations = Object.freeze([]);
