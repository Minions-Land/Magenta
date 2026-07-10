# Ls Tool

List directory entries with file metadata.

## Implementation

- **Source**: pi (TypeScript)
- **Location**: `ls/pi/ls.ts`

## Usage

The ls tool provides directory listing with file types and sizes.

```typescript
import { createLsExecute, lsSchema } from "@magenta/harness";

const execute = createLsExecute(cwd, {
  operations: defaultLsOperations  // or custom
});

const result = await execute("toolUseId", {
  path: "src/",
  limit: 100
});
```

## Parameters

Defined in `lsSchema`:

- **path** (optional): Directory to list (default: current directory)
- **limit** (optional): Maximum number of entries (default: 500)

## Output

Returns `AgentToolResult` with:
- **content**: Formatted directory listing
- **details**: `LsToolDetails` containing:
  - `truncation`: Truncation metadata if output exceeds limits
  - `entryLimitReached`: Number of entries if limit hit

## Features

- **File metadata**: Shows type (file/dir), size, permissions
- **Sorted output**: Directories first, then files (alphabetically)
- **Hidden files**: Includes dotfiles (`.hidden`)
- **Symbolic links**: Detected and labeled
- **Size formatting**: Human-readable sizes (KB, MB, GB)
- **Output limits**: Truncates to 500 entries or 50KB (whichever hits first)
- **Abort support**: Respects AbortSignal for cancellation

## Output Format

```
src/
  components/ (directory)
  utils/ (directory)
  index.ts (file, 1.2 KB)
  types.ts (file, 856 B)
  .gitignore (file, 42 B)
```

## Pluggable Operations

Override for remote directory listing:

```typescript
type LsOperations = {
  exists: (absolutePath: string) => Promise<boolean> | boolean;
  stat: (absolutePath: string) => Promise<{ isDirectory: () => boolean }>;
  readdir: (absolutePath: string) => Promise<string[]> | string[];
};
```

Example for SSH-based listing:

```typescript
createLsExecute(cwd, {
  operations: {
    exists: (path) => sshClient.exists(path),
    stat: async (path) => {
      const info = await sshClient.stat(path);
      return { isDirectory: () => info.type === 'directory' };
    },
    readdir: (path) => sshClient.readdir(path)
  }
});
```

## HCP Declaration

`HarnessComponentProtocol/harness.toml` selects this component declaration for
codegen:

```toml
[[components]]
kind = "tool"
name = "ls"
path = "tools/ls/ls.toml"
```

## Dependencies

- `truncate.ts` — Output truncation
- `path-utils.ts` — Path resolution
- Node.js `fs/promises` — File system operations

## Error Handling

Errors when:
- Path doesn't exist
- Path is not a directory
- Permission denied
- Operation aborted via signal

## Use Cases

1. **Directory exploration**: See what files are available
2. **File discovery**: Find files before reading/editing
3. **Structure understanding**: Learn codebase organization
4. **Size estimation**: Check file sizes before reading

## Comparison with find

- **ls**: Lists **immediate children** of a directory (non-recursive)
- **find**: Searches **recursively** for files matching a pattern

Use `ls` for quick directory overview, `find` for deep file search.
