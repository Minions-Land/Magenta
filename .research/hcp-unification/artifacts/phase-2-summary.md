# Phase 2 Implementation Summary — Built-in Tools via HCP

## Status: ✅ COMPLETE

## What changed

Phase 2 routes pi's 7 built-in tools (read, bash, edit, write, grep, find, ls) through the session HCP instead of local `createAllToolDefinitions` construction, satisfying INV-1 (all non-LLM content via one HcpClient).

### Harness changes

1. **`harness/hcp-magnet/native.ts`** — Added `renderKind?: string` to `NativeToolSpec` interface and flow through to the produced `AgentTool`. This preserves pi's client-side render dispatch by kind.

2. **`harness/hcp-client/assembly/session-hcp.ts`**:
   - Added `renderKind` to all 7 tool magnet specs (bash: "shell-output", read: "file-content", edit: "text-edit", write: "file-write", grep: "pattern-search", find: "file-search", ls: "directory-list").
   - Exported `buildBuiltInToolMagnets` (was private) so pi can build magnets with per-runtime options at `_buildRuntime` time.
   - Made `BuiltInToolOptions.descriptions` values `string | undefined` to accept pi's optional canonical strings.

### Pi changes

3. **`pi/coding-agent/src/core/agent-session.ts`**:
   - Import `buildBuiltInToolMagnets`, `registerMagnetHcpServers` from harness.
   - In `_buildRuntime`, when `sessionHcp` exists, call new `_resolveBuiltInToolsFromHcp` instead of `createAllToolDefinitions`.
   - Added `_resolveBuiltInToolsFromHcp` private method:
     - Builds tool magnets with current runtime options (SSH ops, shell path, auto-resize, command prefix).
     - Sources canonical descriptions from pi's own tool factories (`createAllToolDefinitions`) to preserve byte-identity (INV-5.2).
     - Registers magnets into session HCP with `duplicates: "replace"` (since `_buildRuntime` can run multiple times).
     - Resolves tools back via `hcp.resolve("tool:<name>").instance()` and wraps as ToolDefinitions.
   - Fallback: if no session HCP (custom loaders), use original `createAllToolDefinitions` path.

## Design decisions

### Options injection lifecycle
Pi injects tool options (SSH ops, shell path, auto-resize) at `_buildRuntime` time, but resource-loader builds the session HCP at `reload()` time. Resolution: pi builds its own tool magnets with current options at `_buildRuntime` and registers them into the session HCP. This satisfies INV-1 (consumption via HCP) while preserving pi's per-runtime lifecycle.

### Description parity (INV-5.2)
Pi's read/edit/write/find/ls descriptions differ from harness fallbacks. To guarantee byte-identity, pi sources descriptions from its own `createAllToolDefinitions` factories and passes them through `BuiltInToolOptions.descriptions`. Bash/grep already use shared harness constants (`BASH_TOOL_DESCRIPTION`, `GREP_DESCRIPTION`).

### Render layer preservation
`renderKind` flows from `NativeToolSpec` → `AgentTool` so pi's renderer-registry matches by kind, not tool name. HCP-resolved tools render identically to locally-constructed ones.

### Address scheme (tool: vs tool://)
Built-in tools use `tool:name` (NativeToolMagnet). Package tools use `tool://name` (process/package-tool magnets). Phase 2 keeps this split; unifying the scheme is a P6 cleanup concern.

## Verification

- harness `npx tsc -p tsconfig.build.json --noEmit`: exit 0
- harness `npx vitest --run`: 353/353 pass (43 files)
- pi `npx tsc --noEmit`: exit 0 (2 pre-existing unrelated errors in bg-shell.test, tui/src/utils confirmed on baseline)
- pi `npx vitest --run test/resource-loader.test.ts`: 36/36 pass

## Parity guarantee (INV-5.1, INV-5.2)

Tool schemas (name, parameters, description) are identical whether resolved from HCP or locally constructed:
- Schema: `NativeToolMagnet.toTool()` uses the same `createExecute` factories as pi's local tools.
- Descriptions: pi passes its canonical strings through `descriptions` option; harness bash/grep use shared constants.
- renderKind: preserved end-to-end via `NativeToolSpec`.

When `sessionHcp` is unavailable (custom loaders, tests with `includeBundledResources: false`), fallback to `createAllToolDefinitions` keeps current behavior.

## Remaining work for full tool unification

Phase 2 satisfied INV-1 for built-in tools. Remaining:
- **show tool**: pi-local; not in harness magnets (add in P6 cleanup or keep pi-local as TUI-specific).
- **bg_shell, sub_agent, send_message**: pi-local controllers; remain outside HCP (they're session-scoped stateful controllers, not pure tools).
- **Package tools**: already flow through HCP (assembled by `assemblePackageToolMagnets`), unchanged by Phase 2.
- **Trunk tools** (WebSearch, WebFetch): already assembled by harness `buildTrunkTools`, unchanged by Phase 2.
- **Extension tools**: remain extension-sourced; outside HCP by design (extensions register via ExtensionRunner, not HCP).

## Files modified

- `harness/hcp-magnet/native.ts` (+renderKind field)
- `harness/hcp-client/assembly/session-hcp.ts` (export buildBuiltInToolMagnets, add renderKind to magnets, widen descriptions type)
- `pi/coding-agent/src/core/agent-session.ts` (import HCP helpers, add _resolveBuiltInToolsFromHcp, route _buildRuntime through HCP when available)

## Next phase

Phase 3: resources (context/system-prompt/prompt-templates/skills). Agent_003 recommends option (b): keep system-prompt as RESOURCE (file-loaded via overlay), context already a capability (ready to resolve), skills/prompt-templates stay as resources. Phase 3 is mostly a decision + documentation + parity test, not a code migration (preserving byte-identity per INV-5.2).
