# Assembly Layer

The **assembly layer** is where components are discovered, adapted, and wired together at startup. It consists of three modules working in concert:

- **Registry** — Discovers available components from TOML files
- **Magnet** — Adapts implementations into uniform interfaces
- **HCP** — Manages component lifecycle and configuration

---

## Understanding the Assembly Process

Think of it like a **power supply system**:

```
📦 Products (Harness Tools)     🔌 Power Outlet (Agent Loop)
    bash, read, edit...              LLM-driven execution
         ↓                                    ↑
    📋 Registry                               |
    (Product Manual)                          |
    "Here's what's available"                 |
         ↓                                    |
    🧲 Magnet                                 |
    (Data Cable)                              |
    One end connects to products,             |
    the other provides standard interface     |
         ↓                                    |
    🔄 HCP                                    |
    (Universal Adapter)                       |
    Unified management layer                  |
         ↓────────────────────────────────────┘
```

**Key insight**: The adapter (HCP) is only used during setup. At runtime, the Agent Loop calls tools directly — like electricity flowing from outlet to device without passing through the adapter again.

---

## The Three Modules

### 📋 Registry (Product Manual)

**What it does**: Scans the harness directory and discovers all available components.

**Startup flow**:
```
1. Read harness/harness.toml (index file)
2. Find 18 component declarations
3. Load each component's TOML file (bash.toml, read.toml, ...)
4. Return ComponentDescriptor array
```

**Example**:
```typescript
const registry = await loadRegistry("/path/to/harness.toml");

console.log(registry.components);
// [
//   { kind: "tool", name: "bash", path: "tools/bash/bash.toml", spec: {...} },
//   { kind: "tool", name: "read", path: "tools/read/read.toml", spec: {...} },
//   { kind: "skill", name: "skills", path: "skills/skills.toml", spec: {...} },
//   ...
// ]
```

**Analogy**: Like a restaurant menu listing all available dishes.

---

### 🧲 Magnet (Data Cable)

**What it does**: Connects products (tool implementations) to the system by wrapping them in uniform interfaces.

**The adapter pattern**:
```typescript
// Magnet = data cable with two ends
const magnet = new NativeMagnet({
  name: "read",
  execute: createReadExecute(cwd),  // ← This end connects to the product
  schema: readSchema
});

// The other end provides two interfaces:
const agentTool = magnet.toTool();       // → Standard interface for Agent Loop
const hcpTarget = magnet.toHcpTarget();  // → Management interface for HCP
```

**Why "Magnet"?**

Like a magnet attracting metal, it **attracts implementations** into the harness regardless of their source:
- Today: **NativeMagnet** wraps TypeScript tools
- Future: **McpMagnet** wraps MCP tools
- Future: **RustMagnet** wraps Rust tools
- Future: **RemoteMagnet** wraps HTTP/RPC tools

**Key feature**: Dual interface output
- `toTool()` → Execution interface (for direct calls)
- `toHcpTarget()` → Management interface (for discovery/configuration)

**Analogy**: Like a data cable connecting different devices (USB-C, Lightning, Micro-USB) to a universal port.

---

### 🔄 HCP (Universal Adapter)

**What it does**: Provides a unified management layer for component discovery and configuration.

**Design principle**: **HCP is NOT on the execution hot path.**

```
❌ Wrong understanding:
Agent Loop → HCP → tool.execute()
           (slow, with middleware)

✅ Correct understanding:
Startup: HCP manages components
Runtime: Agent Loop → tool.execute() (direct call, fast)
```

**Usage**:
```typescript
const hcp = new HcpRegistry();

// Register magnet management endpoints
hcp.register("tool", bashMagnet.toHcpTarget());
hcp.register("tool", readMagnet.toHcpTarget());

// Unified management interface
await hcp.dispatch({
  target: "tool:read",
  op: "describe"  // Query what this tool does
});

await hcp.dispatch({
  target: "tool:bash",
  op: "configure",  // Configure this tool
  input: { timeout: 30000 }
});
```

**HCP operations**:
- `describe` — Component self-description
- `configure` — Modify settings
- `enable` / `disable` — Toggle availability

**Analogy**: Like a universal power adapter that helps you plug in devices, but once plugged, electricity flows directly without going through the adapter.

---

## How They Work Together

### 🛠️ Startup (Assembly Time)

**The three modules orchestrate component assembly**:

