# Reference specifications (project archive)

This folder holds the original design documents Seebo was built from. They are
engineering records, not user documentation — the user-facing docs live in
[`docs/`](../docs/) and on the published site.

| Document                                       | Role                                                                                     |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [`spec.md`](spec.md)                           | The language and API specification (types, expressions, requirements, macros).           |
| [`impl.md`](impl.md)                           | The implementation specification: pipeline, contracts, diagnostic codes, borderline cases. |
| [`clarifications.md`](clarifications.md)       | Normative v1 decisions that resolve ambiguities between the two documents above.         |
| [`binding-redesign.md`](binding-redesign.md)   | Historical design record of the 0.3.0 declarative-surface redesign (later superseded).   |

Notes:

- `spec.md`, `impl.md` and `clarifications.md` are written in **Italian** and are kept
  verbatim (they are excluded from Prettier formatting).
- The conformance tests in `test/conformance/` restate these documents as executable
  cases; each test cites, in a comment, the section it comes from.
- Known editorial quirks, documented so nobody "fixes" them by inventing content: the
  implementation spec skips section 14 in its numbering in one place (a typo — nothing is
  missing), and a few occurrences in the language spec use the older name "Stebo" where
  the canonical project name is **Seebo** (the convenience API is deliberately called
  `stebo`, lowercase).
