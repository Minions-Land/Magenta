# Read Tool

Read file contents with optional line offset and limit.

## Implementation

- **Source**: pi (TypeScript)
- **Location**: `read/pi/read.ts`

## Usage

```typescript
import { createReadExecute, readSchema } from "@magenta/harness";

const execute = createReadExecute(cwd, {
  maxOutputBytes: 500 * 1024,  // 500KB
  maxOutputLines: 2000,
});

const result = await execute("toolUseId", {
  path: "src/index.ts",
  offset: 0,     // optional: start line
  limit: 100,    // optional: max lines to read
});
```

## Parameters

- **path** (required): File path to read (relative to cwd or absolute)
- **offset** (optional): Line number to start reading from (0-indexed)
- **limit** (optional): Maximum number of lines to read

## Output

Returns file content with:
- Line numbers (cat -n format)
- Automatic truncation if file exceeds limits
- Metadata: total lines, byte size, truncation info

## Features

- Supports text files, images (PNG, JPG, etc.), PDFs, Jupyter notebooks
- Smart path resolution (resolves `~`, relative paths, symlinks)
- Automatic encoding detection
- Truncation preserves beginning of file (unlike bash which shows end)

## HCP Declaration

`HarnessComponentProtocol/harness.toml` selects this component declaration for
codegen:

```toml
[[components]]
kind = "tool"
name = "read"
path = "tools/read/read.toml"
```
