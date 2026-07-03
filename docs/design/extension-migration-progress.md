# Extension Migration Progress

## Overview

Migration of PI Extensions to HCP-based architecture. This document tracks progress and provides roadmap for remaining work.

**Status as of 2026-07-03**

## Completed Migrations

### ✅ todo (Completed)
**Type:** Tool  
**Status:** Migrated to `harness/tools/todo/`  
**Commits:** 
- `326e2e0` - Initial migration
- `806c203` - Remove old extension

**Details:**
- Rewrote as NativeToolSpec using HCP/Magnet pattern
- 11 comprehensive unit tests (all passing)
- Registered in harness.toml as HCP component
- State stored in tool result details (branch-safe)

**Outcome:** ✅ Clean migration, fully functional

---

### ✅ local-credential-bridge (Deleted - Redundant)
**Type:** System Integration  
**Status:** Removed  
**Commit:** `f583ef6`

**Reason for Deletion:**  
Completely redundant with existing `pi/coding-agent/src/core/external-auth-loader.ts`, which already:
- Reads `~/.codex/config.toml` (base_url + model)
- Reads `~/.codex/auth.json` (OPENAI_API_KEY)
- Reads `~/.claude/settings.json` (ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN)
- Reads environment variables
- Has proper priority ordering (env > claude-code > codex)
- Supports more providers (anthropic, openai, google)

**Outcome:** ✅ Clean deletion, no functionality lost

---

## Remaining Extensions - Analysis

### 🔄 command-aliases (Needs Redesign)
**Current:** `harness/extensions/pi/bundled/command-aliases.ts` (70 lines)  
**Type:** UI Enhancement  

**Functionality:**
- Command aliases (`exit`/`quit` → `/quit`, `clear` → `/new`)
- Autocomplete enhancement (Enter = Tab when autocomplete visible)
- Editor input wrapper

**Complexity:**
- Depends on `EditorComponentWrapper` (~140 lines)
- Hooks into editor input handling
- Composes with other editor wrappers (ui-optimize)

**Migration Path:**
1. **Command aliases** → Move to `interactive-mode.ts` `onSubmit` handler (simple)
2. **Editor enhancement** → Integrate into `pi/tui` Editor component (requires TUI refactor)

**Priority:** P6 (Last - involves editor core)  
**Estimated Effort:** 0.5 day (after TUI refactor)

---

### 🔄 ssh (Needs Architecture Decision)
**Current:** `harness/extensions/pi/bundled/ssh.ts` (509 lines)  
**Type:** Runtime Adapter  

**Functionality:**
- Remote tool execution via SSH
- Path mapping (local ↔ remote)
- Intercepts read/write/edit/bash tools
- Updates system prompt with remote context

**Complexity:**
- Deep runtime integration
- Custom operations for all file tools
- Event hooks: `session_start`, `user_bash`, `before_agent_start`
- UI status updates

**Migration Path:**
Options:
1. **Harness Runtime Adapter** - Create `harness/runtime/ssh/` as alternative runtime
2. **Tool Proxy System** - Generic tool interception/delegation framework
3. **Keep as Extension** - Mark as "advanced optional feature"

**Recommendation:** Option 3 (Keep as Extension)
- This is an optional advanced feature
- Used by very few users
- Already well-implemented
- Not worth the effort to migrate

**Priority:** P7 (Optional - Keep as extension)  
**Estimated Effort:** 1-2 days (if migrating) vs 0 (if keeping)

---

### 🔄 side-chat (Needs UI Framework Decision)
**Current:** `harness/extensions/pi/bundled/side-chat.ts` (509 lines)  
**Type:** UI Feature + Command  

**Functionality:**
- `/side`, `/btw`, `/s` commands
- Temporary no-tools chat in overlay
- Custom UI component (SideChatComponent)
- Tracks main agent tool executions
- Floating window UI with markdown rendering

**Complexity:**
- Custom TUI component (~300 lines)
- Event listeners (tool_execution_start/update/end)
- LLM integration (completeSimple)
- State management
- Depends on shared/floating-window.ts (~150 lines)

**Migration Path:**
1. **Commands** → Register in `interactive-mode.ts` slash command handler
2. **UI Component** → Move to `pi/tui/src/components/`
3. **Tool Tracking** → Integrate into session state
4. **LLM Calls** → Use harness-based completion

**Priority:** P5 (After core tool migrations)  
**Estimated Effort:** 1 day

---

### 🔄 background-events (Large System - Needs Major Refactor)
**Current:** `harness/extensions/pi/bundled/background-events/` (9 files, ~2000 lines)  
**Type:** Background Execution System  

**Functionality:**
- `bg_shell` tool - Long-running shell commands
- `sub_agent` tool - Parallel agent tasks
- Event monitoring and status UI
- `/events` command for management
- Process lifecycle management

