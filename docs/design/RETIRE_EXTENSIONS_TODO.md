# Extension Migration Status

**Last Updated:** 2026-07-03  
**Status:** Complete: 7/7 handled (7 migrated/retired)

## Completed

### 1. todo -> `harness/tools/todo/`
**Status:** Done  
**Outcome:** Migrated to HCP tool with branch-aware state and unit coverage.

### 2. local-credential-bridge -> Deleted
**Status:** Done  
**Outcome:** Removed as redundant with `pi/coding-agent/src/core/external-auth-loader.ts`.

### 3. command-aliases -> Pi core
**Status:** Done  
**Outcome:** Bare `exit`/`quit`/`clear` aliases now live in `pi/coding-agent/src/core/command-aliases.ts` and interactive editor handling.

### 4. ui-optimize -> Pi core/TUI
**Status:** Done  
**Outcome:** Image token compression, Markdown polish, and tool activity grouping moved into `pi/coding-agent` and `pi/tui`.

### 5. background-events -> Pi core/TUI
**Status:** Done  
**Outcome:** `bg_shell`, `sub_agent`, `/events`, background status, and event overlay moved into Pi session/core/TUI.

### 6. side-chat -> Pi core/TUI
**Status:** Done  
**Outcome:** `/side`, `/btw`, `/s`, the side-chat overlay, and tool-progress context moved into Pi core/TUI.

### 7. ssh -> `harness/tools/ssh/`
**Status:** Done  
**Outcome:** SSH remote workspace operations moved to `harness/tools/ssh/`; Pi keeps the `--ssh user@host[:path]` user experience.

## Final Architecture

- Harness owns reusable execution/protocol capabilities such as HCP tools.
- Pi owns TUI, session, Agent-loop, and user-experience features.
- Bundled extension registry has been removed.

## Verification

- `pi/coding-agent` build passes.
- `pi/coding-agent` full test suite passes.
- `pi/tui` build and full test suite pass.
- `harness` build and full test suite pass.
- Focused migration coverage includes image tokens, Markdown, `bg_shell`, `sub_agent`, Side Chat LLM dispatch, command links, resource loading, and tool filtering.
