# seebo

**Suspendable Evaluation Engine Built with Opus** — un motore di valutazione
sospendibile in cui il rendering di template è una delle applicazioni possibili.

> ⚠️ **Stato: scaffolding v1.** L'API pubblica e la struttura dei moduli sono in
> piedi, ma il linguaggio **non è ancora implementato**: i metodi del motore sono
> placeholder e lanciano `NotImplementedError`. Le specifiche di riferimento sono in
> [`docs/initial_docs/spec.md`](docs/initial_docs/spec.md) (linguaggio + API) e
> [`docs/initial_docs/impl.md`](docs/initial_docs/impl.md) (implementazione).

## Requisiti

- **Node.js ≥ 20** (usa `node:test` e gli ESM nativi).
- Nessuna dipendenza di runtime. Le uniche devDependencies sono **Prettier**
  (formattazione) e **TypeScript** (solo per il type-check via JSDoc, senza build).

## Installazione

```bash
npm install
```

## Test

I test girano sul runner integrato di Node (`node:test`), senza dipendenze esterne.

```bash
npm test              # tutti i test
npm run test:unit         # solo unit test (componenti)
npm run test:conformance  # solo conformance test (end-to-end, guidati da SPEC/IMPL)
npm run test:watch        # modalità watch
```

Struttura (separazione unit vs conformance):

- `test/helpers/` — harness: `pipeline.js` (engine reale + una **pipeline finta**
  deterministica per lo smoke end-to-end), `expect.js` (confronto diagnostics/output).
- `test/unit/` — test per componente (lexer, parser, values, eval, API). I contratti
  (enum/costanti) passano già; i comportamenti sono `PENDING` finché non implementati.
- `test/conformance/` — casi end-to-end derivati da SPEC/IMPL (espressioni, analyze,
  errori, esempio §2.7, Appendice B). Ogni test documenta in commento la sezione di
  origine, l'input e l'output/errore atteso.

I casi non ancora eseguibili usano l'opzione condivisa `PENDING` (`{ skip: ... }`): il
corpo resta come **specifica eseguibile** ma non viene lanciato, così il report resta
pulito. Lo smoke end-to-end (`test/conformance/end_to_end.test.js`) passa già usando la
pipeline finta.

## Sviluppo

```bash
npm run format       # Prettier: formatta i file
npm run lint         # Prettier: verifica la formattazione (--check)
npm run typecheck    # tsc --noEmit: valida i contratti JSDoc (nessun output TS)
npm run bench        # benchmark placeholder (node:perf_hooks)
```

## Uso (anteprima dell'API)

L'API pubblica è già definita; le implementazioni arriveranno nelle milestone successive.

```js
import { createEngine, builtins } from 'seebo';

const engine = createEngine({
  ...builtins.all,
  capabilities: {
    user: (req) => undefined, // interattiva: i Need tornano all'orchestratore
  },
  locale: 'it-IT',
});

// Analisi statica (sincrona e pura): tokenize / parse / validate / analyze
// Esecuzione (sincrona e pura):     start / run
// Orchestrazione (asincrona):       expand / drive / finalize / stebo
```

## Struttura del progetto

```
src/
  lexer/     # tokenizzazione (IMPL §2)
  parser/    # recursive descent + Pratt (IMPL §3)
  ast/       # AST versionato e factory dei nodi (IMPL §3.1)
  runtime/   # sistema di tipi a runtime: values/types (IMPL §4)
  eval/      # valutatore sospendibile Ok|Susp|Err (IMPL §5)
  run/       # macchina a stati pura: start/run (IMPL §6)
  validate/  # diagnostiche statiche (IMPL §8)
  analyze/   # grafo/piano/metriche/streamability (IMPL §9)
  macros/    # expand (aggregatori) + finalize (layout) (IMPL §10)
  driver/    # driver asincrono + stebo (IMPL §7)
  util/      # errors + versioni dei contratti
  index.js   # façade pubblica: createEngine, builtins, define*
test/        # unit (smoke) + conformance
bench/       # benchmark placeholder
docs/        # specifiche e note (KNOWN_ISSUES, initial_docs)
```

## Licenza

MIT — vedi [LICENSE](LICENSE).
