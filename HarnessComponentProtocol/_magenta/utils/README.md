# Shared Utilities

This private Magenta support library provides utilities for shell output formatting,
text truncation, path handling, process spawning, streaming output collection,
and serialized file mutation. It is imported by real modules; it is not itself a
Harness Module and is not registered with HCP.

## Implementations

- **Source**: pi (TypeScript)
- **Location**: `utils/pi/`

## Key Exports

### Truncation (`truncate.ts`)

- `truncateHead()` — Truncate from the beginning, keeping the end
- `truncateTail()` — Truncate from the end, keeping the beginning
- `truncateLine()` — Truncate a single long line
- `formatSize()` — Format bytes as human-readable size (KB, MB, GB)
- `TruncationResult` — Detailed truncation metadata
- Constants: `DEFAULT_MAX_LINES` (2000), `DEFAULT_MAX_BYTES` (50KB), `GREP_MAX_LINE_LENGTH` (500)

### Shell Output (`shell-output.ts`)

- `executeShellWithCapture()` — Execute shell command with output capture and truncation
- `sanitizeBinaryOutput()` — Remove control characters from binary output
- `ShellCaptureResult` — Execution result with output, exit code, truncation metadata

### Tool Support Utilities

- `path-utils.ts` / `paths.ts` — Path normalization, resolution, and display helpers
- `edit-diff.ts` — Shared edit diff and fuzzy-match utilities
- `file-mutation-queue.ts` — Per-file serialization for write/edit operations
- `output-accumulator.ts` — Streaming output collection with bounded memory
- `child-process.ts` — Cross-platform process spawn helpers
- `toml.ts` — Shared standards-compliant TOML parsing for runtime descriptors

## Truncation Strategy

Truncation uses **two independent limits** (whichever hits first):
1. **Line limit**: Default 2000 lines
2. **Byte limit**: Default 50KB

Never returns partial lines (except bash tail truncation edge case).

## Usage Examples

### Text Truncation

```typescript
import { truncateHead, truncateTail, formatSize } from "@magenta/harness";

// Keep the end (for build logs where errors appear at the end)
const result = truncateTail(longOutput, { maxLines: 500, maxBytes: 10240 });
console.log(result.content);
console.log(`Truncated: ${result.truncated}`);
console.log(`Hit limit: ${result.truncatedBy}`); // "lines" | "bytes" | null

// Keep the beginning (for file listings)
const headResult = truncateHead(longOutput, { maxLines: 100 });

// Format sizes
console.log(formatSize(1024));      // "1.0 KB"
console.log(formatSize(1536000));   // "1.5 MB"
```

### Shell Command Execution

```typescript
import { executeShellWithCapture } from "@magenta/harness";

const result = await executeShellWithCapture(env, "npm test", {
  cwd: "/path/to/project",
  timeout: 30000,
  abortSignal: signal,
  onChunk: (chunk) => console.log(chunk)  // Stream output
});

if (result.ok) {
  console.log(result.value.output);           // Truncated output
  console.log(result.value.exitCode);         // Exit code
  console.log(result.value.truncated);        // Whether truncated
  console.log(result.value.fullOutputPath);   // Temp file with full output (if truncated)
}
```

## Truncation Result

```typescript
type TruncationResult = {
  content: string;              // Truncated content
  truncated: boolean;           // Whether truncation occurred
  truncatedBy: "lines" | "bytes" | null;  // Which limit hit
  totalLines: number;           // Original line count
  totalBytes: number;           // Original byte count
  outputLines: number;          // Truncated line count
  outputBytes: number;          // Truncated byte count
  lastLinePartial: boolean;     // Last line incomplete?
  firstLineExceedsLimit: boolean;  // First line too long?
  maxLines: number;             // Applied line limit
  maxBytes: number;             // Applied byte limit
};
```

## Shell Capture Features

- **Output sanitization**: Removes control characters from binary output
- **Automatic temp file**: Saves full output to temp file when truncated
- **Streaming support**: Optional `onChunk` callback for real-time output
- **Abort support**: Respects AbortSignal for cancellation
- **Memory management**: Keeps last 100KB in memory, saves overflow to disk

## Dependencies

- Types module (ExecutionEnv, Result, errors)

## Used By

- **bash** tool — Truncates command output
- **grep** tool — Truncates long lines
- **find** tool — Truncates file lists
- **ls** tool — Truncates directory listings
- **read** tool — Truncates large files
- **edit/write** tools — Reuse mutation queues and path resolution
- **Magnet process adapters** — Reuse truncation and output limits

## Design Notes

These utilities are **shared across all tools** to ensure consistent output handling. Truncation prevents:
- Out-of-memory errors from large outputs
- Token budget exhaustion in LLM context
- UI freezes from rendering huge text blocks

When output is truncated, the full content is saved to a temp file so users can access it if needed.
