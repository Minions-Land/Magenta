# Bash Tool

The `bash` Tool executes a shell command in the bound working directory and
returns combined command output plus execution details.

## Sources

`bash.toml` declares both `pi` and `magenta` Sources, with `pi` selected by
default:

- `pi/HcpMagnet.ts` builds the host-native shell Tool from injected operations
  and environment resolution;
- `magenta/HcpMagnet.ts` builds the process-backed implementation through the
  selected `runtime:process` and `sandbox` Capabilities.

Both remain Source implementations of the real `tools/bash` Module. Process and
shell are mechanisms, not HCP roles.

## Public Execution API

```typescript
import { createBashExecute } from "@magenta/harness";

const execute = createBashExecute(cwd, {
  operations,
  resolveEnv,
});

const result = await execute("tool-call-id", {
  command: "npm test",
  timeout: 30, // seconds
});
```

`command` is required. `timeout` is optional and measured in seconds. Output is
bounded by the shared line and byte limits; when truncated, the implementation
retains the complete output in a temporary file and reports its path.

The pure Harness execution factory does not decide approvals or trust. The
coding-agent host supplies policy and native operations, while the Magenta
process Source explicitly resolves runtime and sandbox providers.
