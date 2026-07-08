# Module Realignment — Final Recommendation

After deep investigation + adversarial review, I've found 4 viable paths. The user asked for bottom-up restructuring ("整体的代码都要改"), not cosmetic changes, so I'm presenting all options honestly.

---

## The 4 Approaches

### Alternative A: Metadata-Only (SAFEST, but cosmetic)

**What**: Keep 17 HcpServers registered as-is. Add a `describeModules()` grouping function that parses addresses to derive 13 module views.

**Changes**:
- NEW: `HcpClient.describeModules()` groups `describeAll()` results by module folder
- Registry: `buildHarnessModuleDescriptors` parses `component.path` for `modules/<folder>/`
- Menu: reads `describeModules()` instead of `describeAll()`, shows 13-module tree
- NO changes to: registration, routing, address strings, `instance()`, pi consumers

**Pros**: Zero risk, tests stay green, menu gets 13-module view  
**Cons**: Module is presentation-only, not a runtime entity; HCP internals unchanged

**User satisfaction**: Low. This is the "avoid the problem" path. User wants real alignment, not a facade.

---

### Alternative B: Contract Redesign (INVASIVE, true per-module servers)

**What**: Add routing parameter to `instance()`, consolidate to 13 per-module servers.

**Changes**:
- `hcp-server.ts`: `instance<T>(selector?: string): T | undefined`
- All 17+ magnets: update `toHcpServer()` to accept+ignore `selector`
- NEW: `ModuleHcpServer` class wrapping N magnets, routes via selector
- Registration: tools → 1 prefix server, capabilities → 13 exact servers with multi-magnet support
- Pi: `resolve("tool:read").instance()` → `resolve("tool").instance("read")` (10 call sites)

**Pros**: True per-module servers; clean 1-Client → 13-Servers → N-Magnets model; aligns runtime with conceptual model  
**Cons**: Contract breaking change, 300+ lines touched, 2+ weeks, harness+pi tests need updates

**User satisfaction**: High IF they accept the invasiveness. This is the "do it right" path.

---

### Alternative C: Hybrid (capabilities per-module, tools flat)

**What**: Wrap single-source capabilities in module servers, leave tools as 7 flat servers.

**Changes**:
- Capabilities (compaction/hooks/policy/...): wrap in `ModuleHcpServer` with 1 magnet each
- Tools: keep 7 `tool:<name>` byExact servers unchanged
- Menu: groups tools under "tools module" (metadata), capabilities are 1:1 with servers

**Pros**: Partial alignment without touching tools; no `instance()` routing needed (1 magnet per server)  
**Cons**: Asymmetric (tools != capabilities); doesn't achieve universal "1 module = 1 server"

**User satisfaction**: Medium. Compromises the clean model for pragmatism.

---

### Alternative D: Facade Servers (CLEVER, invisible consolidation)

**What**: Keep 17 addresses registered, but each is a thin facade delegating to an underlying `ModuleHcpServer`. Consumers see 17 servers; HCP assembly sees 13 modules.

**Changes**:
- NEW: `ModuleHcpServer` class holds magnets, provides `getMagnet(toolName)`, `describeTool(toolName)`
- Registration: create 13 ModuleHcpServer instances, then register 17 facade servers:
  ```typescript
  const toolsModule = new ModuleHcpServer({ module: "tools", magnets: [...] });
  byExact["tool:read"] = {
    describe: () => ({...toolsModule.describeTool("read"), module: "tools"}),
    dispatch: (call) => toolsModule.dispatchToTool("read", call),
    instance: () => toolsModule.getMagnet("read").instance(),  // No param!
  };
  // Repeat for bash, edit, ...
  ```
- Menu: reads facade metadata `{module: "tools"}`, groups the 7 into "tools module"
- Pi: unchanged (`resolve("tool:read").instance()` still works)

**Pros**:
- ✅ Zero breaking changes (addresses, `instance()` signature, pi call sites unchanged)
- ✅ `describeAll()` returns 17 entries (menu/UI work as-is)
- ✅ Internally, 13 ModuleHcpServer instances exist (runtime alignment)
- ✅ Tests stay green (external behavior identical)
- ✅ Menu can group by reading facade metadata

**Cons**:
- Adds indirection (17 facades + 13 underlying modules = 30 objects)
- Module is semi-hidden (exists but wrapped)
- More complex assembly code

**User satisfaction**: High. Achieves runtime alignment without breaking anything. The "clever" path.

---

## Direct Comparison

| Criterion | A (Metadata) | B (Contract) | C (Hybrid) | D (Facade) |
|-----------|--------------|--------------|------------|------------|
| Module = runtime entity | ❌ No | ✅ Yes | ⚠️ Partial | ✅ Yes (hidden) |
| Addresses stay stable | ✅ Yes | ❌ No | ✅ Yes | ✅ Yes |
| `instance()` unchanged | ✅ Yes | ❌ No | ✅ Yes | ✅ Yes |
| Pi call sites unchanged | ✅ Yes | ❌ No | ✅ Yes | ✅ Yes |
| Tests stay green | ✅ Yes | ❌ No | ⚠️ Mostly | ✅ Yes |
| Menu shows 13 modules | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes |
| Conceptual clean | ❌ Facade only | ✅ Pure | ⚠️ Mixed | ⚠️ Clever |
| Implementation effort | 1 week | 3-4 weeks | 2 weeks | 2 weeks |
| Risk | Zero | High | Low-Med | Low |

