# Shared Utilities

This private Magenta support directory contains reusable implementation
utilities. It is not a Harness Module, Source, HCP role, or selection layer.

## Contents

- `truncate.ts`: bounded head/tail/line truncation and byte formatting;
- `path-utils.ts` and `paths.ts`: path normalization and resolution;
- `edit-diff.ts`: replacement matching, diff, and patch generation;
- `file-mutation-queue.ts`: per-file write/edit serialization;
- `output-accumulator.ts`: bounded streaming output with optional spill files;
- `child-process.ts`: child-process helpers; and
- `toml.ts`: the shared `smol-toml` parser wrapper.

Only intentional package-barrel exports are public. In particular,
`truncateHead()`, `truncateTail()`, `truncateLine()`, and `formatSize()` are
available from `@magenta/harness`; several tool-facing helpers are re-exported
through `tools/index.ts`. Other files remain internal and should not be
deep-imported by application code.

```typescript
import { formatSize, truncateHead } from "@magenta/harness";

const result = truncateHead(output, { maxLines: 100, maxBytes: 10_240 });
console.log(result.content, result.truncatedBy, formatSize(result.totalBytes));
```

The default shared limits are 2,000 lines and 50 KiB. `truncateHead()` keeps
the beginning, `truncateTail()` keeps the end, and `TruncationResult` records
which bound was reached. Persisting full output is a responsibility of callers
such as `OutputAccumulator`; truncation alone does not create a temporary file.
