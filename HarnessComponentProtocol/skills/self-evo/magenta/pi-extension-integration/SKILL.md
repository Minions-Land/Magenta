---
name: self-evo-pi-extension-integration
disable-model-invocation: true
---

# Sub-skill: Pi Extension Integration (End-to-End)

> Chapter of `self-evo`. Not indexed, not independently invocable. Enter here
> from the parent skill when the capability comes from a **single Pi extension**.

This sub-skill covers the complete process of integrating a Pi (Claude Code) extension into Magenta's harness. It's divided into two phases that flow together:

1. **Intake** — Acquire and vet the extension source
2. **Conversion** — Translate injection points to harness primitives and wire Magnets

---

## Overview: The Pi Path

The Pi path is for **single, lightweight extensions** that dissolve into the trunk. If the extension is heavy (complex runtime, many components, should stay isolated), route back to the parent skill's `package-forge` path instead.

**Key principle:** Intake gets the real source in front of you and confirms what it actually does. Conversion translates without guessing.

---

# PART 1: INTAKE (Acquire and Vet)

## Where Pi Extensions Come From

Confirmed sources (see `pi/coding-agent/docs/extensions.md`, `pi/coding-agent/examples/extensions/`, and pi.dev/packages):

| Source | How to acquire | Notes |
|---|---|---|
| Local official examples | `pi/coding-agent/examples/extensions/` | Shortest path; read directly |
| npm package | `npm:<pkg>` | Inspect the published tarball, do not execute |
| git repo | `git:github.com/<owner>/<repo>` | Clone to temp read-only location, pin ref |

**Never run the extension** during intake. Treat it as untrusted code.

## Acquisition Steps

### 1. Read-Only Fetch

Get the extension to a temporary location with a pinned version/ref. Never execute it.

**Local examples:**
```bash
# Already on disk
ls pi/coding-agent/examples/extensions/<name>/
```

**npm package:**
```bash
npm pack <pkg>@<version> --dry-run  # inspect metadata
npm pack <pkg>@<version>            # download tarball
tar -tzf <pkg>-<version>.tgz        # list contents
tar -xzf <pkg>-<version>.tgz -C /tmp/<name>/  # extract to temp
```

**git repo:**
```bash
git clone --depth 1 <repo-url> /tmp/<name>
cd /tmp/<name>
git rev-parse HEAD  # record the commit SHA
```

### 2. Read the Entry Module

Pi extensions export a function that receives `ExtensionAPI`:

```typescript
export default function(pi: ExtensionAPI) {
  pi.registerTool({ name, parameters, execute });
  pi.on("tool_call", handler);
  // etc.
}
```

Read this function to enumerate all injection points.

### 3. Enumerate Injection Points

Map every `ExtensionAPI` call to a candidate harness primitive:

| Pi injection point | Candidate harness primitive |
|-------------------|----------------------------|
| `pi.registerTool({ name, parameters, execute })` | **Tool** |
| `pi.registerCommand(...)` | Usually not a primitive (Pi TUI surface) — re-express as Tool/Capability or drop |
| `pi.on("tool_call", ...)` gating/mutation | **Capability** (policy) |
| `pi.on("compact", ...)` summarization | **Capability** (compaction) |
| `pi.on("session_start", ...)` context/memory | **Capability** (context/memory) |
| System prompt / help / static text | **Resource** |

**One-of invariant reminder:** If the extension registers multiple tools + event hooks, that's **multiple components**, each needing its own Magnet.

### 4. Map Dependencies

List all imports and categorize:

- **Native TypeScript/JavaScript** → Can run in harness directly
- **Node built-ins** (`fs`, `path`, `child_process`) → OK, but watch for sandbox violations
- **External packages** → Check if they exist in harness's `package.json` or need to be added
- **Binaries/native modules** → Flag for process boundary or package-forge path
- **Heavy runtimes** (Python, Rust) → Route to package-forge

### 5. Security Review

Flag anything that:
- Opens network sockets or makes HTTP requests without user control
- Spawns processes (especially with user-supplied args)
- Writes to filesystem outside workspace
- Reads secrets or environment variables
- Uses `eval()` or dynamic code execution

Extensions that do these things aren't automatically rejected, but they must go through `runtime://process` sandbox + policy checks. Never bypass the shared process boundary.

### 6. Decide: Dissolve vs. Encapsulate

**Dissolve (this path):**
- Single clean primitive (one tool, one capability)
- Light dependencies (TypeScript + a few npm packages)
- No special runtime
- < 500 lines of code

**Encapsulate (route to package-forge):**
- Multiple components that belong together
- Heavy dependencies (Python + pixi, Rust crate, native binaries)
- Wants its own environment boundary
- Independent versioning/shipping

