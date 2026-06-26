/**
 * @file Test harness barrel: re-exports pipeline + assertion utilities and shared
 * test options.
 */

export { realEngine, createFakeEngine } from './pipeline.js';
export {
  codesOf,
  assertCodes,
  assertHasCode,
  assertNotImplemented,
  normalizeOutput,
} from './expect.js';

/**
 * Shared option for conformance cases whose assertions are written against the real
 * engine but cannot pass yet (the language is not implemented in v1). The test body is
 * kept as the executable specification but is NOT run, keeping the report clean. Flip to
 * an active test (remove `PENDING`) as each feature lands.
 * @type {{ skip: string }}
 */
export const PENDING = { skip: 'pending: language not implemented (v1 scaffolding)' };
