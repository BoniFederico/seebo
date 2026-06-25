/**
 * @file Bench placeholder (v1). No real measurement until the pipeline is implemented;
 * structure prepared for future micro-benchmarks with `node:perf_hooks`.
 *
 * Usage: `npm run bench`
 */

import { performance } from 'node:perf_hooks';
import { createEngine } from '../src/index.js';

/**
 * Runs a function `iterations` times and reports the average time (ms).
 * @param {string} name
 * @param {() => void} fn
 * @param {number} [iterations=1000]
 */
function bench(name, fn, iterations = 1000) {
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const total = performance.now() - t0;
  // Development script: console output here is intentional (not part of the core).
  console.log(`${name}: ${(total / iterations).toFixed(4)} ms/op (${iterations} ops)`);
}

function main() {
  console.log('Seebo bench (v1 placeholder) — no language benchmark yet.\n');
  bench('createEngine()', () => createEngine());
  console.log('\nTODO: add tokenize/parse/run benchmarks once implemented.');
}

main();
