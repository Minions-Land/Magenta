# Local Extensions

This directory is auto-discovered by Pi from `~/.pi/agent/extensions`.

## Layout

| Path | Role | UI surface |
| --- | --- | --- |
| `shared/` | Shared local helpers for editor wrapping, shell/event formatting, and centered floating windows. | Not auto-loaded; imported by other extensions. |
| `ssh.ts` | Optional SSH-backed read/write/edit/bash tools via `--ssh`. | Footer SSH status when enabled. |

## Stable Optional Extension

`ssh.ts` intentionally remains a bundled extension instead of moving into Pi core. It is a niche remote-development mode that depends on user SSH setup and is best kept opt-in.

Examples:

```bash
pi -e ./ssh.ts --ssh user@host
pi -e ./ssh.ts --ssh user@host:/remote/project
```

Requirements:

- SSH key-based authentication; password prompts are not supported.
- `ssh`, `bash`, `cat`, `test`, `mkdir`, `base64`, and `file` available where the extension uses them.
- The remote path maps to the local session cwd; paths outside that mapped root are rejected.

## UI conventions

- Persistent extension state goes into footer statuses via stable keys, e.g. `ssh`.
- Temporary detail views should use focused centered overlays (`ctx.ui.custom(..., { overlay: true, overlayOptions: { anchor: "center" } })`) when they should own input and close with `Esc`.
- Editor customizations should wrap `ctx.ui.getEditorComponent()` instead of replacing it, preferably through `shared/editor-wrapper.ts`, so future editor features can compose.
- Long-running local processes are session-scoped and are cancelled on `session_shutdown`.

After editing extensions, run `/reload`.
