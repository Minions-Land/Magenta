# Development

Magenta is an npm workspace. Use Node.js 22.19 or newer and run commands from the repository root unless a section says otherwise.

## Setup

```bash
git clone https://github.com/Minions-Land/Magenta.git
cd Magenta
npm install
npm run build
```

Start the source build through the repository launcher:

```bash
./bin/magenta
```

The launcher executes `pi/coding-agent/dist/cli.js`, so rebuild the affected workspace before exercising source changes.

## Workspace Map

| Workspace | Package | Focus |
|---|---|---|
| `pi/ai` | `@earendil-works/pi-ai` | providers, models, messages, streaming |
| `pi/agent` | `@earendil-works/pi-agent-core` | agent loop and tool execution |
| `pi/tui` | `@earendil-works/pi-tui` | terminal rendering and editor primitives |
| `HarnessComponentProtocol` | `@magenta/harness` | HCP assembly, tools, skills, capabilities |
| `HarnessComponentProtocol/memory` | `@magenta/memory` | memory service |
| `pi/coding-agent` | `@earendil-works/pi-coding-agent` | CLI, sessions, modes, extensions, product integration |

Respect public package exports. A workspace must not deep-import another workspace's `src/`, `magenta/`, `pi/`, `_magenta/`, or `.HCP/` implementation.

## Change Workflow

1. Read the nearest code, tests, and ownership documentation before changing a contract.
2. Keep the change within the owning workspace; regenerate derived files through their script.
3. Add focused tests for the changed behavior and lifecycle boundaries.
4. Run the focused build and tests while iterating.
5. Run the repository gates before committing.

When Magenta's research-orchestration skill is active, the session Todo is the only plan, progress, completion, and evaluation ledger. Do not create `plan.md`, `progress.md`, `contract.md`, `reflection.md`, or a parallel checklist merely to mirror session state. Files remain appropriate when they are actual deliverables, experiment data, or evidence requested by the task.

## Validation

Focused examples:

```bash
npm run build -w @earendil-works/pi-tui
npm test -w @earendil-works/pi-tui

npm run build -w @earendil-works/pi-coding-agent
npm test -w @earendil-works/pi-coding-agent

npm run build -w @magenta/harness
npm test -w @magenta/harness
```

Repository gates:

```bash
npm run check:docs
npm run build
npm run check
npm test
git diff --check
```

`npm run check` runs the formatter with writes enabled before lint, dependency/import/shrinkwrap checks, type checking, and the browser smoke build. Review its resulting diff rather than assuming it is read-only.

## HCP Changes

HCP has one ownership chain:

```text
HcpClient -> real Module HcpServer -> selected Source HcpMagnet -> Tool | Capability | Resource
```

Before adding or moving a Harness component, read the four authorities:

- [Naming law](../HarnessComponentProtocol/docs/governance/hcp-naming.md)
- [Architecture](../HarnessComponentProtocol/docs/governance/hcp-architecture.md)
- [Change contract](../HarnessComponentProtocol/docs/governance/contract.md)
- [Implementation workflow](../HarnessComponentProtocol/docs/DEVELOPING.md)

Run the structural gates after changing component TOML, role files, generated source inputs, assumptions, or RenderKind declarations:

```bash
npm run generate:hcp-sources -w @magenta/harness
npm run check:hcp-sources -w @magenta/harness
npm run check:structure -w @magenta/harness
npm run check:assumptions -w @magenta/harness
```

`HarnessComponentProtocol/.HCP/assembly/sources.generated.ts` is generated from repository declarations and must never be edited by hand. Dynamic schema-v2 Package roles are loaded at runtime and therefore do not belong in that projection.

## TUI And Interaction Changes

Terminal features require lifecycle tests in addition to render assertions. Cover initialization, repeated input, deletion or undo where relevant, queued submissions, mode/profile transitions, suspension, shutdown, and terminal-width stability. Avoid timers that keep Node alive; stop them when their owning mode is inactive and call `unref()` when available.

For editor attachments, keep the visible marker and binary payload in one controller-owned lifecycle. The message boundary is `ImageContent[]`; filesystem paths are text unless an explicit file processor converts them.

## Documentation Changes

Each topic has one authority. Update links instead of copying a contract into a new report. Maintained product docs are indexed in [docs/README.md](./README.md); HCP laws remain under `HarnessComponentProtocol/docs/`. Do not add release-version claims, binary sizes, or static model inventories to durable docs.

Run `npm run check:docs` after moving a heading or Markdown file. The gate validates local links and anchors, Mermaid fences, deleted-document references, placeholder repository URLs, legacy release asset names, and selected drift-prone claims.

## Brand Changes

Build-time brand data lives under `brands/`. Preview synchronization before writing:

```bash
npm run sync-brand -- --dry-run
npm run sync-brand
```

Synchronization changes manifests and generated product metadata. Inspect the diff, reinstall if lock metadata changed, then run build, check, and tests. See [Brand configuration](../brands/README.md).

## Release

Do not publish by manually uploading local artifacts. The supported binary release is driven by a source-repository version tag and `.github/workflows/release.yml`. Read the [release guide](./UPDATE_SETUP_GUIDE.md) before running any `release:*` command; those scripts can commit, tag, and push.