If encapsulate, hand off to the parent skill's `package-forge` sub-skill.

### 7. Record Provenance

Before moving to conversion, record:
- **Origin:** URL + pinned ref/version (e.g., `git:github.com/user/repo@abc123` or `npm:pkg@1.2.3`)
- **License:** MIT, Apache-2.0, etc.
- **Injection point inventory:** List of all `pi.registerTool`, `pi.on`, etc.
- **Safety findings:** Any flagged security concerns
- **Dissolve decision:** Confirmed this is a trunk integration

This travels with the artifact through conversion.

---

# PART 2: CONVERSION (Translate to Harness Primitives)

This is the heart of the Pi path: how we *connect* an extension and *convert* it. It assumes intake has already produced the injection-point inventory and the dissolve decision.

## The Translation Table (Full Reference)

| Pi injection point | Harness primitive | Magnet / wiring |
|---|---|---|
| `pi.registerTool({ name, parameters, execute })` | **Tool** | Real tool `HcpServer.ts` plus source-local `HcpMagnet.toTool()` |
| `pi.on("tool_call", ...)` gating/mutation | **Capability** (policy) | Source-local `policy/<source>/HcpMagnet.ts` plus `policy/HcpServer.ts` |
| `pi.on("compact"/summarization)` | **Capability** (compaction) | Source-local compaction `HcpMagnet` |
| `pi.on("session_start"/context)` | **Capability** (context/memory) | Matching capability slot |
| System prompt / help / static text | **Resource** | Content-only, `content_path`, no code builder |
| `pi.registerCommand(...)` | Usually **not a primitive** | Commands are Pi TUI surface; re-express as Tool/Capability or drop |

## Conversion Steps

### 1. Strip the ExtensionAPI Shell

The `export default function(pi) { ... }` wrapper is Pi runtime glue. We don't need it in the harness.

**Before (Pi extension):**
```typescript
export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "my-tool",
    parameters: {...},
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      // tool logic
    }
  });
}
```

**After (harness tool):**
```typescript
export async function executeMyTool(params: MyToolParams, context: ToolContext): Promise<ToolResult> {
  // tool logic (adapted)
}
```

### 2. Rebind Context

Pi's `execute` receives `(toolCallId, params, signal, onUpdate, ctx)` where `ctx` has:
- `ctx.cwd` — current working directory
- `ctx.ui` — UI prompts (interactive)
- `ctx.session` — session metadata

**Harness tools** are pure functions based on `cwd` binding. Replace:
- `ctx.cwd` → `context.cwd` (bound at Magnet creation)
- `ctx.ui` prompts → Remove or redesign (harness loop has no interactive TUI hook on tool hot path)
- `ctx.session` access → Use harness's capability system (memory, state management)

**Example transformation:**
```typescript
// Pi version
const userChoice = await ctx.ui.select("Choose an option", ["A", "B"]);

// Harness version (if user input is needed)
// Option 1: Make it a tool parameter (user provides upfront)
// Option 2: Return partial result + prompt for continuation
// Option 3: Drop the interactive part if not essential
```

### 3. Place and Rename

**Directory structure:**
```
HarnessComponentProtocol/tools/<name>/
├── <name>.toml            - Tool descriptor
├── HcpServer.ts           - Real tool module Server
└── pi/
    ├── HcpMagnet.ts       - Source connector
    └── <name>.ts          - Tool implementation
```

**Naming conventions:**
- Tool directory: `kebab-case-name`
- TypeScript module: `kebab-case-name.ts`
- Role exports: bare `class HcpServer` and `class HcpMagnet`
- Descriptor: `<name>.toml`

**The `source` directory is `pi`** because the code originated from Pi, even though Magenta did the integration.

### 4. Write the Tool Descriptor (.toml)

**For native tools (TypeScript):**
```toml
kind = "tool"
name = "my-tool"
description = "What this tool does and when to use it"
operation = "read"  # or "write" if it mutates state
read_only = false
destructive = false
version = "1.0.0"
tags = ["category", "keywords"]

[parameters]
type = "object"
required = ["param1"]

[parameters.properties.param1]
type = "string"
description = "What this parameter does"
```

**For process tools (needs runtime):**
```toml
kind = "process"
name = "my-tool"
description = "..."
command = "tools/my-tool/runtime/my-tool"
args = []
operation = "read"
# ... rest similar
```

**For capabilities:**
Add `[assumption]` blocks (see harness docs for details).

### 5. Wire the Magnet

