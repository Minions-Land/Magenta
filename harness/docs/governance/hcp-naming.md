# HCP Naming Convention

Date: 2026-07-08  
Status: **AUTHORITATIVE.** This is the single source of truth for HCP naming.

This document upgrades and supersedes the naming section (§2) in `hcp-architecture.md`. It establishes the iron law that governs all HCP-related naming in the Magenta3 codebase.

---

## 0. The Iron Law — Naming Hierarchy = Entity Tree

**Every capital letter starts a new abstraction level, and each level must correspond to a real entity (an actual thing in the code). The naming hierarchy = the entity ownership structure in code, one-to-one, with no phantom levels.**

- **Level 1**: `Hcp` — always, mandatory, unique.
- **Level 2**: Exactly three roles — `Client` / `Server` / `Magnet`. **No fourth role allowed.**
- **Level 3+**: Each additional capital letter must have a corresponding parent entity.

**No-gap rule:**
- A four-level name like `HcpClientCapabilityPrefix` is legal ⟺ the three-level entity `HcpClientCapability` actually exists (and `HcpClient` exists).
- If an intermediate entity **does not exist**, subsequent modifiers stay **lowercase**.
  - Example: `HcpClient` exists but there's no `HcpClientCapability` entity → the capability address prefix constant must be named **`HcpClientcapabilityprefix`** (all lowercase after `Client`, because neither `capability` nor `prefix` are entities).
- **Everything Hcp-related or helping Hcp must have the `Hcp` prefix.** No escape hatch.

> In one sentence: Capital-letter breaks aren't word parsing—they declare "I have a real parent node in the entity tree." How many capitals = how many real entities must exist.

Derived iron laws:
- **Three roles only**: Client (initiator/router, unique), Server (capability endpoint, one per module), Magnet (source connector).
- **Name = role, path = identity**. All source magnets are named `HcpMagnet`, all module servers are named `HcpServer`; identity comes from the `modules/<module>/<source>/` path.
- **No `contract/` layer**, no interfaces (see implementation notes below).
- **Common logic belongs in HcpClient**; each `HcpServer` keeps only its unique parts.

---

## 1. Data Types Must Follow the Iron Law Too

HCP data types (requests, responses, descriptions, contexts, resources, etc.) are **Hcp-related**, so: level 2 must be a role, and breaks must match entities. They're not "roles" themselves but rather **the communication surface or artifacts of a role**, so they hang under **the role that produces or uses them**, as that role entity's level-3 sub-concept.

### Protocol data → hang under `Server`
(They describe "how to communicate with a Server"—unified under the Server communication surface, not split):
- `HcpServerDescription` (already legal, the template)
- `HcpRequest` → `HcpServerRequest`
- `HcpResponse` → `HcpServerResponse`
- `HcpContext` → `HcpServerContext`

### Magnet artifacts → hang under `Magnet`
- `HcpResource` → `HcpMagnetResource`
- `CapabilityBinding` → `HcpMagnetBinding`
- `CapabilityFactoryContext` (build context) → `HcpMagnetBuildContext`
- `ResourceMergeMode` → `HcpMagnetResourceMergeMode`

### Constants (no intermediate entity → lowercase tail)
- `capabilityPrefix` (value `"capability"` unchanged) → `HcpClientcapabilityprefix`

> Note: `HcpClientcapabilityprefix` looks awkward—that's the **correct result** of the rule, honestly reflecting "no Capability entity under Client." If we ever create an `HcpClientCapability` entity, then upgrade to `HcpClientCapabilityPrefix`.

---

## 2. Complete Rename Table

### Files / Structure

| Before | After | Type |
|--------|-------|------|
| `hcp-client/hcp-client.ts` | `hcp-client/HcpClient.ts` | File |
| `hcp-client/contract/hcp-server.ts` | Content moved up, delete contract/ | File |
| `hcp-client/contract/hcp-magnet.ts` | Content moved up, delete contract/ | File |
| `hcp-client/server/module-server.ts` | Logic folded into HcpClient, file deleted | File |
| `hcp-client/server/capability-server.ts` | Logic folded into HcpClient, file deleted | File |
| `createCapabilityServer()` | **Deleted** (logic into HcpClient) | Function |
| `modules/<m>/<s>/magnet.ts` | `modules/<m>/<s>/HcpMagnet.ts`, exports bare `class HcpMagnet` | File+export |
| (new) | `modules/<m>/HcpServer.ts`, exports bare `class HcpServer` | File+export |