```
1. Registry reads the manual
   ↓
   "I found bash, read, edit, grep, find, ls, write"
   
2. Magnet creates data cables
   ↓
   NativeMagnet.wrap(bashExecute) → AgentTool
   NativeMagnet.wrap(readExecute) → AgentTool
   ...
   
3. HCP registers management endpoints
   ↓
   hcp.register("tool:bash", bashTarget)
   hcp.register("tool:read", readTarget)
   
4. Agent Loop gets tool list
   ↓
   loop.setTools([bashTool, readTool, editTool, ...])
```

### 🚀 Runtime (Execution Time)

**Direct connection, no middleware**:

```
User input
   ↓
Agent decides: "Need to read a file"
   ↓
Direct call: readTool.execute("/path/to/file")
   ↓
Return result

(HCP, Magnet, Registry are NOT involved)
```

**Why the separation?**

- **Fast execution**: In-process function calls, no RPC, no serialization
- **Flexible assembly**: Can dynamically discover and configure components
- **Best of both worlds**: Extensibility without sacrificing performance

---

## Example: Adding a New MCP Tool

```typescript
// 1. Product arrives (MCP tool implementation)
const mcpTool = new McpClient("http://localhost:3000/database");

// 2. Create data cable (Magnet)
const mcpMagnet = new McpMagnet({
  client: mcpTool,
  toolName: "query-database"
});

// 3. One end connects to product
const agentTool = mcpMagnet.toTool();      // Execution interface
const hcpTarget = mcpMagnet.toHcpTarget(); // Management interface

// 4. Management end plugs into adapter (HCP)
hcp.register("tool:database", hcpTarget);

// 5. Execution end connects directly to Agent
loop.addTool(agentTool);

// 6. At runtime (direct connection, no HCP)
await agentTool.execute({
  query: "SELECT * FROM users"
});
```

---

## Directory Structure

```
harness/assembly/
  hcp/
    hcp.toml
    pi/
      hcp.ts           — HcpRegistry, HcpTarget, HcpCall
    README.md
  
  magnet/
    magnet.toml
    pi/
      magnet.ts        — Magnet interface
      native.ts        — NativeMagnet implementation
    README.md
  
  registry/
    registry.toml
    pi/
      registry.ts      — loadRegistry(), ComponentDescriptor
    README.md
  
  README.md            — This file
```

---

## Why This Design?

### Without the Assembly Layer (Hard-coded)

```typescript
const loop = new AgentLoop();
loop.addTool(createBashTool(cwd));
loop.addTool(createReadTool(cwd));
loop.addTool(createEditTool(cwd));
// Adding new tools → must change code
```

### With the Assembly Layer (Declarative)

```typescript
const registry = await loadRegistry("harness.toml");  // Registry
const magnets = registry.components.map(comp => 
  createMagnet(comp)                                  // Magnet
);
const tools = magnets.map(m => m.toTool());
magnets.forEach(m => hcp.register(m.toHcpTarget()));  // HCP
loop.setTools(tools);

// Adding new tools → just add TOML declaration
```

### Benefits

1. **Extensible**: Add tools without code changes (just TOML)
2. **Pluggable**: Dynamically enable/disable components
3. **Multi-source**: TypeScript, MCP, Rust tools share the same mechanism
4. **No performance cost**: Assembly runs once at startup, execution is direct

---

## Registration

All three modules are registered in `harness/harness.toml`:

```toml
[[components]]
kind = "assembly"
name = "hcp"
path = "assembly/hcp/hcp.toml"

[[components]]
kind = "assembly"
name = "magnet"
path = "assembly/magnet/magnet.toml"

[[components]]
kind = "assembly"
name = "registry"
path = "assembly/registry/registry.toml"
```

---

## Public API

```typescript
// Registry
import { loadRegistry, ComponentDescriptor, Registry } from "@magenta/harness";

// Magnet
import { Magnet, NativeMagnet } from "@magenta/harness";

// HCP
import { HcpRegistry, HcpTarget, HcpCall, HcpContext } from "@magenta/harness";
```

---

## Key Takeaways

1. **Assembly ≠ Execution**: These modules run at startup, not during tool execution
2. **Direct calls at runtime**: Agent Loop → tool.execute() with no middleware
3. **Unified interface**: All tools (TypeScript/MCP/Rust) expose the same AgentTool interface
4. **Declarative discovery**: Add components by editing TOML, not code

The assembly layer is the **wiring infrastructure** that makes the harness extensible without sacrificing execution speed.
