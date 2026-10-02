# Publish effect-acp

Releases use Changesets, following [effectmq's release workflow](https://github.com/julia-script/effectmq/blob/main/.github/workflows/release.yml), with Bun for installation and build commands and npm for publication.

## First release

The package starts at `0.0.0`; `.changeset/initial-release.md` bumps it to `0.1.0`. Merge the setup into `main`, let CI pass, then review and merge the Changesets version PR. That PR updates `package.json` and `CHANGELOG.md` and refreshes the Bun lockfile.

Before release automation can open PRs, enable **Allow GitHub Actions to create and approve pull requests** under the repository's Actions settings. Create the `npm-production` GitHub environment without required reviewers, matching effectmq.

For a new npm package, perform the first publication from the checked `0.1.0` commit using your npm account. The automated release may fail authentication until the package exists and its trusted publisher is configured. In a clean checkout of the version PR after it merges:

```sh
bun install --frozen-lockfile
bun run check
bun run verify:package
npm login
npm publish --access public --provenance=false
```

Local publication disables provenance because the GitHub OIDC identity is unavailable locally. The package name is `effect-acp`; the repository currently remains `julia-script/acpclient`.

In npm's `effect-acp` package settings, add a GitHub Actions trusted publisher with these exact values:

| Field | Value |
| --- | --- |
| Organization or user | `julia-script` |
| Repository | `acpclient` |
| Workflow filename | `release.yml` |
| Environment name | `npm-production` |
| Allowed action | Direct publishing with `npm publish` |

The workflow grants `id-token: write` and installs npm `11.5.1`, which supports trusted publishing. Future releases use OIDC and provenance without an npm token secret. See [npm's trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/). If the GitHub repository is renamed later, update the package metadata and npm trusted publisher to match it.

Create the first tag and GitHub release from the same checked `0.1.0` commit after manual publication:

```sh
git tag -a v0.1.0 -m "effect-acp@0.1.0"
git push origin v0.1.0
gh release create v0.1.0 --title "effect-acp v0.1.0" --notes-file CHANGELOG.md
```

Changesets skips versions already published to npm, so rerunning the automated release will not create the first tag or release after a manual npm publish. Subsequent versions are tagged and released by automation.

## Subsequent releases

1. Run `bun run changeset`, select `effect-acp`, choose a bump, and describe the user-visible change.
2. Commit the changeset with the implementation and merge it into `main`.
3. Successful CI triggers `release.yml` for that exact commit. Changesets opens or updates the version PR.
4. Review and merge the version PR. Once that commit passes CI, Changesets publishes the package and creates its release.

Use `bun run check:changesets` to inspect pending releases. `bun run version:packages` applies pending changesets locally and refreshes the Bun lockfile; automation normally runs it in the version PR.

## Package verification

`bun run verify:package` cleans and builds `dist`, packs the npm tarball, checks that every public JavaScript and declaration entry is included, and checks the file allowlist and MIT license. It installs the tarball in a temporary consumer, imports all exports under Node, and typechecks them with both NodeNext and Bundler resolution, without repository aliases or development tooling patches.

CI runs `bun run check`, `bun run check:changesets`, and `bun run verify:package`. The release command verifies the package again before calling `changeset publish` through npm.
