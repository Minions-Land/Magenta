# Phase 2 Implementation Plan — Built-in Tools via HCP

## Findings from agent_002 analysis

### Current state
- Pi has 8 tools: read, bash, edit, write, grep, find, ls, show
- Pi wrappers are NOT duplicates — they import harness execute logic + add render/options
- `agent-session.ts` line 2715 calls `createAllToolDefinitions(cwd, options)` which builds local tool instances
- Harness already has NativeToolMagnets for 7 tools in `session-hcp.ts` (bash conditional on includeBuiltInTools)

### Address scheme inconsistency (Phase 1 finding)
- Built-in tools register as `tool:name` (via NativeToolMagnet, line 74 in native.ts)
- Package tools register as `tool://name` (via process/package-tool magnets)
- Need consistent scheme for all tools to coexist in one HCP

### Implementation strategy

#### Step 1: Expose session HCP to AgentSession
```typescript
// agent-session.ts constructor
private _sessionHcp?: HcpClient;
constructor(config: AgentSessionConfig) {
  ...
  this._sessionHcp = this._resourceLoader.getSessionHcp?.();
}
```

#### Step 2: Resolve built-in tools from HCP
```typescript
// In _initializeTools() around line 2708:
const baseToolsFromHcp: Record<string, AgentTool> = {};
if (this._sessionHcp && !this._baseToolsOverride) {
  const builtInNames = ["read", "bash", "edit", "write", "grep", "find", "ls"];
  for (const name of builtInNames) {
    const server = this._sessionHcp.resolve(`tool:${name}`);
    const tool = server?.instance?.() as AgentTool | undefined;
    if (tool) baseToolsFromHcp[name] = tool;
  }
}

const baseToolDefinitions: Record<string, ToolDefinition> = this._baseToolsOverride
  ? { ... } // existing override path
  : (Object.keys(baseToolsFromHcp).length > 0
      ? baseToolsFromHcp  // HCP path
      : createAllToolDefinitions(cwd, options)); // fallback for no-HCP loaders
```

#### Step 3: Keep pi tool wrappers for options/render
Pi's tool files stay — they provide:
- SSH operations injection (read/bash/edit/write via `createSshToolOperations`)
- Shell path/command prefix (bash)
- Auto-resize (read)
- TUI renderers (all tools)

These are pi-specific transport concerns, not duplicate execute logic.

#### Step 4: Update session-hcp.ts built-in tool assembly
Ensure all 8 tools (incl. show) are in the NativeToolMagnet list, with proper options passthrough.

#### Step 5: Address scheme decision
**Recommendation**: Keep `tool:name` for all tools (built-in + package). Update package-tool magnets to register `tool:name` instead of `tool://name` for consistency.

## Files to modify
1. `pi/coding-agent/src/core/agent-session.ts` — add HCP resolution in `_initializeTools()`
2. `harness/hcp-client/assembly/session-hcp.ts` — verify all 8 tools assembled
3. `harness/hcp-magnet/package-tool.ts` — change address from `tool://${name}` to `tool:${name}`
4. `harness/hcp-magnet/process.ts` — same address fix
5. Tests — verify tool resolution + parity

## Verification
- Pi test suite (tools still work)
- Harness test suite (353/353 green)
- Manual: `/tools` command shows all 8 from HCP
- Parity: read/bash/edit output identical pre/post
