# Ls Tool

The `ls` Tool lists the immediate children of a directory. It is non-recursive;
use `find` for recursive file discovery.

## Sources

`ls.toml` declares `pi` and `magenta` Sources, with `pi` selected by default.
The Pi Source uses injectable filesystem operations. The Magenta Source builds
a process-backed Tool through `runtime:process` and `sandbox`.

## Public Execution API

```typescript
import { createLsExecute } from "@magenta/harness";

const execute = createLsExecute(cwd, { operations: defaultLsOperations });
const result = await execute("tool-call-id", { path: "src", limit: 100 });
```

- `path` defaults to the bound working directory.
- `limit` defaults to 500 entries.
- Results are sorted case-insensitively.
- Directories receive a trailing `/`; files are emitted by name only.
- Output is bounded by entry count and the shared byte limit.

`LsOperations` exposes `exists`, `stat`, and `readdir`, allowing a host to supply
local or remote filesystem behavior. The Tool does not report file sizes,
permissions, or a recursive tree.
