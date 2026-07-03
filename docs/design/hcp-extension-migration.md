# HCP/Magnet 完全取代 PI Extension 的设计方案

> Archived note (2026-07-03): this was an early design proposal. The final migration kept UX/session/TUI features in `pi/`, moved reusable execution capabilities such as `todo` and `ssh` into Harness tools, and removed the bundled extension registry. See `extension-migration-progress.md` and `RETIRE_EXTENSIONS_TODO.md` for the current state.

## 目标

**完全废弃 PI 的 Extension 机制，用 HCP + Magnet 统一所有扩展能力**

---

## 核心原则

### 1. HCP 只有一个（单例 Registry）
- HCP 是**协议**，不是实现
- `HcpRegistry` 是全局唯一的组件发现和管理中心
- 所有能力通过 HCP 注册和发现

### 2. Magnet 可以有多种（适配器模式）
- `NativeMagnet` - TypeScript 原生工具
- `ProcessToolMagnet` - Rust/进程工具
- `HcpProcessMagnet` - HCP JSONL 进程
- **ExtensionMagnet** - 新增：包装旧 PI Extension（过渡期）
- `McpMagnet` - 未来：MCP 工具

### 3. 统一的生命周期
```
启动时（Assembly）:
  Registry 扫描 → Magnet 适配 → HCP 注册

运行时（Hot Path）:
  Agent Loop → tool.execute() (直接调用，零开销)
```

---

## 架构设计

### Phase 1: ExtensionMagnet - 适配旧 Extension

#### 为什么需要 ExtensionMagnet？

**问题：** 7 个 bundled extensions 使用了 PI ExtensionAPI 的复杂能力：
- `pi.on("tool_call")` - 事件拦截
- `pi.registerTool()` - 动态注册工具
- `pi.registerCommand()` - 注册命令
- `ctx.ui.confirm()` - 用户交互
- `ctx.sendMessage()` - 运行时通信

**解决方案：** 创建 ExtensionMagnet 作为**桥接层**，让旧 extension 能在 HCP 下工作

#### ExtensionMagnet 接口设计

```typescript
// harness/assembly/magnet/pi/extension.ts

export interface ExtensionSpec {
  name: string;
  path: string;
  module: (api: ExtensionAPI) => void;
}

export class ExtensionMagnet implements Magnet {
  readonly kind = "pi-extension";
  
  private extension: LoadedExtension;
  private tools: Map<string, AgentTool>;
  private commands: Map<string, CommandHandler>;
  private handlers: Map<string, EventHandler[]>;
  
  constructor(spec: ExtensionSpec, context: ExtensionMagnetContext) {
    // 加载 extension，收集 registerTool/registerCommand 调用
    this.extension = this.loadExtension(spec, context);
  }
  
  // 给 Agent Loop 用：返回所有注册的工具
  toTool?(): AgentTool[] {
    return Array.from(this.tools.values());
  }
  
  // 给 HCP 用：暴露管理接口
  toHcpTarget(): HcpTarget {
    return {
      describe: () => ({
        target: `extension:${this.spec.name}`,
        kind: "extension",
        ops: ["describe", "listTools", "listCommands", "listHandlers", "invoke"],
        metadata: {
          tools: Array.from(this.tools.keys()),
          commands: Array.from(this.commands.keys()),
          handlers: Array.from(this.handlers.keys())
        }
      }),
      call: (hcpCall) => {
        switch (hcpCall.op) {
          case "listTools": return Array.from(this.tools.keys());
          case "listCommands": return Array.from(this.commands.keys());
          case "invoke": return this.invokeHandler(hcpCall.input);
          // ...
        }
      }
    };
  }
  
  private loadExtension(spec: ExtensionSpec, context: ExtensionMagnetContext) {
    // 创建 ExtensionAPI 的桥接实现
    const api: ExtensionAPI = {
      registerTool: (tool) => {
        this.tools.set(tool.name, this.convertToolDefinitionToAgentTool(tool));
      },
      registerCommand: (name, handler) => {
        this.commands.set(name, handler);
      },
      on: (event, handler) => {
        const list = this.handlers.get(event) ?? [];
        list.push(handler);
        this.handlers.set(event, list);
      },
      // ... 其他 ExtensionAPI 方法
    };
    
    // 调用 extension 函数，让它注册能力
    spec.module(api);
    
    return { tools: this.tools, commands: this.commands, handlers: this.handlers };
  }
}
```

