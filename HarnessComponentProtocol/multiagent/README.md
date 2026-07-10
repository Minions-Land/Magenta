# Multiagent

This Harness Module provides the selected multi-agent workflow capability.

- `HcpServer.ts` owns the `multiagent` Module endpoint.
- `multiagent.toml` declares the selected Source and capability slot.
- `workflow/magenta/HcpMagnet.ts` builds the Magenta workflow provider.

The workflow implementation and presets remain under the owning Source. The
Module is assembled from TOML through the generated `HCP_SERVERS` and
`HCP_MAGNETS` values; it has no parallel lookup or builder list.
