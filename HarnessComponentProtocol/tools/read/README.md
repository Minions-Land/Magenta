# Read Tool

The `read` Tool reads text or image files from the bound working directory.

## Sources

`read.toml` declares `pi` and `magenta` Sources, with `pi` selected by default.
The Pi Source builds the native Tool; the Magenta Source uses the shared process
runtime and sandbox. Both route through `tools/read/HcpServer.ts`.

## Public Execution API

```typescript
import { createReadExecute } from "@magenta/harness";

const execute = createReadExecute(cwd, {
  operations,       // optional filesystem/image operations
  autoResizeImages: true,
});

const result = await execute("tool-call-id", {
  path: "src/index.ts",
  offset: 1, // optional, 1-indexed
  limit: 100,
});
```

- `path` is required and may be relative to `cwd` or absolute.
- `offset` is optional and 1-indexed.
- `limit` optionally caps returned text lines.

Text is UTF-8 decoded and bounded by shared line/byte limits. Truncated results
include a continuation offset. When the host injects image detection and resize
operations, image files are returned as image content; the default local
operations alone do not detect images. PDF and notebook parsing are not part of
this Harness implementation.