#### 关键点：事件系统的桥接

**问题：** Extensions 依赖事件拦截（`pi.on("tool_call")`），但 HCP 不在热路径上。

**解决方案：** ExtensionMagnet 需要在 Agent Loop 里注入事件分发

```typescript
// pi/agent/src/agent-harness.ts
export class AgentHarness {
  private extensionMagnets: ExtensionMagnet[] = [];
  
  async executeToolCall(toolCall: ToolCall) {
    // 1. 事件前置拦截
    for (const magnet of this.extensionMagnets) {
      const block = await magnet.dispatchEvent("tool_call", { toolCall });
      if (block) return block;
    }
    
    // 2. 实际执行工具
    const result = await tool.execute(...);
    
    // 3. 事件后置通知
    await magnet.dispatchEvent("tool_result", { result });
    
    return result;
  }
}
```

---

### Phase 2: 迁移 Bundled Extensions

#### 2.1 分析每个 extension 的能力

##### background-events
- **工具：** `bg_shell`, `sub_agent`
- **命令：** `/events`
- **事件：** 无拦截，只有通知
- **迁移策略：** 直接转成 NativeMagnet

##### todo
- **工具：** `todo`
- **命令：** `/todos`
- **迁移策略：** NativeMagnet

##### command-aliases
- **命令：** `/exit` → `/quit`
- **迁移策略：** 命令映射系统（不需要 Magnet）

##### local-credential-bridge
- **能力：** OAuth 凭证管理
- **事件：** `session_start` 注入 credentials
- **迁移策略：** 新的 HCP target `credential:*`

##### ssh
- **能力：** SSH 连接管理
- **迁移策略：** NativeMagnet

##### side-chat
- **命令：** `/side`, `/btw`, `/s`
- **能力：** 并行对话
- **迁移策略：** NativeMagnet + 命令

##### ui-optimize
- **能力：** UI 渲染优化
- **事件：** 拦截工具结果，优化显示
- **迁移策略：** HCP hook system

#### 2.2 迁移优先级

**第一批（简单，无事件依赖）：**
1. `todo` → `harness/tools/todo/`
2. `command-aliases` → 内置命令映射
3. `ssh` → `harness/tools/ssh/`

**第二批（中等复杂度）：**
4. `background-events` → `harness/tools/bg-shell/`, `harness/tools/sub-agent/`
5. `side-chat` → `harness/tools/side-chat/`

**第三批（需要新 HCP 能力）：**
6. `local-credential-bridge` → HCP credential provider
7. `ui-optimize` → HCP rendering hook

---

### Phase 3: 新的 HCP 能力设计

#### 3.1 HCP Hook System

**问题：** Extensions 需要拦截和修改行为（如 `ui-optimize`）

**设计：** HCP Hook Target

```typescript
// harness/assembly/hcp/pi/hooks.ts

export interface HcpHook {
  event: string;  // "tool_call", "tool_result", "message_render"
  priority: number;
  handler: (payload: unknown) => Promise<HookResult>;
}

export interface HookResult {
  block?: boolean;
  transform?: unknown;
  metadata?: Record<string, unknown>;
}

export class HcpHookRegistry implements HcpTarget {
  private hooks = new Map<string, HcpHook[]>();
  
  register(hook: HcpHook) {
    const list = this.hooks.get(hook.event) ?? [];
    list.push(hook);
    list.sort((a, b) => a.priority - b.priority);
    this.hooks.set(hook.event, list);
  }
  
  async dispatch(event: string, payload: unknown): Promise<HookResult> {
    const hooks = this.hooks.get(event) ?? [];
    for (const hook of hooks) {
      const result = await hook.handler(payload);
      if (result.block) return result;
      if (result.transform) payload = result.transform;
    }
    return { transform: payload };
  }
}
```

注册到 HCP：
```typescript
hcpRegistry.registerExact("hook:tool_call", new HcpHookRegistry());
hcpRegistry.registerExact("hook:message_render", new HcpHookRegistry());
```

#### 3.2 HCP Credential Provider

