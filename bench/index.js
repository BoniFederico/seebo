/**
 * @file Benchmark runner (IMPL §11/§12 — "measure first"). Times the representative public
 * operations (lexer, parser, render, macro, analyze) and, when run with `--expose-gc`,
 * reports the average heap allocated per op.
 *
 * Usage:
 *   npm run bench                 # timings only
 *   node --expose-gc bench/index.js   # timings + allocation estimate
 *   node bench/index.js --smoke   # tiny, fast run (CI smoke: verifies the bench still runs)
 *
 * This is a development script: `console` output here is intentional (not part of the core).
 */

import { performance } from 'node:perf_hooks';
import { createEngine } from '../src/index.js';
import { tokenize } from '../src/lexer/lexer.js';
import { parse } from '../src/parser/index.js';
import { buildCases } from './cases.js';

const gc = /** @type {undefined | (() => void)} */ (/** @type {any} */ (globalThis).gc);

/** Smoke mode (`--smoke`): tiny inputs and iteration counts so CI can verify the bench runs. */
const SMOKE = process.argv.includes('--smoke');
/** Default iteration count per case (kept small in smoke mode). */
const ITERATIONS = SMOKE ? 5 : 200;

/**
 * Runs `fn` repeatedly and reports time/op and (if `--expose-gc`) heap/op. Awaits the result
 * each iteration so async operations are measured correctly. Warms up first so the JIT has
 * compiled the hot path before measuring.
 *
 * @param {string} name
 * @param {() => unknown} fn
 * @param {{ iterations?: number, warmup?: number }} [opts]
 * @returns {Promise<void>}
 */
async function bench(name, fn, opts = {}) {
  const iterations = opts.iterations ?? ITERATIONS;
  const warmup = opts.warmup ?? Math.min(50, iterations);

  for (let i = 0; i < warmup; i++) await fn();

  if (gc) gc();
  const heapBefore = gc ? process.memoryUsage().heapUsed : 0;
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) await fn();
  const totalMs = performance.now() - t0;
  const heapAfter = gc ? process.memoryUsage().heapUsed : 0;

  const msPerOp = totalMs / iterations;
  const opsPerSec = Math.round(1000 / msPerOp);
  let line = `${name.padEnd(26)} ${msPerOp.toFixed(4)} ms/op  ${String(opsPerSec).padStart(8)} ops/s`;
  if (gc) {
    const kbPerOp = (heapAfter - heapBefore) / iterations / 1024;
    line += `  ${kbPerOp.toFixed(1).padStart(8)} KB/op`;
  }
  console.log(line);
}

async function main() {
  const c = buildCases(SMOKE ? 4 : undefined);
  const caps = { user: () => undefined };
  const engine = createEngine({ capabilities: caps });
  const cached = createEngine({ capabilities: caps, optimizations: { astCache: true } });

  console.log(
    `Seebo bench — scale=${c.scale}, node=${process.version}` +
      (gc ? '' : '  (run with --expose-gc for KB/op)')
  );
  console.log(
    `inputs: render=${c.renderTemplate.length}B parse=${c.parseTemplate.length}B text=${c.textTemplate.length}B macro=${c.macroTemplate.length}B\n`
  );

  // Lexer (pure, synchronous; IMPL §1; not affected by the AST cache).
  await bench('lexer.tokenize (text)', () => tokenize(c.textTemplate, engine.config));

  // Parser / render / analyze / macro — measured with the AST cache OFF (default) then ON
  // (optimizations.astCache, IMPL §11/§12.1) to isolate the caching win.
  await bench('parser.parse', () => parse(c.parseTemplate, engine.config));
  await bench('parser.parse +astCache', () => parse(c.parseTemplate, cached.config));

  await bench('render run()', () => engine.run(engine.start(c.renderTemplate, c.values)));
  await bench('render run() +astCache', () => cached.run(cached.start(c.renderTemplate, c.values)));

  await bench('analyze()', () => engine.analyze(c.parseTemplate));
  await bench('analyze() +astCache', () => cached.analyze(c.parseTemplate));

  const macroArgs = { template: c.macroTemplate, templates: c.templates, values: c.values };
  const macroIter = SMOKE ? 5 : 100;
  await bench('macro stebo()', () => engine.stebo(macroArgs), { iterations: macroIter });
  await bench('macro stebo() +astCache', () => cached.stebo(macroArgs), { iterations: macroIter });

  console.log('');
}

main();
