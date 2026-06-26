# seebo

**Suspendable Evaluation Engine Built with Opus** — un motore di valutazione
sospendibile in cui il rendering di template è una delle applicazioni possibili.

> **Stato: v1 implementata.** L'intera pipeline è funzionante — lexer → parser →
> validate/analyze → run → driver, incorniciata da expand/finalize — con il sistema di
> tipi, gli operatori, le macro e l'estensibilità (`define*`). Il core è puro e
> sincrono; l'asincronia è confinata a `drive`/`stebo`. Le specifiche di riferimento
> sono in [`docs/initial_docs/spec.md`](docs/initial_docs/spec.md) (linguaggio + API) e
> [`docs/initial_docs/impl.md`](docs/initial_docs/impl.md) (implementazione); vedi anche
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/USAGE.md`](docs/USAGE.md),
> [`docs/SECURITY.md`](docs/SECURITY.md), [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md).

## Requisiti

- **Node.js ≥ 20** (usa `node:test` e gli ESM nativi).
- **Nessuna dipendenza di runtime.** Le devDependencies servono solo al dev tooling:
  **ESLint** (lint), **Prettier** (formattazione) e **TypeScript** (type-check via JSDoc,
  senza build).

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
- `test/unit/` — test per componente (lexer, parser, values, eval, registry, cache, API).
- `test/conformance/` — casi end-to-end derivati da SPEC/IMPL (espressioni, analyze,
  errori, limiti, estensioni, esempio §2.7, Appendice B). Ogni test documenta in commento
  la sezione di origine, l'input e l'output/errore atteso.

L'intera suite passa senza test saltati.

## Sviluppo

```bash
npm run format       # Prettier: formatta i file
npm run lint         # ESLint
npm run format:check # Prettier: verifica la formattazione (--check)
npm run typecheck    # tsc --noEmit: valida i contratti JSDoc (nessun output TS)
npm run bench        # benchmark (node:perf_hooks)
npm run bench:smoke  # benchmark rapido (smoke per la CI)
```

## Uso

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
const res = await engine.stebo({ template: '${ 1 + 2 * 3 }' });
res.output; // "7"
```

Vedi [`docs/USAGE.md`](docs/USAGE.md) per esempi completi (capability, estensioni,
policy).

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
test/        # unit + conformance
bench/       # benchmark (timings + allocazioni)
docs/        # specifiche e note (ARCHITECTURE, USAGE, SECURITY, PERFORMANCE, initial_docs)
```

## Licenza

MIT — vedi [LICENSE](LICENSE).
