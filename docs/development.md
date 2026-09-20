# Develop effect-acp

This page is for contributors to the package repository. Application installation and usage start in the [tutorial](tutorials/first-session.md).

## Install and check

From a repository checkout:

```sh
bun install
bun run check
```

`check` verifies generated schemas, typechecks the project and documentation examples, builds the package, runs lint with warnings denied, checks documentation links/snippet synchronization, runs tests, and checks source and built browser imports. Vendored repositories under `repos/` are read-only references and are excluded from application imports and lint.

## Build the package

```sh
bun run build
```

The build uses `tsconfig.build.json` to compile `src/` into `dist/`, preserving the module layout. It emits ES2022 ESM JavaScript, `.d.ts` declarations, and source/declaration maps. Relative runtime imports are rewritten from `.ts` to `.js`; Effect remains an external package dependency. Tests, examples, and vendored repositories are not emitted.

Public package exports resolve the compiled files in `dist`; TypeScript resolves their adjacent declarations. Repository `tsconfig.json` path mappings let the compiler and Bun use source imports during development. The package file allowlist includes `dist` and `src` so source maps can reach their original files. `dist` is ignored by Git.

The `prepack` hook runs the build. Packaging additionally needs a release `version` in `package.json`; building does not assign or increment one. Run `bun run build` before running `bun run check:browser` independently; the full `check` command builds first.

## Configure the editor

Installation runs `effect-tsgo patch --typescript --oxlint` to enable the Effect language service and Oxlint integration. Tooling versions are pinned in `package.json` and `bun.lock`.

Install the recommended TypeScript Native Preview, Oxc, and Effect Dev Tools extensions. Reload the editor and use the workspace TypeScript version. Oxlint provides the Effect diagnostics through the recommended type-aware preset; language-service diagnostics are disabled to avoid duplicate reports. The Effect language service still supplies hovers, completions, and refactors.

Run `bun run lint` for diagnostics or `bun run lint:fix` for available safe fixes. Both fail on warnings. Effect Dev Tools adds fiber, context, span-stack, and defect-breakpoint inspection in a supported debugging session.

## Maintain documentation examples

Complete TypeScript examples live in `docs/examples/` and import the package by its published name. The repository typecheck and lint include them. Each embedded TypeScript block has an `example` comment naming its source file. `bun run check:docs` checks that the block matches the file exactly and that relative Markdown links resolve.

After changing an example, update its embedded block as well. Run executable examples from a separate application directory to catch accidental reliance on repository-relative paths. Tutorial output must be observed, not inferred from typechecking. Real-agent handshakes do not verify account login, provider calls, or tool permissions.

Design context lives in [ARCHITECTURE.md](../ARCHITECTURE.md); [TYPE_AUDIT.md](../TYPE_AUDIT.md) records the type-boundary audit. Generated protocol codecs are maintained through `bun run generate`; `bun run generate:check` detects drift.
