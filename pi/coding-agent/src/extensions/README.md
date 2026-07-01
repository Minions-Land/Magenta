# Local Extensions

This directory is auto-discovered by Pi from `~/.pi/agent/extensions`.

## Layout

| Path | Role | UI surface |
| --- | --- | --- |
| `background-events/` | Bundled background execution plugin: long shell events, headless sub-agents, shared monitor. | Agent-facing tools plus one centered `/events` floating window. |
| `shared/` | Shared local helpers for editor wrapping, shell/event formatting, and centered floating windows. | Not auto-loaded; imported by other extensions. |
| `command-aliases.ts` | Maps bare editor input such as `exit`, `quit`, and `clear` to slash commands. | Editor wrapper; composes with other editor extensions. |
| `ui-optimize/` | Markdown polish, compact collapsed tool/thinking groups, image-token paste workflow. | Editor wrapper, renderer patches. |
| `side-chat.ts` | Tool-less explanatory side/btw chat. | `/side`, `/btw`, and `/s` centered floating window. |
| `todo.ts` | Session-branch-aware todo tool. | `/todos` TUI list. |
| `ssh.ts` | Optional SSH-backed read/write/edit/bash tools via `--ssh`. | Footer SSH status when enabled. |

## Background events plugin

`background-events/` keeps user-facing controls separate from agent-facing execution:

- `background-shell.ts` registers `bg_shell_start`, `bg_shell_status`, `bg_shell_wait`, and `bg_shell_cancel` for the main agent.
- `sub-agents.ts` registers `sub_agent` for parallel headless Pi workers.
- `event-monitor.ts` aggregates both sources into one footer status and one focused centered floating window.
- `index.ts` wires the plugin together.

The user should normally ask for outcomes; the main agent decides when to start/wait/cancel background work. User-visible commands are for observation:

```text
/events         open/toggle all background work
/events shell   open shell events
/events agent   open sub-agent events
/events failed  open failed/timed-out events
/events close   close the events overlay
/events clear   acknowledge failed/timed-out footer warnings

Inside the overlay: `Esc`/`q` closes it, `↑↓`/`j/k` scroll, `a/s/n/r/e/f` switches filters.
```

## UI conventions

- Session-scoped background work should register with `createEventsMonitor()` from `background-events/event-monitor.ts` instead of hand-rolling footer/widget logic.
- Persistent state goes into footer statuses via stable keys, e.g. `background-events`, `ssh`.
- Temporary detail views should use focused centered overlays (`ctx.ui.custom(..., { overlay: true, overlayOptions: { anchor: "center" } })`) when they should own input and close with `Esc`.
- Editor customizations should wrap `ctx.ui.getEditorComponent()` instead of replacing it, preferably through `shared/editor-wrapper.ts`, so aliases, image paste, and future editor features can compose.
- Long-running local processes are session-scoped and are cancelled on `session_shutdown`.

After editing extensions, run `/reload`. If prototype patches in `ui-optimize/` look stale, restart Pi for a clean process.
