# Background Jobs

A Pi extension for agent-facing background execution and a small keyboard-first `/jobs` monitor.

## Responsibilities

- `background-shell.ts`: `bg_shell` for long-running non-interactive shell commands.
- `sub-agents.ts`: `sub_agent` for headless read-mostly Pi workers.
- `job-monitor.ts`: source aggregation, footer status, and `/jobs` command routing.
- `jobs-overlay.ts`: focused centered floating background job list UI.
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

`/jobs` opens a centered floating window, not a side panel.

```text
/jobs           open/toggle all background work
/jobs all       show all jobs
/jobs shell     show shell jobs
/jobs agents    show sub-agent jobs
/jobs running   show running jobs
/jobs exited    show exited/cancelled jobs
/jobs failed    show failed/timed-out jobs
/jobs close     close the jobs overlay
/jobs clear     acknowledge failed/timed-out footer warnings
```

### Keys inside `/jobs`

```text
j/k or ↑↓        move selection
ctrl+u/ctrl+d    page up/down
g/G              top/bottom
enter/space/o    expand current job
O                expand/collapse visible jobs
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

Running jobs are cancelled on `session_shutdown` by their owning module.

## Design notes

`/jobs` is intentionally limited to background work (`bg_shell` and `sub_agent`). Inline activity rendering lives in `ui-optimize/` so the monitor does not grow into a general conversation navigator.
