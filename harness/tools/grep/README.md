# Grep Tool

Search file contents for a pattern.

## Implementation

- **Source**: pi (TypeScript)
- **Location**: `grep/pi/grep.ts`

## Usage

The grep tool searches files using ripgrep (rg) for fast pattern matching.

```typescript
import { createGrepExecute, grepSchema } from "@magenta/harness";

const execute = createGrepExecute(cwd, {
  resolveRipgrep: () => "rg"  // or custom resolver
});

const result = await execute("toolUseId", {
  pattern: "TODO",
  path: "src/",
  glob: "*.ts",
  ignoreCase: true,
  context: 2,
  limit: 50
});
```

## Parameters

Defined in `grepSchema`:

- **pattern** (required): Search pattern (regex or literal string)
- **path** (optional): Directory or file to search (default: current directory)
- **glob** (optional): Filter files by glob pattern (e.g., `*.ts`, `**/*.spec.ts`)
- **ignoreCase** (optional): Case-insensitive search (default: false)
- **literal** (optional): Treat pattern as literal string, not regex (default: false)
- **context** (optional): Lines to show before/after each match (default: 0)
- **limit** (optional): Maximum number of matches (default: 100)

## Output

Returns `AgentToolResult` with:
- **content**: Matching lines with file paths and line numbers
- **details**: `GrepToolDetails` containing:
  - `truncation`: Truncation metadata if output exceeds limits
  - `matchLimitReached`: Number of matches if limit hit
  - `linesTruncated`: Whether long lines were truncated

## Features

- **Fast search**: Uses ripgrep (rg) for high performance
- **Gitignore support**: Automatically respects `.gitignore` files
- **Regex support**: Full regex pattern matching (unless `literal: true`)
- **Context lines**: Show surrounding lines for better understanding
- **Glob filtering**: Search only matching file types
- **Output limits**: Truncates to 100 matches or 50KB (whichever hits first)
- **Line truncation**: Long lines capped at 500 chars
- **Abort support**: Respects AbortSignal for cancellation

## Output Format

```
src/utils.ts:42: TODO: refactor this
src/handler.ts:18: // TODO: add error handling
src/handler.ts:19:   return data;
```

With context (`context: 1`):
```
src/utils.ts:41-   // existing code
src/utils.ts:42: TODO: refactor this
src/utils.ts:43-   return result;
```

## Ripgrep Resolution

The tool requires ripgrep (`rg`) to be available. By default it looks for `rg` in PATH. Pi's tools-manager auto-downloads ripgrep if missing.

Custom resolver:
```typescript
createGrepExecute(cwd, {
  resolveRipgrep: async () => {
    // Custom download/resolution logic
    return "/path/to/rg";
  }
});
```

## Pluggable Operations

Override for remote search:

```typescript
interface GrepOperations {
  isDirectory: (absolutePath: string) => Promise<boolean> | boolean;
  readFile: (absolutePath: string) => Promise<string> | string;
}
```

## Registration

```toml
kind = "tool"
name = "grep"
path = "tools/grep/grep.toml"
```

## Dependencies

- `ripgrep` (rg) — External binary for fast search
- `truncate.ts` — Output truncation
- `path-utils.ts` — Path resolution
- Node.js `child_process` — Spawn ripgrep process

## Error Handling

Errors when:
- Ripgrep not found or fails to execute
- Search path doesn't exist
- Invalid regex pattern
- Operation aborted via signal

## Performance

Ripgrep is extremely fast, even on large codebases:
- Multi-threaded search
- Automatic gitignore handling
- Smart encoding detection
- Memory-mapped I/O

Typical performance: 1-2 seconds for searching millions of lines.
