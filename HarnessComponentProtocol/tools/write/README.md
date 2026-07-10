# Write Tool

Write content to a file, creating parent directories as needed.

## Implementation

- **Source**: pi (TypeScript)
- **Location**: `write/pi/write.ts`

## Usage

The write tool creates or overwrites files with provided content.

```typescript
import { createWriteExecute, writeSchema } from "@magenta/harness";

const execute = createWriteExecute(cwd, {
  operations: defaultWriteOperations  // or custom
});

const result = await execute("toolUseId", {
  path: "src/new-file.ts",
  content: "export const VERSION = '1.0.0';\n"
});
```

## Parameters

Defined in `writeSchema`:

- **path** (required): File path (relative or absolute)
- **content** (required): Content to write to the file

## Output

Returns `AgentToolResult` with:
- **content**: Success message with file path
- **details**: `undefined` (no additional metadata)

## Features

- **Automatic directory creation**: Creates parent directories if they don't exist
- **UTF-8 encoding**: Always writes as UTF-8
- **File overwriting**: Overwrites existing files without warning
- **File locking**: Serializes writes to prevent concurrent write conflicts
- **Abort support**: Respects AbortSignal for cancellation

## Pluggable Operations

Override default filesystem operations for remote writing:

```typescript
type WriteOperations = {
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  mkdir: (dir: string) => Promise<void>;
};
```

Example for SSH-based writing:

```typescript
const execute = createWriteExecute(cwd, {
  operations: {
    writeFile: async (path, content) => {
      await sshClient.writeFile(path, content);
    },
    mkdir: async (dir) => {
      await sshClient.exec(`mkdir -p ${dir}`);
    }
  }
});
```

## HCP Declaration

`HarnessComponentProtocol/harness.toml` selects this component declaration for
codegen:

```toml
[[components]]
kind = "tool"
name = "write"
path = "tools/write/write.toml"
```

## Dependencies

- `file-mutation-queue.ts` — Write serialization
- `path-utils.ts` — Path resolution
- Node.js `fs/promises` — File system operations

## Error Handling

Errors when:
- Parent directory creation fails
- File write fails (permissions, disk full, etc.)
- Operation aborted via signal

## Use Cases

1. **Creating new files**: Add new source files, configs, documentation
2. **Full rewrites**: Replace entire file contents
3. **Generated code**: Write build outputs, generated types, etc.

For partial edits, use the **edit** tool instead.
