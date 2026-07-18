# SendMessage Tool

`tool:send_message` owns durable Session mailbox delivery, presence, boot-scoped wake, bounded drain/confirm/requeue, peer outbox routing, and SSH relay supervision.

The Magenta Source produces one stateful Tool product. `SendMessageRuntime` is an internal host support surface used for Session lifecycle integration and by `tools/multiagent`; it is not an HCP Capability product and is never invoked through the model-visible Tool executor.
