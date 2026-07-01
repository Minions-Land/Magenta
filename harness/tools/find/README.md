# Find Tool

Find files matching a glob pattern.

## Implementation

- **Source**: pi (TypeScript)
- **Location**: `find/pi/find.ts`

## Usage

The find tool searches for files using `fd` (a fast alternative to Unix `find`).

```typescript
import { createFindExecute, findSchema } from "@magenta/harness";

const execute = createFindExecute(cwd, options, {
  ensureTool: async (tool) => "/path/to/fd"
});

const result = await execute("toolUseId", {
  pattern: "*.ts",
  path: "src/",
  limit: 500
});
```

## Parameters

Defined in `findSchema`:

- **pattern** (required): Glob pattern (e.g., `*.ts`, `**/*.json`, `src/**/*.spec.ts`)
- **path** (optional): Directory to search in (default: current directory)
- **limit** (optional): Maximum number of results (default: 1000)

## Output

Returns `AgentToolResult` with:
- **content**: List of matching file paths (one per line)
- **details**: `FindToolDetails` containing:
  - `truncation`: Truncation metadata if output exceeds limits
  - `resultLimitReached`: Number of results if limit hit

## Features

- **Fast search**: Uses `fd` for high performance
- **Gitignore support**: Automatically respects `.gitignore` files
- **Glob patterns**: Supports standard glob syntax (`*`, `**`, `?`, `[...]`)
- **Output limits**: Truncates to 1000 results or 50KB (whichever hits first)
- **Cross-platform**: Works on Linux, macOS, Windows
- **Abort support**: Respects AbortSignal for cancellation

## Glob Pattern Examples

```typescript
// All TypeScript files
pattern: "*.ts"

// TypeScript files recursively
pattern: "**/*.ts"

// Test files only
pattern: "**/*.spec.ts"

// Multiple extensions (fd supports)
pattern: "*.{ts,tsx,js,jsx}"

// Specific directory structure
pattern: "src/components/**/*.tsx"
```

## Output Format

```
src/utils.ts
src/handler.ts
src/types/index.ts
test/utils.spec.ts
```

Paths are relative to the search directory.

## fd Resolution

The tool requires `fd` to be available. Pi's tools-manager auto-downloads `fd` if missing via the injected `ensureTool` dependency.

```typescript
interface FindExecuteDeps {
  ensureTool: (tool: string, silent?: boolean) => Promise<string | undefined>;
}
```

## Pluggable Operations

Override for custom file search:

```typescript
interface FindOperations {
  exists: (absolutePath: string) => Promise<boolean> | boolean;
  glob: (pattern: string, cwd: string, options: {
    ignore: string[];
    limit: number;
  }) => Promise<string[]> | string[];
}
```

Example for remote search:

```typescript
createFindExecute(cwd, {
  operations: {
    exists: (path) => sshClient.exists(path),
    glob: async (pattern, cwd, opts) => {
      return await sshClient.exec(`fd ${pattern} ${cwd} --max-results ${opts.limit}`);
    }
  }
});
```

## Registration

```toml
kind = "tool"
name = "find"
path = "tools/find/find.toml"
```

## Dependencies

- `fd` — External binary for fast file search
- `truncate.ts` — Output truncation
- `path-utils.ts` — Path resolution
- Node.js `child_process` — Spawn fd process

## Error Handling

Errors when:
- fd not found or fails to execute
- Search path doesn't exist
- Invalid glob pattern
- Operation aborted via signal

## Performance

`fd` is significantly faster than traditional `find`:
- Parallel directory traversal
- Automatic gitignore handling
- Smart filtering
- Colored output (when in terminal)

Typical performance: < 1 second for searching tens of thousands of files.

## Comparison with grep

- **find**: Searches for **file names** matching a pattern
- **grep**: Searches for **file contents** matching a pattern

Use `find` to locate files, then `grep` to search within them.