```typescript
// harness/assembly/hcp/pi/credentials.ts

export interface HcpCredentialProvider implements HcpTarget {
  describe() {
    return {
      target: "credential:provider",
      kind: "credential",
      ops: ["get", "set", "list", "delete"]
    };
  }
  
  async call(hcpCall: HcpCall) {
    switch (hcpCall.op) {
      case "get":
        return this.getCredential(hcpCall.input.key);
      case "set":
        return this.setCredential(hcpCall.input.key, hcpCall.input.value);
      // ...
    }
  }
}
```

#### 3.3 HCP Command Registry

**问题：** 命令（`/todos`, `/events`）目前由 Extension 注册

**设计：** HCP Command Target

```typescript
// harness/assembly/hcp/pi/commands.ts

export interface HcpCommand {
  name: string;
  description: string;
  handler: (args: string[], ctx: CommandContext) => Promise<void>;
}

export class HcpCommandRegistry implements HcpTarget {
  private commands = new Map<string, HcpCommand>();
  
  register(command: HcpCommand) {
    this.commands.set(command.name, command);
  }
  
  async call(hcpCall: HcpCall) {
    if (hcpCall.op === "execute") {
      const cmd = this.commands.get(hcpCall.input.name);
      return cmd?.handler(hcpCall.input.args, hcpCall.context);
    }
    if (hcpCall.op === "list") {
      return Array.from(this.commands.values());
    }
  }
}
```

---

### Phase 4: 目录结构重组

#### 4.1 Harness 新结构

```
harness/
  tools/
    bg-shell/
      bg-shell.toml
      pi/bg-shell.ts        # 从 background-events 提取
    sub-agent/
      sub-agent.toml
      pi/sub-agent.ts       # 从 background-events 提取
    todo/
      todo.toml
      pi/todo.ts            # 从 todo.ts 迁移
    ssh/
      ssh.toml
      pi/ssh.ts             # 从 ssh.ts 迁移
    side-chat/
      side-chat.toml
      pi/side-chat.ts       # 从 side-chat.ts 迁移
  
  hooks/
    pi/
      ui-optimize.ts        # 从 ui-optimize 迁移
      ui-optimize.toml
  
  credentials/
    pi/
      local-bridge.ts       # 从 local-credential-bridge 迁移
      local-bridge.toml
  
  commands/
    commands.toml
    pi/
      events.ts             # /events 命令
      command-aliases.ts    # 命令映射逻辑
```

#### 4.2 harness.toml 更新

```toml
# 新增工具
[[components]]
kind = "tool"
name = "bg_shell"
path = "tools/bg-shell/bg-shell.toml"

[[components]]
kind = "tool"
name = "sub_agent"
path = "tools/sub-agent/sub-agent.toml"

[[components]]
kind = "tool"
name = "todo"
path = "tools/todo/todo.toml"

# 新增 hooks
[[components]]
kind = "hook"
name = "ui-optimize"
path = "hooks/ui-optimize.toml"

# 新增 credential provider
[[components]]
kind = "credential"
name = "local-bridge"
path = "credentials/local-bridge.toml"

# 删除旧的 extensions 组件
# [[components]]
# kind = "extension"
# name = "extensions"
# path = "extensions/extensions.toml"
```

---

### Phase 5: PI 代码清理

#### 5.1 删除的文件

```bash
# Extension 加载器
pi/coding-agent/src/core/extensions/
  - loader.ts              # 删除
  - types.ts               # 删除
  - wrapper.ts             # 删除
  - runner.ts              # 删除

# Resource loader 里的 extension 逻辑
pi/coding-agent/src/core/resource-loader.ts
  - getBundledExtensionResources()
  - discoverBundledExtensionPaths()
  - loadExtensionsCached()
  - BUNDLED_EXTENSION_ENTRIES
```

#### 5.2 保留但标记为 deprecated

```typescript
// pi/coding-agent/src/core/extensions/index.ts
/**
 * @deprecated Extension system is replaced by HCP/Magnet.
 * Use harness/assembly/magnet for new capabilities.
 */
export interface ExtensionAPI { ... }
```

#### 5.3 新的启动流程

