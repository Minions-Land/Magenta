# Environment Support

This private Magenta support directory contains host environment adapters. It
is not a Harness Module or Source and does not appear in HCP codegen.

## Node.js Adapter

`pi/nodejs.ts` exports `NodeExecutionEnv`, the Node.js implementation of the
structural `ExecutionEnv = FileSystem & Shell` type in
`../types/types.ts`.

```typescript
import { NodeExecutionEnv } from "@magenta/harness";

const env = new NodeExecutionEnv({ cwd: "/workspace" });
const content = await env.readTextFile("README.md");
const entries = await env.listDir("src");
const command = await env.exec("npm test", { timeout: 30 });
await env.cleanup();
```

The adapter implements:

- path operations: `absolutePath()`, `joinPath()`, and `canonicalPath()`;
- reads: `readTextFile()`, `readTextLines()`, and `readBinaryFile()`;
- writes: `writeFile()` and `appendFile()`;
- filesystem management: `fileInfo()`, `listDir()`, `exists()`, `createDir()`,
  `remove()`, `createTempDir()`, and `createTempFile()`;
- shell execution through `exec()`; and
- best-effort `cleanup()`.

Operations return `Result` values rather than leaking filesystem/process
exceptions. `exec()` timeout values are seconds. The constructor also accepts
optional `shellPath` and `shellEnv` values.

## SSH Support

`ssh.ts` exports remote operations used by selected coding-agent tools. It is a
host adapter, not an alternative HCP transport or a Source identity. A real Tool
Source remains responsible for producing the Tool that consumes these
operations.
