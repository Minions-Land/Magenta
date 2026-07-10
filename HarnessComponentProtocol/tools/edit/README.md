# Edit Tool

Apply one or more targeted text replacements to a file.

## Implementation

- **Source**: pi (TypeScript)
- **Location**: `edit/pi/edit.ts`

## Usage

The edit tool provides exact string replacement with multiple edits in a single operation.

```typescript
import { createEditExecute, editSchema } from "@magenta/harness";

const execute = createEditExecute(cwd, {
  operations: defaultEditOperations  // or custom
});

const result = await execute("toolUseId", {
  path: "src/utils.ts",
  edits: [
    {
      oldText: "function hello() {",
      newText: "export function hello() {"
    },
    {
      oldText: "console.log('debug')",
      newText: "// console.log('debug')"
    }
  ]
});
```

## Parameters

Defined in `editSchema`:

- **path** (required): File path (relative or absolute)
- **edits** (required): Array of replacement operations
  - **oldText**: Exact text to find (must be unique in file)
  - **newText**: Replacement text

## Edit Rules

1. Each `oldText` must appear **exactly once** in the file (must be unique)
2. No overlapping edits — if two changes touch the same block, merge them into one edit
3. All edits are matched against the **original file content**, not incrementally
4. Line endings and BOM are preserved automatically

## Output

Returns `AgentToolResult` with:
- **content**: Success message
- **details**: `EditToolDetails` containing:
  - `diff`: Display-oriented diff string
  - `patch`: Standard unified patch format
  - `firstChangedLine`: Line number of first change (for editor navigation)

## Features

- **Multiple edits in one call**: Apply several changes atomically
- **Line ending preservation**: Automatically detects and preserves CRLF/LF
- **BOM handling**: Preserves UTF-8 BOM if present
- **Diff generation**: Shows exactly what changed
- **Unified patch**: Standard patch format for version control
- **File locking**: Serializes writes to prevent concurrent edit conflicts
- **Abort support**: Respects AbortSignal for cancellation

## Pluggable Operations

Override default filesystem operations for remote editing:

```typescript
interface EditOperations {
  readFile: (absolutePath: string) => Promise<Buffer>;
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  access: (absolutePath: string) => Promise<void>;
}
```

## Registration

```toml
kind = "tool"
name = "edit"
path = "tools/edit/edit.toml"
```

## Dependencies

- `edit-diff.ts` — Diff computation and patch generation
- `file-mutation-queue.ts` — Write serialization
- `path-utils.ts` — Path resolution

## Error Handling

Errors when:
- File not found or not readable/writable
- `oldText` not found in file
- `oldText` appears multiple times (not unique)
- Overlapping edits detected
- File modified during operation