```typescript
// pi/coding-agent/src/core/session-manager.ts

async initializeSession() {
  // 旧流程（删除）:
  // - const extensions = await this.resourceLoader.loadExtensions();
  // - this.toolset.addExtensionTools(extensions);
  
  // 新流程:
  const hcpRegistry = new HcpRegistry();
  
  // 1. Registry 扫描 harness.toml
  const registry = await loadRegistry("harness/harness.toml");
  
  // 2. 为每个组件创建 Magnet
  const magnets: Magnet[] = [];
  for (const component of registry.components) {
    const magnet = await createMagnetForComponent(component, { cwd: this.cwd });
    magnets.push(magnet);
  }
  
  // 3. 注册到 HCP
  for (const magnet of magnets) {
    if (magnet.toHcpTarget) {
      const target = magnet.toHcpTarget();
      const desc = target.describe();
      hcpRegistry.registerExact(desc.target, target);
    }
  }
  
  // 4. 收集所有工具
  const tools: AgentTool[] = [];
  for (const magnet of magnets) {
    if (magnet.toTool) {
      const tool = magnet.toTool();
      if (Array.isArray(tool)) {
        tools.push(...tool);
      } else {
        tools.push(tool);
      }
    }
  }
  
  // 5. 设置到 Agent Loop
  this.agent.setTools(tools);
  this.hcpRegistry = hcpRegistry;
}
```

---

## 迁移路线图

### Milestone 1: 基础设施（2-3 天）
- [ ] 实现 `HcpHookRegistry`
- [ ] 实现 `HcpCommandRegistry`
- [ ] 实现 `HcpCredentialProvider`
- [ ] 实现 `ExtensionMagnet`（桥接层）
- [ ] 更新 Agent Loop 事件分发

### Milestone 2: 简单迁移（1-2 天）
- [ ] 迁移 `todo` → `harness/tools/todo/`
- [ ] 迁移 `command-aliases` → 内置命令映射
- [ ] 迁移 `ssh` → `harness/tools/ssh/`
- [ ] 测试验证

### Milestone 3: 复杂迁移（3-4 天）
- [ ] 迁移 `background-events` → `bg-shell` + `sub-agent`
- [ ] 迁移 `side-chat` → `harness/tools/side-chat/`
- [ ] 测试验证

### Milestone 4: 高级能力（2-3 天）
- [ ] 迁移 `local-credential-bridge` → HCP credential provider
- [ ] 迁移 `ui-optimize` → HCP rendering hook
- [ ] 测试验证

### Milestone 5: 清理（1 天）
- [ ] 删除 `pi/coding-agent/src/core/extensions/`
- [ ] 删除 `resource-loader.ts` 里的 extension 逻辑
- [ ] 删除 `harness/extensions/`
- [ ] 更新文档

**总工期：9-13 天**

---

## 风险与挑战

### 1. 事件系统的性能
**风险：** ExtensionMagnet 的事件分发可能增加热路径开销

**缓解：**
- 只在有 hook 注册时才分发事件
- Hook priority 排序在注册时完成
- 考虑用 EventEmitter 优化

### 2. 向后兼容
**风险：** 用户可能有自己的 extensions

**缓解：**
- Phase 1 实现 ExtensionMagnet，支持旧 extension
- 文档说明迁移路径
- 提供迁移工具脚本

### 3. 命令系统重构
**风险：** 命令注册和执行逻辑分散

**缓解：**
- HcpCommandRegistry 统一管理
- 保留现有命令 API，内部委托给 HCP

---

## 成功标准

1. ✅ 所有 7 个 bundled extensions 迁移完成
2. ✅ `harness/extensions/` 目录删除
3. ✅ `pi/coding-agent/src/core/extensions/` 目录删除
4. ✅ 所有工具通过 HCP 注册和发现
5. ✅ Agent Loop 性能无回退
6. ✅ 集成测试全部通过
7. ✅ 文档更新完成

---

## 附录：ExtensionAPI 与 HCP 的能力映射

| ExtensionAPI | HCP 等价物 |
|-------------|-----------|
| `pi.registerTool()` | `NativeMagnet.toTool()` |
| `pi.registerCommand()` | `HcpCommandRegistry.register()` |
| `pi.on("tool_call")` | `HcpHookRegistry.register("tool_call")` |
| `pi.on("session_start")` | `HcpHookRegistry.register("session_start")` |
| `ctx.sendMessage()` | Agent Loop API（不通过 HCP） |
| `ctx.ui.confirm()` | TUI API（不通过 HCP） |
| `pi.appendEntry()` | Session API（不通过 HCP） |

