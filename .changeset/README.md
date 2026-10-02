# Changesets

Run `bun run changeset` for a publishable change and select `effect-acp` with the appropriate version bump. Commit the generated Markdown file alongside the change.

Successful CI on `main` triggers the release workflow. Pending changesets open or update a version PR; merging that PR publishes the checked version to npm and creates a GitHub release.

See [the publishing guide](../docs/publishing.md) for initial setup and the first release.
