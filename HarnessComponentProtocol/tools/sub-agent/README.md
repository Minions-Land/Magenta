# sub_agent Tool Source

`tools/sub-agent` owns finite Event registration, the per-caller FIFO scheduler, sessionless child supervision, trusted Workflow presets, terminal external activation, and bounded receipt retention.

The Source publishes only `tool:sub_agent` through `toTool()`. Workflow types and runners are internal support code and receive no HCP Capability address.
