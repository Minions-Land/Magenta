# Pi foundation

`pi/` contains the model, agent-loop, terminal UI, and coding-agent workspaces
on which Magenta3 is built. The code originated from Pi and is maintained here
with Magenta-specific integration, so current source and tests in this
repository are authoritative.

| Workspace | Package | Responsibility |
|---|---|---|
| [`ai/`](./ai/) | `@earendil-works/pi-ai` | Provider APIs, model catalogs, authentication contracts, streaming, and usage accounting |
| [`agent/`](./agent/) | `@earendil-works/pi-agent-core` | Stateful agent loop, messages, tools, events, and transport-neutral execution |
| [`tui/`](./tui/) | `@earendil-works/pi-tui` | Differential terminal rendering and reusable TUI components |
| [`coding-agent/`](./coding-agent/) | `@earendil-works/pi-coding-agent` | Magenta CLI/TUI, sessions, resource loading, and application assembly |

The coding-agent workspace publishes the `magenta` executable. It supplies
host/session inputs to `@magenta/harness`; generic HCP assembly remains under
`HarnessComponentProtocol/.HCP`, while Magenta-specific adapters remain under
`HarnessComponentProtocol/_magenta`.

The retained [`README-upstream.md`](./README-upstream.md) is a historical
upstream reference. Its paths, binary names, and development workflow are not
the Magenta3 contract.

## Build and test

From the repository root:

```bash
npm install
npm run build
npm run check
npm test
node pi/coding-agent/dist/cli.js
```

For a focused workspace:

```bash
npm run build -w @earendil-works/pi-ai
npm run test -w @earendil-works/pi-ai
```

Use each workspace README for its public API and development details. Use the
root [`README.md`](../README.md) and [`docs/`](../docs/) for the integrated
Magenta3 architecture and operator workflow.
