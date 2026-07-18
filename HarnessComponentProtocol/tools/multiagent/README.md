# multiagent Tool Source

`tools/multiagent` owns the durable registry for persistent teammate Sessions, desired/observed process reconciliation, the 16-process FIFO scheduler, RPC hard control, automatic recovery for an exact Main Session lineage, trusted teammate policy, and Git worktree generations with immutable receipts.

The Source publishes only `tool:multiagent` through `toTool()`. Ordinary cross-Session communication is delegated to the typed internal Mailbox support API owned by `tools/send-message`; the support API receives no HCP Capability address.
