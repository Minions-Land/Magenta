# Repository scripts

`scripts/` contains monorepo-wide build, validation, release, profiling, and
maintenance programs. Prefer the root `package.json` command when one exists;
it records the supported arguments and composes prerequisite steps.

## Supported root commands

| Command | Purpose |
|---|---|
| `npm run build` | Refresh online model catalogs, then build Pi, Harness, memory, and the coding-agent in dependency order |
| `npm run build:offline` | Build the same workspaces from the tracked model catalogs without network-driven source generation |
| `npm run check:docs` | Test the documentation checker, then validate maintained Markdown links, anchors, fences, commands, and drift rules |
| `npm run check` | Run the documentation gate, format/lint, validate pinned dependencies/imports/shrinkwrap, type-check, and run the browser smoke build |
| `npm run check:release` | Run the same release gate without writing formatter changes |
| `npm run test` | Run repository script tests, then every workspace test script |
| `npm run sync-brand -- --dry-run` | Preview brand metadata synchronization |
| `npm run shrinkwrap:coding-agent` | Regenerate the published CLI shrinkwrap |
| `npm run profile:tui` | Profile TUI startup/runtime |
| `npm run profile:rpc` | Profile RPC startup/runtime |
| `npm run public:snapshot -- --policy <reviewed.json>` | Audit an allowlisted current-tree snapshot for a new history-free public repository; add explicit `--write --output <new-path>` only after review |
| `npm run publish:dry` | Build, validate, and exercise the npm publication flow without publishing |

Release commands (`release:patch`, `release:minor`, and `release:major`) are
remote release operations, not local preparation helpers. `release.mjs`
requires a clean `main` synchronized with an explicitly refreshed
`origin/main`, validates the official push remote, rejects an unconfigured
source-owned Apple Team ID before changing version files, and bumps only the active
brand's CLI product version while finalizing the coding-agent changelog. It then
cleans all workspace output, builds offline, verifies the compiled version,
runs `check:release` and the full test suite, creates two commits and an
annotated tag, then uses a lease-protected `main` push followed by a fully
qualified tag push. It does not change independent Pi workspace versions or
refresh online model catalogs. Run it only after confirming the remote and
release version. Use `publish:dry` or `release:local` for non-publishing
validation. `release:local` uses the same clean-build-verify-check-test order
before packing artifacts; its `--skip-check` and `--skip-test` flags never skip
the clean offline build or compiled-version verification. On macOS, it ad-hoc
re-signs the completed local executable and strictly verifies that signature
before archive creation; this does not satisfy public Developer ID or
notarization requirements.

If a pushed source tag fails for a source defect before becoming the latest
public CLI release, keep that tag immutable and use
`node scripts/release.mjs --abandon-unpublished=<failed-version> <target>`.
The explicit version must match the active brand, and the command verifies the
older public baseline, rejects an already-published exact Release, and checks
the remote annotated tag's ancestry and embedded brand version before preparing
the next release.

The coding-agent clean step removes both `dist/` and abandoned direct-child
`*.bun-build` scratch executables. Every supported Bun compile also runs the
same bounded scratch cleanup in a `finally` path, so successful and failed
cross-compiles do not leave large temporary executables in the package root.
Cleanup refuses a scratch-shaped directory or other unexpected file type
instead of recursively deleting an ambiguous path.

Repository launchers execute ignored compiled output. `git status` can therefore
be clean while `pi/coding-agent/dist/` is stale. After building, run
`node scripts/verify-brand-version.mjs --require-dist`; binary and release scripts
use the same check automatically.

## Script groups

- `check-*.mjs` and `browser-smoke-entry.ts`: repository invariants and browser
  compatibility.
- `generate-coding-agent-shrinkwrap.mjs`: deterministic published dependency
  metadata.
- `build-binaries.sh`, `local-release.mjs`, `publish.mjs`, `release*.mjs`:
  packaging and release operations.
- `export-public-snapshot.mjs`: fail-closed current-tree exporter for a new
  one-root-commit repository; it never rewrites history, creates a remote, or
  pushes refs.
- `install.sh`, `macos-release-*.mjs`, `macos-signing-credentials.mjs`,
  `github-release-publish.mjs`, and `smoke-unix-release.sh`: the source-owned
  Unix installer, macOS signing/notarization contract, exact draft publication,
  and native release smoke harness.
- `profile-coding-agent-node.mjs`, `session-context-stats.mjs`,
  `session-transcripts.ts`, `stats.ts`, `cost.ts`, and `*tool-stats*`:
  profiling and local session analysis.
- `sync-brand.mjs`: build-time brand metadata synchronization.
- `update-source-imports-to-ts.sh` and `repro-5893-wsl-bash.mjs`: targeted
  migration/reproduction helpers, not routine development commands.

Several scripts originated in upstream Pi and still encode upstream release
assumptions. Read the script and inspect its diff before running any mutating
version, publication, brand, or migration command.
