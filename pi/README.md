# pi/

The Pi foundation — vendored from the upstream [pi.dev](https://pi.dev) project
and kept synchronized with the original codebase. Pi provides the agent loop,
multi-provider LLM layer, TUI framework, and CLI runtime. Magenta3 builds **on
top of** this foundation, adding the harness (execution layer) and HCP (assembly
protocol).

## Packages

| Package | Purpose |
|---|---|
| [`ai/`](./ai/) | `@earendil-works/pi-ai` — Unified LLM API with provider collections, auth resolution, token/cost tracking |
| [`agent/`](./agent/) | `@earendil-works/pi-agent-core` — Stateful agent with tool execution and event streaming |
| [`tui/`](./tui/) | `@earendil-works/pi-tui` — Terminal UI framework with differential rendering for flicker-free CLI apps |
| [`coding-agent/`](./coding-agent/) | `@earendil-works/pi-coding-agent` — Full CLI/TUI application, built on `agent` and `tui` |

The `coding-agent` is the entry point — it wires everything together
(`ai` → `agent` → `tui`), loads the harness at runtime, and exposes the final
`bin/magenta` CLI.

## Relationship to upstream

The upstream Pi README is preserved at [`README-upstream.md`](./README-upstream.md)
for reference. The packages here are vendored copies — changes made to
accommodate Magenta's harness architecture are kept minimal and isolated so
synchronization with upstream remains feasible.

Magenta-specific changes:
- `coding-agent` loads and assembles the harness via HCP at startup
- Extensions are loaded from Magenta's extension layer instead of upstream's bundled set
- Some UX features (SSH, background work) now live in the harness or have harness connectors

> [!NOTE]
> Pi packages remain under the `@earendil-works` scope; Magenta's execution
> layer lives under `@magenta` (`@magenta/harness`, `@magenta/memory`).

## Building

From the repo root:

```bash
npm install
npm run build -w @earendil-works/pi-ai \
              -w @earendil-works/pi-agent-core \
              -w @earendil-works/pi-tui \
              -w @earendil-works/pi-coding-agent
```

Or build everything (harness included) with:

```bash
npm run build
```

See each sub-package's README for detailed API docs.