**关键区别：**
- ExtensionAPI 混合了注册（assembly-time）和执行（runtime）
- HCP 只管注册和管理，执行通过 AgentTool 直接调用

## 实施路线图

### Sprint 1: 基础设施（1-2 天）

#### 1.1 创建 ExtensionMagnet
- [ ] `harness/assembly/magnet/pi/extension.ts`
- [ ] 实现 `Magnet` 接口
- [ ] 桥接 ExtensionAPI → HCP

#### 1.2 创建 HCP Hook System
- [ ] `harness/assembly/hcp/pi/hooks.ts`
- [ ] 事件拦截机制
- [ ] 优先级队列

#### 1.3 Agent Loop 集成
- [ ] `pi/agent/src/agent-harness.ts` 注入事件分发
- [ ] 工具调用前后触发 hooks

---

### Sprint 2: 迁移简单 Extensions（2-3 天）

#### 2.1 迁移 `todo`
```bash
harness/tools/todo/
  todo.toml           # HCP 注册
  pi/todo.ts          # 从 extensions/pi/bundled/todo.ts 迁移
  pi/todo.test.ts     # 单元测试
```

**步骤：**
1. 提取 `registerTool({ name: "todo", ... })` 的逻辑
2. 改写成 `NativeToolSpec`
3. 创建 `createTodoMagnet(cwd)`
4. 在 `harness.toml` 注册

#### 2.2 迁移 `command-aliases`
不需要 Magnet，直接内置到命令系统：

```typescript
// pi/coding-agent/src/core/slash-commands.ts
const COMMAND_ALIASES = {
  "exit": "quit",
  "q": "quit",
  "e": "exit"
};
```

#### 2.3 迁移 `ssh`
```bash
harness/tools/ssh/
  ssh.toml
  pi/ssh.ts
```

---

### Sprint 3: 迁移复杂 Extensions（3-4 天）

#### 3.1 迁移 `background-events`

**拆分策略：**

```
background-events → 拆成 3 个独立工具

1. harness/tools/bg-shell/
   bg-shell.toml
   pi/bg-shell.ts       # bg_shell 工具

2. harness/tools/sub-agent/
   sub-agent.toml
   pi/sub-agent.ts      # sub_agent 工具

3. harness/tools/events/
   events.toml
   pi/events.ts         # /events 命令
```

**关键改造：**
- EventMonitor → 独立的 HCP target `events:monitor`
- bg_shell 和 sub_agent 通过 HCP 与 monitor 通信

#### 3.2 迁移 `side-chat`
```bash
harness/tools/side-chat/
  side-chat.toml
  pi/side-chat.ts
```

**命令注册：**
```toml
[[commands]]
name = "side"
aliases = ["btw", "s"]
handler = "side-chat"
```

---

### Sprint 4: 迁移高级 Extensions（3-5 天）

#### 4.1 迁移 `local-credential-bridge`

**新架构：**
```
harness/credential/
  credential.toml      # HCP component
  pi/provider.ts       # OAuth provider
  pi/bridge.ts         # session_start hook
```

**HCP Target：**
```typescript
credential:oauth
  - op: "get" → 获取凭证
  - op: "refresh" → 刷新 token
  - op: "inject" → 注入到 session
```

#### 4.2 迁移 `ui-optimize`

**重新设计为 Rendering Hook：**
```
harness/hooks/
  rendering/
    ui-optimize.toml
    pi/ui-optimize.ts
```

**HCP Hook 注册：**
```typescript
hcpHooks.register({
  event: "tool_result_render",
  priority: 10,
  handler: async (payload) => {
    // 优化大输出的渲染
    if (payload.content.length > 50000) {
      return { transform: truncateAndLink(payload.content) };
    }
  }
});
```

---

### Sprint 5: 清理旧系统（1-2 天）

