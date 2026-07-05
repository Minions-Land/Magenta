# scripts/

Repo-level maintenance, release, CI-check, and analysis scripts. These operate
across the whole monorepo (workspaces + harness), as opposed to per-package
scripts that live inside each package.

Most are wired into root `package.json` scripts; run them via `npm run <name>`
where one exists, or invoke directly with `node scripts/<file>`.

## Release & versioning

| Script | Purpose |
|---|---|
| `release.mjs` | Full release flow (`npm run release:{patch,minor,major}`) |
| `local-release.mjs` | Local dry-run style release (`npm run release:local`) |
| `release-notes.mjs` | Generate / fix GitHub release notes |
| `publish.mjs` | Publish packages to npm (`npm run publish[:dry]`) |
| `sync-versions.js` | Sync workspace versions after `npm version` bump |
| `sync-brand.mjs` | Propagate brand registry values across packages |
| `generate-coding-agent-shrinkwrap.mjs` | Generate/verify the coding-agent npm-shrinkwrap |
| `build-binaries.sh` | Build standalone coding-agent binaries |

## CI / consistency checks

| Script | Purpose |
|---|---|
| `check-pinned-deps.mjs` | Enforce exact versions on direct external deps |
| `check-ts-relative-imports.mjs` | Forbid relative `.js` imports in `.ts` sources |
| `check-lockfile-commit.mjs` | Guard against accidental `package-lock.json` commits |
| `check-browser-smoke.mjs` | Run the browser smoke test and report failures |
| `browser-smoke-entry.ts` | Entry point loaded by the browser smoke check |

## Profiling & analysis

| Script | Purpose |
|---|---|
| `profile-coding-agent-node.mjs` | Profile the CLI in `--mode tui` or `--mode rpc` |
| `session-context-stats.mjs` | Context-window usage stats across sessions |
| `session-transcripts.ts` | Export / analyze session transcripts |
| `stats.ts` | Aggregate token/usage totals from session logs |
| `cost.ts` | Estimate spend over a session directory / window |
| `tool-stats.ts`, `read-tool-stats.mjs`, `edit-tool-stats.mjs` | Per-tool usage reports (HTML/CLI) |

## Migration & repro helpers

| Script | Purpose |
|---|---|
| `update-source-imports-to-ts.sh` | One-off: rewrite source imports to `.ts` extensions |
| `repro-5893-wsl-bash.mjs` | Regression repro for issue #5893 (WSL bash) |

> [!TIP]
> Scripts that print a `Usage:` banner accept `--help`-style flags; run them with
> no args to see options.
