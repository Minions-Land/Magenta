# Sub-Agent Collapsible Output Implementation

## Overview

This document describes the implementation of enhanced sub-agent display in Magenta3's TUI:
1. **Gallery view for multi-agent starts** - Shows multiple sub-agents in a compact activity format
2. **Collapsible output for results** - Shows head+tail by default with Ctrl+O expand/collapse

## Problem

Previously:
- Starting multiple sub-agents showed a plain text table
- Sub-agent results (wait/status) displayed in full, overwhelming the TUI with lengthy output

## Solution

Implemented a custom TUI renderer for the `sub_agent` tool that:

### For Multi-Agent Starts (`action=start` with multiple agents)
- **Reuses existing `renderToolCallActivity`** from tool-call-gallery.ts
- Shows agents in compact activity view with status indicators
- Format: `▸ agent_001  msg-delivery`

### For Single Results (`action=wait` or `action=status`)
- **Collapsed view (default)**: Shows first 5 lines (header) + last 5 lines (summary/findings)
- **Expanded view (Ctrl+O)**: Shows complete output
- **Smart folding**: Only applies when output exceeds 12+ lines
- **Interactive hints**: "(Ctrl+O to expand)" / "(Ctrl+O to collapse)"

## Implementation Details

### Files Modified

1. **`pi/coding-agent/src/core/tools/sub-agent-renderer.ts`** (NEW)
   - Custom renderer implementing `ToolRenderer` interface
   - **Multi-agent start detection**: Parses "Started N sub-agents concurrently" format
   - **Gallery rendering**: Reuses `renderToolCallActivity` from tool-call-gallery.ts
   - **Collapsible output**: Parses `summarizeEvent()` output and renders head+tail view
   - Constants: `COLLAPSED_HEAD_LINES = 5`, `COLLAPSED_TAIL_LINES = 5`

2. **`pi/coding-agent/src/core/tools/register-builtin-renderers.ts`**
   - Added import: `import { subAgentRenderer } from "./sub-agent-renderer.ts"`
   - Registered renderer: `registerRenderer("sub-agent-result", subAgentRenderer)`

3. **`pi/coding-agent/src/core/tools/sub-agent.ts`**
   - Added `renderKind: "sub-agent-result"` to tool definition (line 577)
   - Connects the sub_agent tool to the custom renderer

4. **`pi/coding-agent/test/sub-agent-renderer.test.ts`** (NEW)
   - Unit tests for multi-agent start gallery rendering
   - Unit tests for collapsed/expanded result rendering
   - Tests for short output (no folding needed)
   - Tests for output with no content

### Architecture

The implementation reuses existing components:

```
sub_agent tool execution
  ↓
action=start (multiple) → "Started N sub-agents..." text format
  ↓
subAgentRenderer detects multi-agent start
  ↓
Converts to ToolCallTile[] format
  ↓
Calls renderToolCallActivity (existing gallery component)
  ↓
Displays compact activity view with status indicators

OR

action=wait/status → summarizeEvent() formats output text
  ↓
subAgentRenderer parses sections (header, output)
  ↓
Renders collapsed (head+tail) or expanded (full) view
  ↓
TUI displays with Ctrl+O expand/collapse support
```

### Output Format Parsed

The renderer expects output formatted by `summarizeEvent()`:

```
Sub-agent: agent_001 (label)
Status: exited
Role: general
CWD: /path/to/cwd
Tools: read,grep,find,ls
Model: default
Thinking: medium
Elapsed: 3m39s
Exit code: 0
Signal: n/a
Prompt: /path/to/prompt.md
Log: /path/to/log
Task: investigate the async message delivery...

[Output truncated to last 50000 bytes]  // Optional
Output:
Line 1 of actual output
Line 2 of actual output
...
```

### Rendering Logic

**Collapsed Mode** (default):
- Show all header lines (everything before "Output:")
- Show first 5 lines of output
- Show fold indicator: "... N more lines (Ctrl+O to expand)"
- Show last 5 lines of output

**Expanded Mode** (after Ctrl+O):
- Show all header lines
- Show all output lines
- Show collapse hint: "(Ctrl+O to collapse)" if output is substantial

