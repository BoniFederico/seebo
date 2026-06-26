/**
 * @file Conformance — end-to-end orchestration (SPEC §2.4 state machine, §2.5 `stebo`,
 * §2.7 worked example).
 *
 * Contains the single REAL passing smoke (via the fake pipeline) plus the SPEC §2.7
 * case against the real engine, marked `todo` until the engine is implemented.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeEngine, realEngine, normalizeOutput, PENDING } from '../helpers/index.js';
import { Status } from '../../src/run/run.js';

/* ----------------------------------------------------------------------------------- *
 * Harness smoke — uses the FAKE deterministic pipeline (NOT Seebo semantics).
 * This proves the harness runs end-to-end and compares known output. Must always pass.
 * ----------------------------------------------------------------------------------- */

test('[smoke] fake pipeline completes with known output', async () => {
  const engine = createFakeEngine();
  // Input:  'Hello ${ name }!' with name = 'World'
  // Output: 'Hello World!'  | status completed | no pending
  const state = await engine.stebo({ template: 'Hello ${ name }!', values: { name: 'World' } });
  assert.equal(state.status, Status.COMPLETED);
  assert.equal(state.output, 'Hello World!');
  assert.deepEqual(state.pending, []);
});

test('[smoke] fake pipeline suspends on a missing value', () => {
  const engine = createFakeEngine();
  // Input:  'Hi ${ who }' with no values
  // Expect: status waiting | pending contains a requirement with id 'who'
  let state = engine.start('Hi ${ who }');
  state = engine.run(state);
  assert.equal(state.status, Status.WAITING);
  assert.deepEqual(
    state.pending.map((r) => r.id),
    ['who']
  );
  assert.equal(state.output, undefined);
});

test('[smoke] fake pipeline state shape is serializable', () => {
  const engine = createFakeEngine();
  const state = engine.run(engine.start('x ${ a }', { a: 1 }));
  // The public state must survive a JSON round-trip (IMPL §6.1).
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
});

/* ----------------------------------------------------------------------------------- *
 * SPEC §2.7 — worked example (real engine). TODO until implemented.
 * ----------------------------------------------------------------------------------- */

test('SPEC §2.7 — order email end-to-end', PENDING, async () => {
  // Input: the §2.7 template using secrets/crm/user capabilities as producers.
  // Values: { saluto: 'Gentile', note: '' }
  // Expected output (SPEC §2.7):
  //   Da: noreply@acme.io
  //   Oggetto: Ordine 42 — 1234,50 €
  //   Evaso 6 giorni fa.
  //   Gentile cliente,
  //   (the "Note" line is removed because note was empty)
  const engine = realEngine({
    locale: 'it-IT',
    clock: () => new Date('2026-06-26T10:00:00Z'), // deterministic "now" (SPEC §1.11)
    capabilities: {
      secrets: (req) => ({ mittente: 'noreply@acme.io' })[req.id],
      crm: (req) => ({ ordine: { id: 42, totale: 1234.5, data: '2026-06-20T10:00:00Z' } })[req.id],
      user: () => undefined,
    },
  });

  const template = [
    "#{ Intestazione email d'ordine }",
    "Da: ${ secrets({ id:'mittente', type:string() }) }",
    "Oggetto: Ordine ${ crm({ id:'ordine', type:object() }).id } — ${ float(ordine.totale).constraints({precision:2}) } €",
    'Evaso ${ (now() - datetime(ordine.data)).totalDays().round() } giorni fa.',
    "${ user({ id:'saluto', label:'Saluto', type: array().constraints({values:['Gentile','Ciao']}) }) } cliente,",
    "${ user({ id:'note', label:'Note aggiuntive?', type: string(), optional:true }) != '' ? 'Note: ' + note : '@{REMOVE_LINE}' }",
  ].join('\n');

  const res = await engine.stebo({ template, values: { saluto: 'Gentile', note: '' } });
  assert.equal(res.status, Status.COMPLETED);
  assert.equal(
    normalizeOutput(/** @type {string} */ (res.output)),
    normalizeOutput(
      [
        'Da: noreply@acme.io',
        'Oggetto: Ordine 42 — 1234,50 €',
        'Evaso 6 giorni fa.',
        'Gentile cliente,',
      ].join('\n')
    )
  );
});
