# Changesets

Every PR that changes a published package adds one: `pnpm changeset`, pick the
bump (patch / minor / major) and write one line for the changelog.

The TypeScript SDK and CLI always share a version (`fixed` in config.json), and
`pnpm version-packages` copies it into the Python SDK, so all three ship as one
release.