**Short Output** (≤12 lines):
- Show everything without fold indicators
- No expand/collapse needed

## User Experience

### Multi-Agent Start (action=start with multiple agents)

**Before Implementation**:
```
Started 3 sub-agents concurrently:
agent_001	running	msg-delivery	/Users/mjm/.magenta/agent/tmp/sub-agents/agent_001-2026-07-06T06-28-37-603Z.log
agent_002	running	tree-branch	/Users/mjm/.magenta/agent/tmp/sub-agents/agent_002-2026-07-06T06-28-37-620Z.log
agent_003	running	cross-session	/Users/mjm/.magenta/agent/tmp/sub-agents/agent_003-2026-07-06T06-28-37-624Z.log
Parent progress: /Users/mjm/.magenta/agent/tmp/sub-agents/main-tool-progress.md
```

**After Implementation** (using tool activity gallery):
```
╭─ activity ─────────────────────────────────────────────────────────────╮
│ tools ×3   ✓0  ▸3  ✕0  ·0                                              │
│   ▸ agent_001   msg-delivery                                           │
│   ▸ agent_002   tree-branch                                            │
│   ▸ agent_003   cross-session                                          │
╰──────────────────────────────────────────────── Ctrl+O gallery ────────╯

Parent progress: /Users/mjm/.magenta/agent/tmp/sub-agents/main-tool-progress.md
```

### Single Agent Result (action=wait or action=status)

**Collapsed (default)**:
```
Sub-agent: agent_001 (msg-delivery)
Status: exited
Role: general
CWD: /Users/mjm/Magenta3
Tools: read,grep,find,ls

Output:
Line 1
Line 2
Line 3
Line 4
Line 5

... 85 more lines (Ctrl+O to expand)

## Summary
Investigation complete.

## Findings
- Found async message delivery in agent-session.ts
```

**Expanded (after Ctrl+O)**:
```
[Full output with all 95 lines visible]

(Ctrl+O to collapse)
```

## Testing

Run tests with:
```bash
npm test -- sub-agent-renderer.test.ts
```

Test coverage:
- ✓ Multi-agent start as activity gallery
- ✓ Collapsed output with fold indicator
- ✓ Expanded output without fold indicator  
- ✓ Short output without fold indicators
- ✓ Output with no content

All 5 tests pass.

## Integration with Existing Keybindings

The renderer hooks into the existing `app.tools.expand` keybinding (Ctrl+O by default), which is already used by:
- `BashExecutionComponent` for bash command output
- `ToolExecutionGroupComponent` for tool galleries
- Other tool renderers supporting expand/collapse

This provides a consistent UX across all collapsible content in the TUI.

## Code Reuse Strategy

The implementation maximizes code reuse:

1. **Multi-agent display**: Reuses `renderToolCallActivity` from `tool-call-gallery.ts`
   - No duplicate gallery rendering logic
   - Consistent look & feel with other parallel tool calls
   - Automatic support for status indicators (▸ running, ✓ success, ✕ error)

2. **Keybinding integration**: Uses existing `app.tools.expand` infrastructure
   - No new keybindings needed
   - Consistent with bash/cd command collapse pattern

3. **Theme integration**: Uses existing `theme.fg()` and `keyHint()` utilities
   - Consistent styling across the TUI

## Future Enhancements

Possible improvements:
1. Configurable head/tail line counts via user preferences
2. Smart section detection (auto-expand "## Summary" and "## Findings" even when collapsed)
3. Workflow result formatting with better structure rendering
4. Syntax highlighting for sub-agent output (e.g., markdown sections)
5. Gallery view (Ctrl+O) showing all agents as tiles instead of activity list

## References

- Similar pattern: `pi/coding-agent/src/modes/interactive/components/bash-execution.ts`
- Gallery reuse: `pi/coding-agent/src/modes/interactive/components/tool-call-gallery.ts`
- Tool renderer interface: `pi/coding-agent/src/core/tools/renderer-registry.ts`
- Sub-agent tool: `pi/coding-agent/src/core/tools/sub-agent.ts`
- Keybindings: `pi/coding-agent/src/core/keybindings.ts`