#### 5.1 删除 PI Extension Loader
- [ ] 删除 `pi/coding-agent/src/core/extensions/loader.ts`
- [ ] 删除 `resource-loader.ts` 中的 extension 扫描
- [ ] 删除 `ExtensionAPI` 实现（保留类型定义作为文档）

#### 5.2 删除 `.pi/` 目录支持
- [ ] 移除 `~/.pi/agent/extensions/` 扫描
- [ ] 移除 `.pi/extensions/` 扫描
- [ ] 更新文档说明新的扩展方式

#### 5.3 文档更新
- [ ] 更新 `docs/extensions.md` → `docs/hcp-components.md`
- [ ] 迁移指南：旧 Extension → HCP Component
- [ ] 示例：创建自定义工具/hook

---

## 新的用户扩展方式

### 方式 1: 本地工具（推荐）

```bash
# 用户项目目录
.magenta/
  harness/
    tools/
      my-tool/
        my-tool.toml
        pi/my-tool.ts
```

**加载方式：**
```typescript
// 启动时扫描
const localHarness = scanDirectory(".magenta/harness");
registry.register(localHarness);
```

### 方式 2: 用户包

```bash
~/.magenta/packages/
  my-tools/
    package.toml
    tools/
      my-tool/
        my-tool.toml
        pi/my-tool.ts
```

### 方式 3: NPM 包

```json
// package.json
{
  "name": "@myorg/magenta-tools",
  "magenta": {
    "harness": "dist/harness",
    "tools": [
      "dist/harness/tools/my-tool/my-tool.toml"
    ]
  }
}
```

---

## 测试策略

### 单元测试
每个迁移的工具都需要：
```typescript
// harness/tools/todo/pi/todo.test.ts
describe("TodoMagnet", () => {
  it("should create AgentTool", () => {
    const magnet = createTodoMagnet("/tmp");
    const tool = magnet.toTool();
    expect(tool.name).toBe("todo");
  });
  
  it("should execute add action", async () => {
    const tool = magnet.toTool();
    const result = await tool.execute("1", { action: "add", item: "test" });
    expect(result.content).toContain("Added");
  });
});
```

### 集成测试
```typescript
// harness/test/integration/hcp-assembly.test.ts
describe("HCP Assembly", () => {
  it("should discover all harness components", async () => {
    const registry = await loadRegistry("harness/harness.toml");
    expect(registry.components).toHaveLength(18);
  });
  
  it("should create magnets from registry", async () => {
    const magnets = await createMagnetsFromRegistry(registry, { cwd: "/tmp" });
    const tools = magnets.map(m => m.toTool()).filter(Boolean);
    expect(tools.length).toBeGreaterThan(10);
  });
});
```

### E2E 测试
```typescript
// pi/coding-agent/test/e2e/tool-execution.test.ts
describe("Tool Execution via HCP", () => {
  it("should execute todo tool from HCP", async () => {
    const agent = await createTestAgent();
    const response = await agent.chat("Add a todo: test task");
    expect(response).toContain("Added: test task");
  });
});
```

---

## 性能考量

### 启动时间
**目标：** Assembly 时间 < 200ms

**优化：**
1. 延迟加载：只在首次使用时加载 extension module
2. 并行扫描：Registry 并行读取所有 TOML
3. 缓存：缓存 Magnet 实例

### 运行时性能
**保证：** Agent Loop 零开销

```typescript
// ✅ 直接调用，无中间层
await tool.execute(id, params, signal);

// ❌ 避免这种
await hcpRegistry.dispatch({ 
  target: "tool:read", 
  op: "execute", 
  input: params 
});
```

### 内存占用
**优化：**
- ExtensionMagnet 只在需要事件拦截时才保留实例
- 简单工具用 NativeMagnet，不保留 extension 对象

---

## 向后兼容策略

### 过渡期（2-3 个月）

**同时支持两套系统：**
```typescript
// 启动时
if (hasOldExtensions()) {
  console.warn("⚠️  Old .pi/extensions/ detected. Please migrate to HCP components.");
  console.warn("   See: https://docs.magenta.dev/migration/extensions-to-hcp");
  
  // 仍然加载旧 extensions，但标记为 deprecated
  loadLegacyExtensions();
}

// 加载新 HCP components
loadHcpComponents();
```

