# Reference

The normative sources that define Seebo's behaviour, plus the historical design records.
The developer-facing pages of this site (architecture, usage, API) are companions to these
documents — when they disagree, the reference wins.

| Document                                      | Role                                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [Language & API spec](spec.md)                | **SPEC** — the language (types, expressions, requirements, macros) and the engine API.     |
| [Implementation spec](impl.md)                | **IMPL** — the phase pipeline, contracts, diagnostics (App. A), borderline cases (App. B). |
| [v1 normative decisions](clarifications.md)   | Clarifications that resolve SPEC/IMPL ambiguities for v1.                                  |
| [Binding redesign (proposal)](binding-redesign.md) | Historical design record of the 0.3.0 declarative-surface redesign (superseded in part). |

!!! info "Language of the reference specs"

    SPEC, IMPL and the clarifications are written in **Italian** — they are the original
    normative documents the engine was built from and are kept verbatim. The rest of the
    site is in English.

## Known editorial quirks in the specs

These are documented typos in the source specs — do not "fix" them by inventing content:

- **IMPL skips §14 in its numbering** in one place; it is a numbering typo
  (clarifications §12). No content is missing and no §14 section should be invented —
  the sections proceed §13 → §15.
- **"Stebo" vs "Seebo".** Some occurrences in the SPEC use "Stebo"; the canonical project
  name is **Seebo**. The convenience API is deliberately called `stebo` (lowercase), per
  SPEC §2.5.

## How conformance is enforced

Every behaviour in SPEC/IMPL maps to an executable test: `test/conformance/**` restates the
spec sections as runnable cases (each test cites its section), and IMPL Appendix B's
borderline cases have a dedicated coverage map. See
[Testing & conformance](../testing/testing.md).
