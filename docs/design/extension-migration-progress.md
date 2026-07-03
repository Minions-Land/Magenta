# Extension Migration Progress

**Status as of 2026-07-03:** Complete.

The original bundled Pi extension set has been retired from the default extension architecture. User-facing behavior is preserved; the code ownership changed so Pi UX/session features live in Pi, reusable tools live in Harness, and optional remote execution remains an extension.

## Final Status

| Extension | Final State | Location |
| --- | --- | --- |
| `todo` | Migrated | `harness/tools/todo/` |
| `local-credential-bridge` | Deleted | Replaced by `pi/coding-agent/src/core/external-auth-loader.ts` |
| `command-aliases` | Migrated | `pi/coding-agent/src/core/command-aliases.ts`, interactive editor flow |
| `ui-optimize` | Migrated | `pi/coding-agent` core/editor and `pi/tui` Markdown/activity rendering |
| `background-events` | Migrated | `pi/coding-agent/src/core/background-events.ts`, `core/tools/bg-shell.ts`, `core/tools/sub-agent.ts`, interactive overlay components |
| `side-chat` | Migrated | `pi/coding-agent/src/core/side-chat.ts`, `modes/interactive/components/side-chat-overlay.ts` |
| `ssh` | Kept | `harness/extensions/pi/bundled/ssh.ts` |

## Architecture Decision

The migration avoids adding Harness abstractions for features that are fundamentally user experience:

- `bg_shell`, `sub_agent`, `/events`, Side Chat, image tokens, Markdown rendering, command aliases, and tool grouping are Pi Agent-loop/TUI concerns.
- `todo` is a reusable tool and belongs in Harness.
- `ssh` is advanced, setup-dependent, and opt-in, so it remains a stable extension.

## Testing Evidence

Package-level checks run during migration:

- `npm --prefix pi/coding-agent run build`
- `npm --prefix pi/coding-agent test`
- `npm --prefix pi/tui run build`
- `npm --prefix pi/tui test`
- `npm --prefix harness run build`
- `npm --prefix harness test`

Focused migration coverage includes image tokens, Markdown rendering, `bg_shell`, `sub_agent`, Side Chat LLM dispatch, command links, resource loading, and tool filtering.

## Remaining Maintenance

- Keep `ssh.ts` documented and maintained as a stable optional extension.
- Prefer Pi core/TUI for future user-facing Agent-loop features.
- Prefer Harness/HCP only for reusable agent capabilities that are not Pi-specific UI/session behavior.
