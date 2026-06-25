# Known issues / note di progetto

## Refusi nelle specifiche sorgente

- **`IMPL.md` salta la sezione §14.** È un refuso di numerazione (clarifications §12):
  non esiste contenuto mancante e **non va inventata** alcuna sezione §14. Le sezioni
  procedono da §13 a §15.

- **"Stebo" vs "Seebo".** `spec.md` in alcune occorrenze usava "Stebo"; il nome
  canonico del progetto è **Seebo** (README + `impl.md`). L'API di convenienza si chiama
  `stebo` (minuscolo) come da SPEC §2.5.

## Decisioni v1 (vedi `docs/initial_docs/clarifications.md`)

- Nessuno streaming nella v1: `engine.steboStream()` **non** è esposto;
  `optimizations.stream` è accettato in config con default `false` ma inerte.
- Strategia di ripresa: **re-evaluation completa** a ogni `run` (strategia 1).
- Tutte le ottimizzazioni (`lazyParse`, `astCache`, `stream`, `objectPool`) off di default
  e non implementate in v1.
- Nessuna dipendenza esterna di runtime; `fake.*` resta esempio via `defineLibrary`.
- `date(pattern, testo)`: mini parser/formatter interno sul subset normativo di token
  (`YYYY MM DD HH mm ss Z`).
