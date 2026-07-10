# Bash Tool

Execute shell commands in the current working directory.

## Implementation

- **Source**: pi (TypeScript)
- **Location**: `bash/pi/bash.ts`

## Usage

The bash tool provides a pure execution function that runs shell commands and captures output.

```typescript
import { createBashExecute, bashSchema } from "@magenta/harness";

const execute = createBashExecute(cwd, {
  maxOutputBytes: 1024 * 1024,  // 1MB
  maxOutputLines: 10000,
});

const result = await execute("toolUseId", {
  command: "ls -la",
  timeout: 30000,  // 30 seconds
});
```

## Parameters

Defined in `bashSchema`:

- **command** (required): Shell command to execute
- **timeout** (optional): Timeout in milliseconds

## Output

Returns `AgentToolResult` with:
- `content`: Command stdout/stderr (truncated if needed)
- Truncation metadata if output exceeds limits
- Exit code and execution time

## Features

- Respects `.gitignore` context for safer command execution
- Automatic output truncation (last N lines/KB)
- Saves full output to temp file if truncated
- Configurable timeout
- Streaming output accumulation

## Registration

```toml
kind = "tool"
name = "bash"
path = "tools/bash/bash.toml"
```

## Security

Commands run in the provided working directory with the user's shell environment. No sandboxing is applied — callers must validate commands before execution.
