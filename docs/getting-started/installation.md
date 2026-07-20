# Installation

## Requirements

- **Node.js ≥ 20** — Seebo uses native ESM and, for development, the built-in `node:test`
  runner.
- **No runtime dependencies.** The published package is plain JavaScript + JSDoc: no
  TypeScript, no build step, nothing to compile.

## Install from npm

```bash
npm install seebo
```

The package ships two entry points:

| Import            | Contents                                                                |
| ----------------- | ----------------------------------------------------------------------- |
| `'seebo'`         | The engine: `createEngine`, `builtins`, the `define*` factories, types. |
| `'seebo/actions'` | The action **execution layer**: `executeActionPlan`, `dryRunAction`, …. |

```js
import { createEngine, builtins } from 'seebo';
import { executeActionPlan } from 'seebo/actions';
```

!!! note "Why two entry points"

    The pure core never performs effects. Importing the execution layer is an explicit,
    visible act of the host application — see the
    [actions guide](../guide/actions.md).

## Verify the installation

Save this as `hello.mjs` and run `node hello.mjs`:

```js
import { createEngine } from 'seebo';

const res = await createEngine().stebo({ template: '${ 1 + 2 * 3 }' });
console.log(res.status, res.output); // completed 7
```

!!! warning "Seebo is native ESM"

    Use `import` — in a `.mjs` file or in a project whose `package.json` has
    `"type": "module"`. On Node 20 and early 22.x, `require('seebo')` fails with
    `ERR_REQUIRE_ESM` (recent Node versions can `require()` ESM, but `import` is the
    supported path).

## Install from a clone (development)

```bash
git clone https://github.com/BoniFederico/seebo.git
cd seebo
npm install   # dev tooling only: ESLint, Prettier, TypeScript (JSDoc type-check)
npm test      # the whole suite (node:test, no test-framework dependency)
```

The dev dependencies cover tooling only — lint, format and JSDoc type-checking; the engine
itself has none. See [Contributing](../contributing.md) for the full development workflow.

## Next steps

- [Configuration](configuration.md) — what `createEngine(config)` accepts.
- [First run](first-run.md) — evaluate a template, suspend on missing data, resume.
