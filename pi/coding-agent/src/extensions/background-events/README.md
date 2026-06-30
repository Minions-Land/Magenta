# Background Events

A Pi extension for agent-facing background execution and a small keyboard-first `/events` monitor.

## Responsibilities

- `background-shell.ts`: `bg_shell` for long-running non-interactive shell commands.
- `sub-agents.ts`: `sub_agent` for headless read-mostly Pi workers.
- `job-monitor.ts`: source aggregation, footer status, and `/events` command routing.
- `events-overlay.ts`: focused centered floating background job list UI.
- `types.ts`: shared monitor/source types.
- `index.ts`: extension entry point.

The extension intentionally does not modify Pi core, Pi TUI, mouse behavior, assistant message rendering, or the main conversation panel.

## Agent-facing tools

Both `bg_shell` and `sub_agent` support:

- `action: "start"`
- `action: "status"`
- `action: "wait"`
- `action: "cancel"`
- `action: "config"`

For detached work that should resume the main agent automatically, start with `returnToMain: true`.

Example config:

```json
{
  "action": "config",
  "defaultTimeoutSeconds": 600,
  "defaultWaitTimeoutSeconds": 30,
  "defaultReturnToMain": true,
  "defaultReturnDelivery": "followUp"
}
```

`sub_agent` additionally supports `defaultThinking`.

## User-facing UI

`/events` opens a centered floating window, not a side panel.

```text
/events           open/toggle all background work
/events all       show all events
/events shell     show shell events
/events agents    show sub-agent events
/events running   show running events
/events exited    show exited/cancelled events
/events failed    show failed/timed-out events
/events close     close the events overlay
/events clear     acknowledge failed/timed-out footer warnings
```

### Keys inside `/events`

```text
j/k or ↑↓        move selection
ctrl+u/ctrl+d    page up/down
g/G              top/bottom
enter/space/o    expand current job
O                expand/collapse visible events
x                cancel selected running job
l                show selected log path
c                acknowledge failed footer warning
a/s/n/r/e/f      filters
R                refresh
?                help
q/esc            close
```

The footer uses one aggregate status key:

```text
● bg: 2 running
⚠ bg: 1 failed
● bg: 2 running, 1 failed
```

Running events are cancelled on `session_shutdown` by their owning module.

## Design notes

`/events` is intentionally limited to background work (`bg_shell` and `sub_agent`). Inline activity rendering lives in `ui-optimize/` so the monitor does not grow into a general conversation navigator.
