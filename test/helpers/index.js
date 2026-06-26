/**
 * @file Test harness barrel: re-exports pipeline + assertion utilities.
 */

export { realEngine, createFakeEngine } from './pipeline.js';
export { codesOf, assertCodes, assertHasCode, stripPositions, normalizeOutput } from './expect.js';
