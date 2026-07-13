# Progress

- [x] Contract and architecture boundaries
- [x] Session/message primitives
- [x] Persistent teammate controller
- [x] AgentSession and background-event wiring
- [x] Lifecycle, mailbox, recursion, and race tests
- [x] Focused regression tests and package build

The first release supports clean persistent child sessions, parent-bound `send_message` work delivery, RPC abort/shutdown control, process-generation isolation, workspace-contained cwd validation, saved-session resume within the controlling `AgentSession`, and process-group cleanup. Cross-main-process teammate discovery remains deferred: the child session persists, but a new main process does not reconstruct the prior controller registry automatically.

Managed teammates share the parent OS-user trust domain. Controller-level tool and mailbox restrictions prevent normal recursive or cross-parent operations, but they are not a sandbox against a deliberately hostile teammate with shell access: that process inherits credentials needed by providers and can access same-user files, including the mailbox database. Strong confidentiality would require brokered mailbox/auth IPC plus sandbox enforcement, which is outside this lifecycle feature.
