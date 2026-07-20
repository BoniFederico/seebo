# Contributing

Contributions are welcome — bug reports, documentation fixes and code. This page is the
short path from clone to merged PR.

## Setup

```bash
git clone https://github.com/BoniFederico/seebo.git
cd seebo
npm install   # dev tooling only (ESLint, Prettier, TypeScript for JSDoc checks)
```

Requirements: **Node.js ≥ 20**. There is no build step — the source runs as-is.

## The quality gate

CI (and `prepublishOnly`) run the same single command; run it before pushing:

```bash
npm run check   # format:check + lint + typecheck + test
```

Individually:

| Command                           | Purpose                                                    |
| --------------------------------- | ---------------------------------------------------------- |
| `npm test`                        | Full suite (`node:test`); must pass with no skipped tests. |
| `npm run lint` / `lint:fix`       | ESLint.                                                    |
| `npm run format` / `format:check` | Prettier (write / verify).                                 |
| `npm run typecheck`               | `tsc --noEmit` over the JSDoc contracts.                   |
| `npm run bench:smoke`             | Fast benchmark run (CI verifies it still executes).        |

## Coding conventions

- **Plain JavaScript + JSDoc.** No TypeScript syntax; contracts are expressed as JSDoc
  typedefs and checked with `tsc --noEmit`. Follow the
  [coding guidelines](development/coding-guidelines.md) — they define the JSDoc style for
  public functions, factories, builders, frozen constants and error classes.
- **English everywhere in code** — identifiers, comments and JSDoc.
- **Module shape**: named contract file(s) + an `index.js` barrel
  (see [project structure](development/project-structure.md)).
- **Purity rules are load-bearing**: the pure core must stay synchronous and effect-free;
  the action execution layer is only reachable via `seebo/actions`. Conformance tests
  enforce both — do not weaken them.
- **Diagnostic codes are a frozen contract**: never rename one; adding new codes is
  non-breaking.

## Tests

- A behaviour change needs a test. Component-level edge cases go in `test/unit/`;
  spec-derived end-to-end cases go in `test/conformance/` with a comment citing the
  specification section they restate (see [testing](testing/testing.md)).
- The suite must pass with **no skipped and no todo tests**.

## Commit and PR conventions

Commits follow a lightweight conventional style, as in the existing history:

```text
feat(binding)!: bind is value-only; declare need/action with prepare(...)
fix(validate)+cleanup: flag cross-kind duplicate ids
release: v0.3.0
```

- Branch from `master` (`feature/…`, `bugfix/…`), open a PR against `master`.
- Keep PRs focused; update the [changelog](changelog.md) under **[Unreleased]** for
  user-visible changes (Keep a Changelog format).
- Update documentation in the same PR when behaviour changes — the docs site builds from
  `docs/` with `mkdocs build --strict`, so broken links fail CI.

## Documentation contributions

```bash
pip install -r requirements.txt
mkdocs serve   # live preview at http://127.0.0.1:8000
```

The navigation is defined in `mkdocs.yml`. The historical design documents the engine was
built from live outside the site, in the repository's
[`spec/`](https://github.com/BoniFederico/seebo/tree/master/spec) folder — they are
archival records, kept verbatim.

## Releases

Maintainers release via **Actions → Release → Run workflow** (semver bump); see
[Deployment & release](deployment/deployment.md#releasing-to-npm).
