# Tool Search Tool

The **tool-search** component implements MCP-style
deferral of tool schemas so context stays flat as the tool count grows.

## Role

Tool Search is a normal Tool product under `tools/tool-search`. It consumes
the name and description data exposed through the session `HcpClient`, lets the
model discover tools by keyword on demand, and activates matches so their full
schemas materialize into the active set for subsequent turns. Its aggregation
behavior does not introduce another HCP runtime role.

This generalizes to the broader **Harness Search** idea: the same
"enumerate names now, materialize the expensive thing on demand" pattern MCP
applies to tools, HCP will face for every numerous, runtime-discovered harness
implementation. Tool Search is the first concrete instance.

## How it works (no pi fork)

The harness already separates the full tool `Map` from the `activeTools` subset
the model sees, and `AgentHarness.prepareNextTurn` rebuilds the active set each
turn from `activeToolNames`. So a tool call that invokes `setActiveTools` takes
effect on the next model turn, and only `activeTools` are serialized to the
model. Deferral is therefore purely a function of which tools are active.

- `buildToolSearchManifest(descriptions)` — builds the cheap name+description
  catalog from `HcpServer` descriptions owned by the session `HcpClient`, never
  realizing a schema.
- `createToolSearchTool({ manifest, onActivate, alwaysActive, name?, limit? })` —
  a normal `AgentTool` (`tool_search`) that ranks manifest entries by keyword,
  supports explicit `activate` / `preview`, and activates matches via the
  injected `onActivate` callback (wired to `setActiveTools`, always preserving
  the always-active set).

## Opt-in and behavior-preserving

Nothing defers unless a consumer wires the meta-tool in and seeds a reduced
initial active set. Default sessions are unchanged.

## Search strategy is pluggable (planned)

The keyword ranker is the default implementation. The search strategy
(keyword / BM25 / regex / embedding) is a substitutable concern — Claude's own
tool search ships regex + BM25 + custom variants — so a future
`ToolSearchStrategy` seam lets alternative rankers plug in without changing the
deferral mechanism or the meta-tool behavior.

## Structure

```
tools/tool-search/
  HcpServer.ts
  tool-search.toml
  pi/
    HcpMagnet.ts
    tool-search.ts   — searchable catalog + tool_search factory
  README.md
```

## HCP Declaration

`HarnessComponentProtocol/harness.toml` selects this component declaration for
codegen:

```toml
[[components]]
kind = "tool"
name = "tool-search"
path = "tools/tool-search/tool-search.toml"
```