### Type Renames — All follow the iron law (level 2 = role, breaks = entities)

**Protocol data → Server:**

| Before | After | Usage |
|--------|-------|-------|
| `HcpRequest` | `HcpServerRequest` | 26 |
| `HcpResponse` | `HcpServerResponse` | 1 |
| `HcpContext` | `HcpServerContext` | 2 |
| `HcpServerDescription` | (unchanged, already legal) | 23 |

**Magnet artifacts → Magnet:**

| Before | After | Usage |
|--------|-------|-------|
| `HcpResource` | `HcpMagnetResource` | 7 |
| `CapabilityBinding` | `HcpMagnetBinding` | — |
| `CapabilityFactoryContext` | `HcpMagnetBuildContext` | — |
| `ResourceMergeMode` | `HcpMagnetResourceMergeMode` | — |

**Constants (no Capability entity → lowercase tail):**

| Before | After | Note |
|--------|-------|------|
| `capabilityPrefix` (value `"capability"` unchanged) | `HcpClientcapabilityprefix` | Lowercase after Client because no entity |

**A-class: word-order corrections (level 3 wrongly inserted before level 2, all belong to Magnet):**

| Before | After | Usage |
|--------|-------|-------|
| `HcpProcessMagnet` | `HcpMagnetProcess` | 5 |
| `HcpProcessMagnetOptions` | `HcpMagnetProcessOptions` | 2 |
| `HcpProcessManifest` | `HcpMagnetProcessManifest` | 9 |
| `HcpJsonlRequest` | `HcpMagnetJsonlRequest` | 5 |
| `HcpJsonlResponse` | `HcpMagnetJsonlResponse` | 3 |

Rule: `Hcp` (level 1) + `Magnet` (level 2) + `Process`/`Jsonl…` (level 3). Level 2 must immediately follow level 1.

**Legal, unchanged role names:**  
`HcpClient` / `HcpServer` / `HcpMagnet` / `HcpServerDescription`

---

## 3. Implementation Notes

### TypeScript Mechanics (No Interfaces, Bare Classes)

- Module/source files export **bare `class`**: `export class HcpServer {…}` / `export class HcpMagnet {…}`, **no implements, no import of any interface**.
- **No `interface HcpServer` / `interface HcpMagnet` anywhere.** The entire codebase has no "interface" concept, only classes.
- Shape correctness relies on TypeScript's structural typing: wrong shape → compile error when calling that method.
- No separate interface gate.
- No `contract/` layer.

**Eliminated concepts**: contract layer, interface HcpServer, interface HcpMagnet, createCapabilityServer, ModuleHcpServer.

### Assembly Layer Collection (Same-Name Classes)

**Problem**: every module's `HcpServer.ts` exports `class HcpServer`, every source's `HcpMagnet.ts` exports `class HcpMagnet`. Assembly layer must collect dozens of same-name classes.

**Solution: Namespace imports (approach 1) + codegen from toml (path A)**

1. **Single source of truth**: `harness.toml` and each module's `<module>.toml` already register all modules/sources (`kind`/`name`/`source`/`impl` paths).
2. **Build-time codegen**: A script reads the toml registry and auto-generates an assembly file (e.g., `hcp-client/assembly/sources.generated.ts`) containing:
   ```typescript
   // Auto-generated from harness.toml, do not hand-edit
   import * as runtime from "../../modules/runtime/HcpServer.ts";
   import * as memory from "../../modules/memory/HcpServer.ts";
   // …one line per module
   
   export const HCP_SERVERS = [
     runtime.HcpServer,
     memory.HcpServer,
     // …
   ];
   
   import * as runtimeMagenta from "../../modules/runtime/magenta/HcpMagnet.ts";
   import * as memoryMagenta from "../../modules/memory/magenta/HcpMagnet.ts";
   // …one line per source
   
   export const HCP_MAGNETS = [
     runtimeMagenta.HcpMagnet,
     memoryMagenta.HcpMagnet,
     // …
   ];
   ```
