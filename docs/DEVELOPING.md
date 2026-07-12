# Developing Magenta3

This is the repository-level contribution guide. For adding a Harness Module,
Source, Tool, Capability product, Resource, or domain Package descriptor, use
[`../HarnessComponentProtocol/docs/DEVELOPING.md`](../HarnessComponentProtocol/docs/DEVELOPING.md).

## Prerequisites

- Node.js `22.19.0` or newer
- npm
- Git
- Provider credentials only when running live-model or TUI end-to-end tests
- Optional: Bun for standalone binary builds

Install and build from the repository root:

```bash
npm install
npm run build
./bin/magenta --help
```

## Choose The Owning Layer

Place a change in the narrowest layer that owns the behavior:

| Change | Owner |
|---|---|
| Provider request/response or model metadata | `pi/ai` |
| Provider-independent agent loop behavior | `pi/agent` |
| Reusable terminal rendering/input | `pi/tui` |
| Harness Module, Source, or HCP assembly | `HarnessComponentProtocol` |
| CLI flags, sessions, auth, resource loading, SSH, TUI workflow | `pi/coding-agent` |
| Build-time product identity | `brands` and `scripts/sync-brand.mjs` |
| Root integration/e2e coverage | `tests/e2e` |

Do not push product composition down into `pi/agent`, and do not deep-import a
Harness Source implementation from `pi/coding-agent`. Consumers should use the
`@magenta/harness` package barrel.

## HCP Rules Before Editing

The authoritative documents are:

- [`../HarnessComponentProtocol/docs/governance/hcp-architecture.md`](../HarnessComponentProtocol/docs/governance/hcp-architecture.md)
- [`../HarnessComponentProtocol/docs/governance/hcp-naming.md`](../HarnessComponentProtocol/docs/governance/hcp-naming.md)

The review-level summary is:

```text
HcpClient -> real Module HcpServer -> declared Source HcpMagnet -> product
```

- No fourth HCP role.
- No role interfaces or `contract/` layer.
- No anonymous, facade, or per-Magnet Servers.
- No separate built-in, capability, Package, or MCP assembly path.
- No hand-maintained registry beside generated `HCP_SERVERS` and
  `HCP_MAGNETS`.
- Every HCP-related symbol follows the entity-tree naming law and uses the
  `Hcp` prefix.

When declarations change, regenerate instead of editing generated TypeScript:

```bash
npm run generate:hcp-sources -w @magenta/harness
npm run check:hcp-sources -w @magenta/harness
npm run check:structure -w @magenta/harness
```

## Development Loop

1. Read the owning package and adjacent tests before editing.
2. Make the smallest coherent architectural change, including necessary
   cleanup rather than preserving obsolete parallel paths.
3. Add or update focused tests at the owning layer.
4. Build and test the affected workspace.
5. Run repository checks and broader tests when the blast radius crosses
   workspace boundaries.
6. For user-visible changes, run the built CLI or TUI as a real process.
7. Review generated files and formatter changes before committing.

## Commands

### Build

```bash
# Required workspaces in dependency order
npm run build

# Focused builds
npm run build -w @earendil-works/pi-ai
npm run build -w @earendil-works/pi-agent-core
npm run build -w @earendil-works/pi-tui
npm run build -w @magenta/harness
npm run build -w @magenta/memory
npm run build -w @earendil-works/pi-coding-agent
```

### Tests

```bash
# All workspace test scripts
npm test

# Focused suites
npm test -w @magenta/harness
npm test -w @magenta/memory
npm test -w @earendil-works/pi-ai
npm test -w @earendil-works/pi-agent-core
npm test -w @earendil-works/pi-tui
npm test -w @earendil-works/pi-coding-agent
```

`./test.sh` runs `npm test` with an isolated temporary `HOME` and provider
credential variables unset. Use it when explicitly validating that unit tests
do not depend on Magenta, Claude Code, Codex, or other local secrets.

### Static Checks

```bash
npm run check
npm run check:pinned-deps
npm run check:ts-imports
npm run check:shrinkwrap
npm run check:browser-smoke
```

`npm run check` runs `biome check --write --error-on-warnings .` before the
other gates. It may modify files; always inspect `git diff` afterward.

Harness-specific checks:

```bash
npm run lint -w @magenta/harness
npm run check:structure -w @magenta/harness
npm run check:assumptions -w @magenta/harness
npm run check:hcp-sources -w @magenta/harness
npm run inspect -w @magenta/harness
```

### Real Product Verification

After building, verify the same launcher users run:

```bash
./bin/magenta --version
./bin/magenta --help
./bin/magenta --list-models
./bin/magenta --harness-list
./bin/magenta --print --no-session "Reply with OK"
./bin/magenta
```

The last two commands call a live provider. In the TUI, inspect relevant slash
commands, model selection, reasoning levels, tool execution, interrupt behavior,
and session resume when those surfaces changed.

Root Playwright tests drive the built application through a real process or
PTY:

```bash
npm run build
npx playwright test --project lazypi-tests
npx playwright test --project cli-conversation
npx playwright test --project tui-tests
```

The conversation and TUI projects need configured credentials. Keep assertions
deterministic and avoid destructive operations outside their fixtures.

### Standalone Binaries

```bash
npm run build:binary -w @earendil-works/pi-coding-agent
./scripts/build-binaries.sh --platform darwin-arm64
```

Cross-platform binary creation uses Bun and platform-specific native assets.
It is not part of the normal source development loop.

## Model Metadata Changes

Generated model catalogs belong to `pi/ai`. Update the generator or its source
metadata, then regenerate; do not patch only a generated provider file. Test
both capability exposure and the final provider payload. For reasoning levels,
also verify CLI parsing, custom model schema, model selection, clamping, TUI
display, and request serialization.

Unknown future reasoning values should be handled deliberately. A provider's
product mode such as delegated "ultra" is not automatically equivalent to an
API reasoning effort.

## Package Changes

Keep the two package mechanisms distinct:

- Pi extension resources are managed by `magenta install/remove/list/config`.
- Harness domain Packages are externally managed component bundles.

Magenta3 accepts local domain Package roots and versioned
`github:owner/repo/Package@version` selectors. GitHub download, platform
selection, SHA-256 verification, safe extraction, and caching are host
acquisition concerns that feed the existing local-root boundary. Without a
local-root override, local selectors check only `<current-workspace>/packages`.
Do not add concrete package contents, a submodule, or a hardcoded sibling path
to this repository.

## Documentation Changes

- Root `README.md` is the user-facing entry point.
- `docs/ARCHITECTURE.md` owns repository-level boundaries.
- HCP architecture and naming stay authoritative under
  `HarnessComponentProtocol/docs/governance/`.
- Document implemented behavior as current; label future work explicitly.
- Verify paths, script names, flags, and environment variables in source.
- Keep [`README.md`](./README.md) updated when documents are added or moved.

## Commit Checklist

Before committing a cross-cutting change:

```bash
git status --short
git diff --check
npm run build
npm run check
npm test
```

Then run applicable HCP gates and end-to-end tests. A commit message should
state the externally visible result and the architectural boundary it preserves
or changes. Do not commit unrelated formatter churn, generated artifacts that
are not source-controlled, credentials, sessions, caches, or concrete domain
Package contents.
