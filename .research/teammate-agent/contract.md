# Teammate Agent Contract

1. `teammate_agent start` creates a clean persisted session with a unique session id, a `parentSession` header pointing at the main session when available, and no copied main conversation entries.
2. The child is a long-lived hidden RPC Magenta process, remains alive after a task, and appears under `/events` with session identity and activity state.
3. Work assignments and results use the shared `send_message` mailbox. The child always has `send_message`; recursive `teammate_agent`, `sub_agent`, and `bg_shell` tools are denied.
4. The child context contains explicit `selfSessionId`, `parentSessionId`, and reply rules so identities cannot be inferred incorrectly.
5. `send` delivers a mailbox message; urgent delivery wakes an idle teammate.
6. `interrupt` waits for RPC `abort` to make the teammate idle, then sends the replacement instruction urgently.
7. `stop` and parent-session shutdown terminate the detached process group; the child performs normal disposal so presence becomes offline.
8. Existing `sub_agent`, `bg_shell`, and peer-message priority behavior remain unchanged.
9. Focused tests cover clean lineage, persistent start, mailbox delivery, abort-before-message ordering, stop/cancel, identity metadata, and default tool registration.
