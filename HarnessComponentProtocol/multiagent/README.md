# Multiagent

This Harness Module provides workflow orchestration over sessionless, one-shot
workers. It is not a persistent agent-team runtime.

- `HcpServer.ts` owns the `multiagent` Module endpoint and public contracts.
- `multiagent.toml` declares the selected Source, capability slot, and patterns.
- `workflow/magenta/HcpMagnet.ts` builds the Magenta workflow provider.
- `workflow/magenta/worker.ts` owns the sessionless worker process and capability denial.

Named presets have fixed runtime-owned control flow and caller-supplied task
slots. The `script` pattern gives the workflow author control of if/while/await
flow and termination, but worker creation remains behind injected primitives;
the runtime still owns depth guards, tool denial (including peer messaging),
timeouts, guard injection, cancellation, and run-state persistence.

The workflow implementation and presets remain under the owning Source. The
Module is assembled from TOML through the generated `HCP_SERVERS` and
`HCP_MAGNETS` values; it has no parallel lookup or builder list.
