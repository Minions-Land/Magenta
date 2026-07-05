# Env Module

The **env** module provides environment adapters for runtime integration.

## Implementation

- **Source**: pi (TypeScript)
- **Location**: `env/pi/nodejs.ts`

## Key Export

- `createNodejsEnv()` — Create an ExecutionEnv implementation for Node.js runtime

## ExecutionEnv Interface

The `ExecutionEnv` interface abstracts platform-specific operations:

```typescript
interface ExecutionEnv {
  // File operations
  fileInfo(path: string): Promise<Result<FileInfo, FileError>>;
  readFile(path: string, signal?: AbortSignal): Promise<Result<string, FileError>>;
  writeFile(path: string, content: string, signal?: AbortSignal): Promise<Result<void, FileError>>;
  appendFile(path: string, content: string, signal?: AbortSignal): Promise<Result<void, FileError>>;
  mkdir(path: string, signal?: AbortSignal): Promise<Result<void, FileError>>;
  readdir(path: string, signal?: AbortSignal): Promise<Result<string[], FileError>>;
  
  // Temp file operations
  createTempFile(options?: TempFileOptions): Promise<Result<string, FileError>>;
  createTempDir(options?: TempDirOptions): Promise<Result<string, FileError>>;
  
  // Shell execution
  exec(command: string, options?: ShellExecOptions): Promise<Result<ShellExecResult, ExecutionError>>;
  
  // Stream processing
  streamLines(filePath: string, signal?: AbortSignal): AsyncIterable<string>;
}
```

## Usage

```typescript
import { createNodejsEnv } from "@magenta/harness";

const env = createNodejsEnv("/working/directory");

// File operations
const fileInfo = await env.fileInfo("/path/to/file");
const content = await env.readFile("/path/to/file");

// Shell execution
const result = await env.exec("npm test", {
  cwd: "/project",
  timeout: 30000,
  onStdout: (chunk) => console.log(chunk)
});

// Temp files
const tempFile = await env.createTempFile({ prefix: "output-", suffix: ".log" });
```

## Node.js Implementation

The Node.js adapter (`nodejs.ts`) provides:

- **File operations**: Uses `fs/promises` (readFile, writeFile, stat, etc.)
- **Temp files**: Uses `os.tmpdir()` + unique IDs
- **Shell execution**: Uses `child_process.spawn` with streaming
- **Error mapping**: Converts Node.js errors to typed FileError/ExecutionError
- **Abort support**: Respects AbortSignal throughout

## Error Handling

All operations return `Result<T, Error>` instead of throwing:

```typescript
const result = await env.readFile("/path/to/file");
if (result.ok) {
  console.log(result.value);  // string content
} else {
  console.error(result.error.code);  // "not_found" | "permission_denied" | ...
}
```

Error codes:
- `not_found` — File/directory doesn't exist
- `permission_denied` — Access denied
- `not_directory` — Expected directory, got file
- `aborted` — Operation cancelled via signal
- `invalid` — Unsupported file type
- `unknown` — Other errors

## Registration

```toml
[[components]]
kind = "env"
name = "env"
path = "env/env.toml"
```

## Dependencies

- Node.js `fs/promises` — File system operations
- Node.js `child_process` — Shell execution
- Node.js `path` — Path resolution
- Node.js `os` — Temp directory
- Types module (ExecutionEnv, Result, errors)

## Design Rationale

The `ExecutionEnv` abstraction enables:

1. **Platform portability**: Swap Node.js for Deno/Bun/browser
2. **Testing**: Mock file system and shell for unit tests
3. **Remote execution**: Implement SSH-based env for remote work
4. **Sandboxing**: Wrap operations with permission checks

All harness modules depend on `ExecutionEnv`, not directly on Node.js APIs. This keeps the core logic platform-agnostic.

## Future Implementations

Planned adapters:
- **Deno**: `env/deno/deno.ts`
- **Browser**: `env/browser/browser.ts` (with limitations)
- **SSH**: `env/ssh/ssh.ts` (remote file operations)
- **Docker**: `env/docker/docker.ts` (containerized execution)