**Native tool Magnet:**
```typescript
import { createNativeTool } from "../../native-tool.ts";
import { executeMyTool, myToolSchema } from "./my-tool.ts";

export class HcpMagnet {
  static readonly module = "tools/my-tool";
  static readonly kind = "tool";
  static readonly source = "pi";

  readonly kind = "native";
  readonly source = "pi";
  private readonly tool;

  constructor(cwd: string) {
    this.tool = createNativeTool({
      name: "my-tool",
      description: "...",
      parameters: myToolSchema,
      createExecute: () => executeMyTool,
    }, cwd);
  }

  toTool() {
    return this.tool;
  }
}
```

Keep the Magnet thin: source binding and one product only. All logic stays in
the execute function; management stays in the real `tools/my-tool/HcpServer.ts`.

### 6. Register in harness.toml

Add to `HarnessComponentProtocol/harness.toml`:

```toml
[[components]]
kind = "tool"
name = "my-tool"
source = "pi"  # NOT "magenta"
path = "tools/my-tool/my-tool.toml"
```

### 7. Gate

From `HarnessComponentProtocol/` run:

```bash
npm run generate:hcp-sources -- --check
npm run check:structure      # Enforces entity-tree roles
npm run build                # Must pass
npm test                     # No regressions
npm run inspect              # Confirm component resolves
```

`inspect` output should list the tool with no `capability_factory_missing` warnings.

---

## Common Conversion Traps

**Trap 1:** Treating a system-prompt contribution as a capability
- **Wrong:** Give it a `build` function and register as capability
- **Right:** It's a Resource; use `content_path`, no builder

**Trap 2:** Porting `ctx.ui` prompts verbatim
- **Problem:** Harness loop has no interactive TUI hook on tool hot path
- **Solution:** Redesign the interaction (make it a parameter, return continuation prompt, or drop if non-essential)

**Trap 3:** Making one built-in source Magnet produce multiple products
- **Problem:** Violates one-of invariant
- **Solution:** Split them — one Magnet per tool

**Trap 4:** Tagging the artifact `source = "magenta"`
- **Problem:** Code came from Pi, not Magenta
- **Solution:** Tag it `pi`; `magenta` is only for self-evo act itself

---

## Handoff from Intake to Conversion

When moving from intake to conversion, you should have:

- ✅ Pinned source location (URL + ref/version)
- ✅ Injection point inventory with tentative primitive per point
- ✅ Dependency/runtime classification (native TS vs. needs process)
- ✅ Safety findings
- ✅ Dissolve decision confirmed

With these in hand, proceed through conversion steps 1-7 above.

---

## Example Walkthrough

Let's say we're integrating a Pi extension called `markdown-to-slides` from npm:

### Intake Phase

1. **Fetch:** `npm pack markdown-to-slides@1.0.0`, extract to `/tmp/markdown-to-slides/`
2. **Read entry:** It registers one tool (`pi.registerTool({ name: "markdownToSlides", ... })`)
3. **Injection points:** Single tool registration
4. **Dependencies:** Node built-ins + `marked` package (already in harness)
5. **Security:** Writes .pptx files to user's workspace (OK, within workspace)
6. **Decision:** Dissolve (single clean primitive, light deps)
7. **Provenance:** `npm:markdown-to-slides@1.0.0`, MIT license

### Conversion Phase

1. **Strip API shell:** Extract the `execute` function logic
2. **Rebind context:** Replace `ctx.cwd` with `context.cwd`
3. **Place:** `HarnessComponentProtocol/tools/markdown-to-slides/pi/`
4. **Descriptor:** Write `markdown-to-slides.toml`
5. **Magnet:** `createMarkdownToSlidesMagnet` wrapping the execute function
6. **Register:** Add to `harness.toml` with `source = "pi"`
7. **Gate:** `npm run build && npm test && npm run check:structure`

Done! The tool is now available to Magenta.

---

## When to Route to Package-Forge Instead

If during intake you discover:
- Heavy runtime (Python + pixi, Rust crate, Go binary)
- Many components that should stay together
- Extension is actually a suite of related tools
- Needs independent versioning/shipping

**Stop the Pi path** and hand off to the parent skill's `package-forge` sub-skill. That path is designed for encapsulation rather than dissolution.

---

## Summary: The Complete Pi Path

**Intake:**
1. Read-only fetch from npm/git/local
2. Read entry module
3. Enumerate injection points
4. Map dependencies
5. Security review
6. Decide dissolve vs. encapsulate
7. Record provenance

**Conversion:**
1. Strip ExtensionAPI shell
2. Rebind context (ctx → harness context)
3. Place in `HarnessComponentProtocol/<module>/pi/` (or `tools/<name>/pi/`)
4. Write `.toml` descriptor
5. Add the real module Server and source-local Magnet
6. Register in `harness.toml` with `source = "pi"`
7. Gate with codegen, structure, build, test, and inspect

**Result:** The Pi extension is now a first-class harness primitive, fully integrated and ready to use.