---

## My Recommendation: **Alternative D (Facade)**

**Why**: The user wants real restructuring ("整体的代码都要改"), but Alternatives B/C have real costs (breaking changes, test churn, or asymmetry). Alternative A is too cosmetic.

**Alternative D gives you both**:
- Runtime alignment: 13 ModuleHcpServer instances actually exist in memory, holding magnets
- Zero breakage: facades preserve all 17 addresses, `instance()` signature, pi call sites
- Clean evolution: if you later want to expose modules directly (Alternative B), you already have the ModuleHcpServer class; you just unwrap the facades

**It's the "prepare the foundation without breaking the surface" path.**

---

## What Alternative D Actually Looks Like (Implementation Sketch)

### Step 1: `ModuleHcpServer` class (new, in `hcp-magnet/module-server.ts`)

```typescript
export class ModuleHcpServer {
  constructor(
    readonly module: string,  // "tools", "compaction", ...
    readonly magnets: Map<string, HcpMagnet>,  // "read" → readMagnet, "bash" → bashMagnet
    readonly defaultMagnet?: HcpMagnet,
  ) {}

  getMagnet(name: string): HcpMagnet | undefined {
    return this.magnets.get(name) ?? this.defaultMagnet;
  }

  describeTool(toolName: string): HcpServerDescription {
    const magnet = this.getMagnet(toolName);
    if (!magnet) throw new Error(`${this.module}: no magnet for ${toolName}`);
    const desc = magnet.toHcpServer().describe();
    return { ...desc, metadata: { ...desc.metadata, module: this.module } };
  }

  dispatchToTool(toolName: string, call: HcpRequest): unknown {
    const magnet = this.getMagnet(toolName);
    if (!magnet) throw new Error(`${this.module}: no magnet for ${toolName}`);
    return magnet.toHcpServer().dispatch(call);
  }
}
```

### Step 2: Assembly (modify `session-hcp.ts`)

```typescript
// Build the 13 module coordinators
const toolsModule = new ModuleHcpServer("tools", new Map([
  ["read", readMagnet],
  ["bash", bashMagnet],
  ["edit", editMagnet],
  // ... 7 total
]));

const compactionModule = new ModuleHcpServer("compaction", new Map([
  ["pi", compactionPiMagnet],
]));

// ... 13 modules total

// Register facades (17 addresses, each delegates to its module)
for (const toolName of ["read", "bash", "edit", "write", "grep", "find", "ls"]) {
  sessionHcp.registerExact(`tool:${toolName}`, {
    describe: () => toolsModule.describeTool(toolName),
    dispatch: (call) => toolsModule.dispatchToTool(toolName, call),
    instance: () => toolsModule.getMagnet(toolName)?.toHcpServer().instance(),
  });
}

sessionHcp.registerExact("capability:compaction", {
  describe: () => compactionModule.describeTool("pi"),  // Single-magnet module
  dispatch: (call) => compactionModule.dispatchToTool("pi", call),
  instance: () => compactionModule.getMagnet("pi")?.toHcpServer().instance(),
});

// ... repeat for 11 capabilities
```

### Step 3: Menu (read metadata, group by module)

```typescript
const descriptions = hcp.describeAll();  // Still returns 17 entries
const byModule = new Map<string, HcpServerDescription[]>();
for (const desc of descriptions) {
  const module = desc.metadata?.module ?? "unknown";
  const group = byModule.get(module) ?? [];
  group.push(desc);
  byModule.set(module, group);
}

// Now byModule has:
// "tools" → [tool:read, tool:bash, tool:edit, ...]  (7 entries)
// "compaction" → [capability:compaction]            (1 entry)
// ...

// Menu shows: Modules (13) → tools (7) → read/bash/edit/...
```

---

## Phases for Alternative D (if approved)

1. **Phase 0**: Write `ModuleHcpServer` class + unit tests (routing, describe, dispatch)
2. **Phase 1**: Implement tools module (7 facades → 1 coordinator). Verify pi tools work.
3. **Phase 2**: Implement single-magnet capabilities (compaction, hooks, ...). 10 facades → 10 coordinators.
4. **Phase 3**: Implement runtime (2 facades → 1 coordinator with 2 slots).
5. **Phase 4**: Update menu to read `metadata.module`, group by module.
6. **Phase 5**: Update registry `buildHarnessModuleDescriptors` to derive from component.path.

Each phase is independently testable; harness 353 + pi 1636 stay green throughout.

---

## Open to User

You said "整体的代码都要改" and "重构就重构". I've given you 4 options:

- **A (Metadata)**: Changes only presentation, HCP internals untouched. Safest but least aligned with your vision.
- **B (Contract Redesign)**: True per-module servers, changes `instance()` signature. Most aligned but most invasive.
- **C (Hybrid)**: Capabilities per-module, tools flat. Pragmatic compromise.
- **D (Facade)**: 13 module coordinators exist internally, 17 facades preserve external API. Clever middle ground.

I recommend **D** because it gives you the runtime restructuring you want without the breakage of B. But if you insist on pure conceptual cleanliness and accept the 3-4 week invasive refactor, **B** is the "do it right" path.

Which one do you want? Or do you want me to write detailed contracts for both B and D so you can compare before deciding?