**Complexity:**
- Multi-file system:
  - `background-shell.ts` (18K chars)
  - `sub-agents.ts` (30K chars)
  - `event-monitor.ts` (6K chars)
  - `events-overlay.ts` (10K chars)
  - `types.ts`, `index.ts`, `README.md`
- Custom UI overlays
- Process management
- State persistence
- Error handling and recovery

**Migration Path:**
1. **bg_shell tool** → `harness/tools/bg_shell/`
2. **sub_agent tool** → `harness/tools/sub_agent/`
3. **Event system** → Integrate into harness event bus
4. **UI** → Move to pi/tui components
5. **Command** → Register in interactive-mode

**Priority:** P4 (Core functionality, but complex)  
**Estimated Effort:** 2-3 days

---

### 🔄 ui-optimize (Needs UI Layer Decision)
**Current:** `harness/extensions/pi/bundled/ui-optimize/` (8 files, ~1285 lines)  
**Type:** UI Rendering Optimization  

**Functionality:**
- Image token compression (show dimensions instead of full data URL)
- Markdown truncation for long content
- Tool grouping/collapsing
- Path abbreviation
- Runtime imports of heavy dependencies

**Complexity:**
- Multi-file system:
  - `tool-groups.ts` (18K chars) - Tool collapsing logic
  - `images.ts` (12K chars) - Image optimization
  - `markdown.ts` (8K chars) - Markdown truncation
  - `paths.ts` (1.7K chars) - Path utilities
  - `constants.ts`, `runtime-imports.ts`, `index.ts`
- Message transformation pipeline
- Custom editor wrapper
- UI rendering hooks

**Migration Path:**
1. **Image optimization** → Move to `pi/coding-agent/src/core/messages.ts`
2. **Tool grouping** → Integrate into `pi/tui` tool display components
3. **Markdown** → Move to `pi/tui/src/components/markdown.ts`
4. **Editor** → Integrate into pi/tui Editor

**Priority:** P3 (UI polish, not critical)  
**Estimated Effort:** 1-2 days

---

## Summary Statistics

### By Status
- ✅ Completed: 2/7 (29%)
  - todo (migrated)
  - local-credential-bridge (deleted)
- 🔄 Remaining: 5/7 (71%)
  - command-aliases (70 lines)
  - ssh (509 lines)
  - side-chat (509 lines)
  - background-events (~2000 lines)
  - ui-optimize (~1285 lines)

### By Type
- **Tools:** 1 completed (todo), 2 remaining (bg_shell, sub_agent)
- **UI Features:** 0 completed, 3 remaining (side-chat, ui-optimize, command-aliases)
- **Runtime:** 0 completed, 1 remaining (ssh)
- **System:** 1 deleted (local-credential-bridge)

### Total Effort Remaining
- If migrating all: ~5-7 days
- If keeping ssh as extension: ~4-5 days
- Critical path (tools only): ~2-3 days

---

## Recommendations

### Phase 1: Core Tools (Priority)
Focus on migrating actual tools that provide functionality:
1. **background-events** (bg_shell + sub_agent) - 2-3 days
   - These are real tools that users actively use
   - Core to the agent loop
   - Should be in harness/tools/

### Phase 2: UI Polish (Lower Priority)
Migrate UI enhancements when time permits:
2. **side-chat** - 1 day
3. **ui-optimize** - 1-2 days
4. **command-aliases** - 0.5 day

### Phase 3: Optional Features (Keep as Extensions?)
5. **ssh** - Consider keeping as optional extension
   - Advanced use case
   - Already well-implemented
   - Migration cost > benefit

### Alternative: Extension System Coexistence
Instead of forcing migration, consider:
- Keep extension system for optional/experimental features
- Document "stable extensions" vs "deprecated bundled"
- Focus HCP on core tools/components
- Extensions for UI/UX enhancements

---

## Next Steps

1. **Decision Point:** Migrate remaining extensions or keep extension system?
2. **If migrating:** Start with background-events (bg_shell + sub_agent)
3. **If keeping:** Document stable extension patterns and update documentation

---

## Open Questions

1. Should we keep the extension system for UI/UX features?
2. Is it worth migrating ssh given its complexity and niche use case?
3. Should UI optimizations live in TUI or coding-agent?
4. How do we handle editor wrappers in the new architecture?

---

## Related Documents

- [retire-extensions-plan.md](./retire-extensions-plan.md) - Original migration plan
- [hcp-extension-migration.md](./hcp-extension-migration.md) - Migration patterns
- [RETIRE_EXTENSIONS_TODO.md](./RETIRE_EXTENSIONS_TODO.md) - Original analysis
