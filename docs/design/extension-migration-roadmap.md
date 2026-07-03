# Extension Migration Roadmap

**Status:** Complete as of 2026-07-03.

The roadmap is closed. The bundled Pi extension retirement work ended with six features migrated or removed and one stable optional extension retained.

## Outcome

1. `todo` moved to `harness/tools/todo/`.
2. `local-credential-bridge` was deleted as redundant.
3. `command-aliases` moved to Pi core.
4. `ui-optimize` moved to Pi core/TUI.
5. `background-events` moved to Pi core/TUI.
6. `side-chat` moved to Pi core/TUI.
7. `ssh` remains a stable optional extension.

## Final Boundary

- Harness is for reusable tools and protocol/runtime capabilities.
- Pi is for Agent-loop behavior, session state, TUI components, slash commands, and user experience.
- Optional advanced features can remain extensions when their setup and usage are niche.

## Lessons Learned

- UI/session behavior should not be abstracted into Harness just to remove an extension.
- HCP is a good fit for reusable tools such as `todo`.
- Background execution and Side Chat are Pi user-experience features even though agents invoke tools.
- Stable optional extensions are acceptable when migration cost exceeds user benefit.
