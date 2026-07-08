# Plan — HCP Unification

## Verified chain (ground truth, read from code)

    LLM
     │  tool.execute()  /  provider.compact()   (HOT PATH — direct, no HCP)
     ▼
    HcpClient            hcp-client/hcp-client.ts
     │  resolveCapability(name) -> resolve("capability:"+name).instance()
     │  resolve("tool:"+name) -> HcpServer
     ▼
    HcpServer            hcp-contract/hcp-server.ts  (describe/call/instance)
     │  registered by registerMagnetHcpServers(hcp, magnets)
     ▼
    HcpMagnet            hcp-contract/hcp-magnet.ts
     │  toTool() | toCapability() | toResource() | toHcpServer()
     │  NativeToolMagnet (native.ts) / CapabilitySourceMagnet (module/<src>/magnet.ts)
     ▼
    harness source       modules/<mod>/<source>/*.ts  (piCompactionProvider, createReadExecute, ...)

Key fact: `assemblePackageToolMagnets()` (overlay/package-overlay.ts) ALREADY
returns { magnets, tools, capabilities: Map, hcp: HcpClient }. pi's resource-loader
calls it but pi only consumes `.tools`. The capabilities + hcp are built and thrown
away. => The assembly layer is complete; the CONSUMER is partial.

## Two runtimes (both call runAgentLoop from pi-agent-core)
- Runtime A: harness/core/loop/pi/agent-harness.ts — uses buildDefaultCapabilityHcp. Only caller besides tests.
- Runtime B: pi/coding-agent AgentSession — the real product. new Agent(...), manual tools, direct compaction import.

## Strategy
Grow pi's ResourceLoader into the single HCP assembler (reuse, don't rebuild).
pi resolves tools + capabilities from that one HcpClient. Keep pi's Agent + TUI.
Do NOT merge loops. HCP setup-only; hot path unchanged.

## Build / test
- Root: `npm run build`, `npm test` (workspaces), `npm run check` (biome+tsgo).
- harness: `cd harness && npm test` (vitest).
- pi: `cd pi/coding-agent && npm test` (vitest --run).

## Phases (each: tests green + behavior parity before next)
- P0 unified assembler + resolution test (no consumer change)
- P1 compaction via HCP
- P2 built-in tools via tool magnets; collapse duplicate impls; keep pi renderers
- P3 context/system-prompt/prompt-templates/skills as HCP resources
- P4 hooks: reconcile ExtensionRunner with hook capability
- P5 policy/sandbox/runtime for command exec (default parity)
- P6 /dock menu = view over single HCP; delete Runtime A + dup tool copies