### 废弃警告
```typescript
// pi/coding-agent/src/core/extensions/loader.ts
export async function loadExtensionsCached(...) {
  console.warn("DEPRECATED: ExtensionAPI is deprecated. Use HCP Components instead.");
  // ...
}
```

### 迁移工具
```bash
# 自动迁移脚本
npx @magenta/migrate-extension ~/.pi/agent/extensions/my-tool.ts

# 输出：
✅ Created: harness/tools/my-tool/my-tool.toml
✅ Created: harness/tools/my-tool/pi/my-tool.ts
⚠️  Manual review needed: Event handlers (tool_call) need to be converted to HCP hooks
```

---

## 风险与缓解

### 风险 1: Extension 能力不完整
**问题：** 某些 ExtensionAPI 功能在 HCP 中缺失

**缓解：**
- Phase 1 先实现 ExtensionMagnet 保持 100% 兼容
- 逐步提取常用模式到 HCP 原生能力

### 风险 2: 事件系统性能
**问题：** Hook 分发可能影响性能

**缓解：**
- Hook 只在注册时才启用事件分发
- 优先级队列避免无关 hook 被调用
- 性能测试：确保 < 1ms overhead

### 风险 3: 用户迁移成本
**问题：** 用户已有的 extension 需要重写

**缓解：**
- ExtensionMagnet 过渡期支持（6 个月）
- 自动迁移工具
- 详细文档和示例

---

## 成功指标

### 代码质量
- [ ] 删除 > 5000 行旧 Extension 代码
- [ ] 所有工具有单元测试（coverage > 80%）
- [ ] 零 TypeScript 错误

### 性能
- [ ] 启动时间 < 200ms
- [ ] 工具执行零 overhead（< 0.1ms）
- [ ] 内存占用降低 20%

### 用户体验
- [ ] 所有 7 个 bundled extensions 迁移完成
- [ ] 功能完全等价（无回归）
- [ ] 文档完善（包含 10+ 示例）

---

## 总结

**这个迁移的核心价值：**

1. **简化架构** - 只有 HCP 一套扩展系统
2. **提升性能** - Agent Loop 直接调用，无间接层
3. **增强可扩展性** - Magnet 适配器支持任何实现
4. **统一管理** - 所有能力通过 HCP 发现和配置
5. **更好的类型安全** - TypeScript 端到端类型检查

**时间估算：** 总计 10-15 天

**优先级：** P0（阻塞其他扩展能力开发）

**负责人：** [TBD]

---

## 附录 A: ExtensionAPI vs HCP 对照表

| ExtensionAPI | HCP 等价物 | 备注 |
|-------------|-----------|------|
| `pi.registerTool()` | `Magnet.toTool()` | 启动时注册 |
| `pi.registerCommand()` | Command registry in HCP | 命令系统 |
| `pi.on("tool_call")` | `HcpHook` | 事件拦截 |
| `ctx.ui.confirm()` | 保持不变 | 运行时 UI |
| `ctx.sendMessage()` | 保持不变 | 运行时通信 |
| `pi.appendEntry()` | Session API | 不经过 HCP |

## 附录 B: 示例迁移

### 旧 Extension
```typescript
// ~/.pi/agent/extensions/my-tool.ts
export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "greet",
    description: "Greet someone",
    parameters: Type.Object({ name: Type.String() }),
    async execute(id, params) {
      return { content: `Hello, ${params.name}!` };
    }
  });
}
```

### 新 HCP Component
```typescript
// harness/tools/greet/pi/greet.ts
import type { NativeToolSpec } from "../../../assembly/magnet/pi/native.ts";

export const greetSpec: NativeToolSpec = {
  name: "greet",
  description: "Greet someone",
  parameters: Type.Object({ name: Type.String() }),
  createExecute: (cwd) => async (id, params, signal) => {
    return { content: `Hello, ${params.name}!` };
  }
};

export function createGreetMagnet(cwd: string) {
  return new NativeToolMagnet(greetSpec, cwd);
}
```

```toml
# harness/tools/greet/greet.toml
kind = "tool"
name = "greet"
description = "Greet someone by name"
source = "pi"
```

```toml
# harness/harness.toml
[[components]]
kind = "tool"
name = "greet"
path = "tools/greet/greet.toml"
```
