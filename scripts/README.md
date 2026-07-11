# Repository scripts

`scripts/` contains monorepo-wide build, validation, release, profiling, and
maintenance programs. Prefer the root `package.json` command when one exists;
it records the supported arguments and composes prerequisite steps.

## Supported root commands

| Command | Purpose |
|---|---|
| `npm run build` | Build Pi, Harness, memory, and the coding-agent in dependency order |
| `npm run check` | Format/lint, validate pinned dependencies/imports/shrinkwrap, type-check, and run the browser smoke build |
| `npm run test` | Run every workspace test script |
| `npm run sync-brand -- --dry-run` | Preview brand metadata synchronization |
| `npm run shrinkwrap:coding-agent` | Regenerate the published CLI shrinkwrap |
| `npm run profile:tui` | Profile TUI startup/runtime |
| `npm run profile:rpc` | Profile RPC startup/runtime |
| `npm run publish:dry` | Build, validate, and exercise the npm publication flow without publishing |

Release commands (`release:patch`, `release:minor`, and `release:major`) are
remote release operations, not local preparation helpers. `release.mjs`
requires a clean tree, updates versions and changelogs, creates two commits,
tags the release, then directly pushes local `main` and the tag to `origin`.
Run it only from the intended, up-to-date `main` after confirming the remote
and release version. Use `publish:dry` or `release:local` for non-publishing
validation.

## Script groups

- `check-*.mjs` and `browser-smoke-entry.ts`: repository invariants and browser
  compatibility.
- `generate-coding-agent-shrinkwrap.mjs`: deterministic published dependency
  metadata.
- `build-binaries.sh`, `local-release.mjs`, `publish.mjs`, `release*.mjs`:
  packaging and release operations.
- `profile-coding-agent-node.mjs`, `session-context-stats.mjs`,
  `session-transcripts.ts`, `stats.ts`, `cost.ts`, and `*tool-stats*`:
  profiling and local session analysis.
- `sync-brand.mjs`: build-time brand metadata synchronization.
- `update-source-imports-to-ts.sh` and `repro-5893-wsl-bash.mjs`: targeted
  migration/reproduction helpers, not routine development commands.

Several scripts originated in upstream Pi and still encode upstream release
assumptions. Read the script and inspect its diff before running any mutating
version, publication, brand, or migration command.