3. **Assembly layer** (`capability.ts` / `session-hcp.ts`) imports only these two arrays, iterates and registers, never touches specific modules.
4. **Adding a module workflow**: edit toml only → run build (auto codegen) → compile. Zero hand-written lists.
5. **Satisfies build constraints**: generated code is static imports, not dynamic `import(variable)`, so compiles to dist/bun.

**Why this isn't a "new concept" (iron-law sense)**:
- Codegen script is a **build tool**, not a fourth HCP role (like the TypeScript compiler itself—tool, not concept).
- Generated code contains only Client/Server/Magnet entities; `import * as` is TS syntax, not our concept.
- The toml registry already existed, not newly introduced.

---

## 4. Quick Reference for Developers

When adding a new HCP-related name, apply these checks:

1. **Does it help or relate to HCP?** → Must have `Hcp` prefix.
2. **What's the level-2 word?** → Must be `Client`, `Server`, or `Magnet` (the only three roles).
3. **Each capital letter after `Hcp<Role>`** → Must have a parent entity in code.
   - If you write `HcpServerRequestValidator`, there must exist an `HcpServerRequest` entity (a class/interface/type), and an `HcpServer` entity.
   - If `Request` exists but `Validator` doesn't exist as an entity, write `HcpServerRequestvalidator` (lowercase `validator`).
4. **Protocol data (requests, responses, contexts)?** → Hang under `Server` (e.g., `HcpServerRequest`).
5. **Magnet artifacts (resources, bindings)?** → Hang under `Magnet` (e.g., `HcpMagnetResource`).

**Examples**:
- ✅ `HcpServerRequest` — Server (role) + Request (entity, protocol data)
- ✅ `HcpMagnetProcess` — Magnet (role) + Process (entity, identity)
- ✅ `HcpClientcapabilityprefix` — Client exists, capability/prefix don't → lowercase
- ❌ `HcpRequest` — missing role at level 2
- ❌ `HcpProcessMagnet` — level 3 (Process) wrongly before level 2 (Magnet)
- ❌ `RequestHcp` — Hcp must be level 1

---

## 5. Enforcement

### Automated (tools do what they can)

**ESLint**:
- `unicorn/filename-case`: enforce PascalCase file names (HcpClient.ts / HcpServer.ts / HcpMagnet.ts).
- Custom rule: exports under `hcp-client/` and `modules/` must have `Hcp` prefix (AST scan of export declarations).

**`scripts/check-structure.mjs`** (extend existing script):
- Every `modules/<module>/` must have `HcpServer.ts`.
- Every `modules/<module>/<source>/` must have `HcpMagnet.ts`.
- (Optional) Check file exports a class named `HcpServer`/`HcpMagnet` (simple regex, catches "right file name, wrong class name").

**Build codegen (§2.1)**:
- Auto-generates sources from toml, making toml the single source of truth—no "inconsistency" possible.

Enter CI / pre-commit hooks; violations blocked.

### Manual (tools can't do, rely on code review)

The following rules require semantic understanding, so tools can't reliably check them. They're confirmed during code review:

- **Level 2 must be Client/Server/Magnet** (judging "is it an entity" needs semantics).
- **Four-level → three-level entity must exist** (cross-file semantic analysis, too heavy for ESLint).
- **Data type should hang under which role** (needs business-logic understanding).

> Pragmatic principle: tools catch 80% of low-level mistakes (file names/prefixes/file existence); the remaining 20% (entity-tree consistency) is design-level and should be human-reviewed anyway. The iron law is clear enough that violations are obvious at review time.

---

## See Also

- **Architecture decisions**: `docs/governance/hcp-architecture.md` (why HCP exists, protocol design, transport layering)
- **Developer quickstart**: `docs/DEVELOPING.md` (task-oriented guide, includes HCP naming quick-reference)
- **Refactor spec**: `.tmp/HCP重构规范-冻结.md` (complete execution plan for the 2026-07-08 refactor)
