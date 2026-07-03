# 退役 PI Extension 系统 - 详细执行计划

## 总览

**目标：** 完全废弃 PI Extension 系统，将 7 个 bundled extensions 重新归类到正确的层级

**核心原则：** HCP + Magnet 已经提供了所有扩展能力，不再需要 Extension 系统

**时间估算：** 1.5-2 周

---

## Phase 1: 迁移简单工具到 Harness（2-3 天）

### Task 1.1: 迁移 `todo` 工具 ✅ 作为模板

**当前位置：** `harness/extensions/pi/bundled/todo.ts`  
**目标位置：** `harness/tools/todo/`

#### 步骤 1.1.1：查看现有代码结构

```bash
# 读取当前实现
cat harness/extensions/pi/bundled/todo.ts
```

**分析点：**
- 找到 `pi.registerTool()` 调用
- 提取工具参数：name, description, parameters, execute
- 识别依赖项（Type, StringEnum）
- 注意状态管理逻辑

#### 步骤 1.1.2：创建新的工具结构

```bash
# 创建目录结构
mkdir -p harness/tools/todo/pi
mkdir -p harness/tools/todo/test

# 创建 TOML 声明
cat > harness/tools/todo/todo.toml << 'EOF'
kind = "tool"
name = "todo"
description = "Manage a session-scoped todo list. Actions: list, add, toggle (by id), clear."
source = "pi"

[parameters]
type = "object"
required = ["action"]

[parameters.properties.action]
type = "string"
enum = ["list", "add", "toggle", "clear"]
description = "Action to perform"

[parameters.properties.item]
type = "string"
description = "Todo item text (required for add)"

[parameters.properties.id]
type = "number"
description = "Todo item id (required for toggle)"
EOF
```

#### 步骤 1.1.3：重写成 NativeToolSpec

```bash
# 创建新的实现
cat > harness/tools/todo/pi/todo.ts << 'EOF'
/**
 * Todo tool - session-scoped todo list management
 * 
 * Migrated from extensions/pi/bundled/todo.ts
 */

import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { NativeToolSpec } from "../../../assembly/magnet/pi/native.ts";

// 类型定义
interface Todo {
  id: number;
  text: string;
  done: boolean;
}

interface TodoDetails {
  action: "list" | "add" | "toggle" | "clear";
  todos: Todo[];
  nextId: number;
  error?: string;
}

// 参数 schema
export const todoSchema = Type.Object({
  action: StringEnum(["list", "add", "toggle", "clear"] as const),
  item: Type.Optional(Type.String({ description: "Todo item text (for add)" })),
  id: Type.Optional(Type.Number({ description: "Todo item id (for toggle)" })),
});

// NativeToolSpec 定义
export const todoSpec: NativeToolSpec<typeof todoSchema, TodoDetails> = {
  name: "todo",
  label: "Todo",
  description: "Manage a session-scoped todo list. Actions: list, add, toggle (by id), clear.",
  parameters: todoSchema,
  
  createExecute: (cwd) => {
    // Session 状态（通过 details 持久化）
    let todos: Todo[] = [];
    let nextId = 1;
    
    return async (toolCallId, params, signal, onUpdate) => {
      const { action, item, id } = params;
      
      // 从上一次调用恢复状态（通过 details）
      // 注意：真实实现需要从 session storage 读取
      
      let error: string | undefined;
      let content = "";
      
      switch (action) {
        case "list":
          if (todos.length === 0) {
            content = "No todos";
          } else {
            content = todos
              .map(t => `${t.id}. [${t.done ? "x" : " "}] ${t.text}`)
              .join("
");
          }
          break;
          
        case "add":
          if (!item) {
            error = "item is required for add action";
            content = "Error: " + error;
          } else {
            const newTodo: Todo = { id: nextId++, text: item, done: false };
            todos.push(newTodo);
            content = `Added: ${newTodo.id}. ${newTodo.text}`;
          }
          break;
          
        case "toggle":
          if (id === undefined) {
            error = "id is required for toggle action";
            content = "Error: " + error;
          } else {
            const todo = todos.find(t => t.id === id);
            if (!todo) {
              error = `Todo ${id} not found`;
              content = "Error: " + error;
            } else {
              todo.done = !todo.done;
              content = `Toggled: ${todo.id}. [${todo.done ? "x" : " "}] ${todo.text}`;
            }
          }
          break;
          
        case "clear":
          const count = todos.length;
          todos = [];
          nextId = 1;
          content = `Cleared ${count} todo(s)`;
          break;
      }
      
      const details: TodoDetails = {
        action,
        todos: [...todos],
        nextId,
        error,
      };
      
      return {
        content,
        details,
      };
    };
  },
};

// Magnet 工厂函数
import { NativeToolMagnet } from "../../../assembly/magnet/pi/native.ts";

export function createTodoMagnet(cwd: string): NativeToolMagnet<typeof todoSchema, TodoDetails> {
  return new NativeToolMagnet(todoSpec, cwd);
}
EOF
```

#### 步骤 1.1.4：创建单元测试

```bash
cat > harness/tools/todo/pi/todo.test.ts << 'EOF'
import { describe, it, expect } from "vitest";
import { createTodoMagnet } from "./todo.ts";

describe("TodoMagnet", () => {
  it("should create a valid magnet", () => {
    const magnet = createTodoMagnet("/tmp");
    expect(magnet.kind).toBe("native");
  });
  
  it("should produce an AgentTool", () => {
    const magnet = createTodoMagnet("/tmp");
    const tool = magnet.toTool();
    
    expect(tool.name).toBe("todo");
    expect(tool.description).toContain("todo list");
    expect(tool.execute).toBeTypeOf("function");
  });
  
  it("should list empty todos", async () => {
    const magnet = createTodoMagnet("/tmp");
    const tool = magnet.toTool();
    
    const result = await tool.execute("1", { action: "list" });
    expect(result.content).toBe("No todos");
  });
  
  it("should add a todo", async () => {
    const magnet = createTodoMagnet("/tmp");
    const tool = magnet.toTool();
    
    const result = await tool.execute("1", { action: "add", item: "Test task" });
    expect(result.content).toContain("Added");
    expect(result.details?.todos).toHaveLength(1);
    expect(result.details?.todos[0].text).toBe("Test task");
  });
  
  it("should toggle a todo", async () => {
    const magnet = createTodoMagnet("/tmp");
    const tool = magnet.toTool();
    
    // Add
    await tool.execute("1", { action: "add", item: "Task 1" });
    
    // Toggle
    const result = await tool.execute("2", { action: "toggle", id: 1 });
    expect(result.content).toContain("Toggled");
    expect(result.details?.todos[0].done).toBe(true);
  });
  
  it("should clear todos", async () => {
    const magnet = createTodoMagnet("/tmp");
    const tool = magnet.toTool();
    
    await tool.execute("1", { action: "add", item: "Task 1" });
    await tool.execute("2", { action: "add", item: "Task 2" });
    
    const result = await tool.execute("3", { action: "clear" });
    expect(result.content).toBe("Cleared 2 todo(s)");
  });
});
EOF
```

#### 步骤 1.1.5：注册到 Harness

```bash
# 编辑 harness/harness.toml
# 在 [[components]] 中添加:

cat >> harness/harness.toml << 'EOF'

[[components]]
kind = "tool"
name = "todo"
description = "Manage session-scoped todo list"
path = "tools/todo/todo.toml"
EOF
```

#### 步骤 1.1.6：导出到 Harness 公共 API

```bash
# 编辑 harness/tools/index.ts
# 添加:

cat >> harness/tools/index.ts << 'EOF'

// Todo tool
export { createTodoMagnet, todoSpec, todoSchema } from "./todo/pi/todo.ts";
export type { TodoDetails } from "./todo/pi/todo.ts";
EOF
```

#### 步骤 1.1.7：运行测试

```bash
cd harness
npm test -- tools/todo/pi/todo.test.ts
```

#### 步骤 1.1.8：集成测试

```bash
# 在 pi/coding-agent 启动时加载 todo 工具
# 编辑 pi/coding-agent/src/core/agent-harness.ts

# 测试命令
cd pi/coding-agent
npm run dev

# 在 REPL 中测试:
# > Add a todo: write tests
# > List todos
# > Clear todos
```

#### 步骤 1.1.9：添加 /todos 命令支持

```bash
# 创建命令实现
cat > harness/tools/todo/pi/todos-command.ts << 'EOF'
/**
 * /todos command - 显示 todo 列表
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export async function todosCommand(ctx: ExtensionCommandContext) {
  // 从 session 读取 todos
  const todos = ctx.session.getTodos(); // 需要实现
  
  if (todos.length === 0) {
    ctx.ui.notify("No todos");
  } else {
    const list = todos
      .map(t => `${t.id}. [${t.done ? "x" : " "}] ${t.text}`)
      .join("
");
    ctx.ui.notify(`Todos:
${list}`);
  }
}
EOF

# 注册命令 (pi/coding-agent/src/core/slash-commands.ts)
# import { todosCommand } from "@magenta/harness";
# registerCommand("todos", todosCommand);
```

#### 步骤 1.1.10：删除旧代码

```bash
# 确认新实现完全工作后
rm harness/extensions/pi/bundled/todo.ts

# 提交
git add harness/tools/todo/
git commit -m "refactor: migrate todo from extension to harness tool"
```

---

### Task 1.2: 迁移 `bg-shell` 工具

**按照 todo 的模板执行：**

1. 创建 `harness/tools/bg-shell/`
2. 从 `harness/extensions/pi/bundled/background-events/background-shell.ts` 提取逻辑
3. 重写成 `NativeToolSpec`
4. 创建 `bg-shell.toml`
5. 单元测试
6. 注册到 `harness.toml`
7. 删除旧代码

**注意点：**
- bg_shell 管理进程，需要处理进程生命周期
- `returnToMain` 功能需要与 Agent Loop 集成
- 状态存储（运行中的进程）

---

### Task 1.3: 迁移 `sub-agent` 工具

**按照 todo 的模板执行：**

1. 创建 `harness/tools/sub-agent/`
2. 从 `harness/extensions/pi/bundled/background-events/sub-agents.ts` 提取逻辑
3. 重写成 `NativeToolSpec`
4. 创建 `sub-agent.toml`
5. 单元测试
6. 注册到 `harness.toml`
7. 删除旧代码

---

## Phase 2: 迁移 UI 组件到 Pi TUI（2-3 天）

### Task 2.1: 迁移 `command-aliases` 到 TUI

**当前位置：** `harness/extensions/pi/bundled/command-aliases.ts`  
**目标位置：** `pi/tui/src/editor/aliases.ts`

#### 步骤：

1. **移动文件**
```bash
mkdir -p pi/tui/src/editor
cp harness/extensions/pi/bundled/command-aliases.ts pi/tui/src/editor/aliases.ts
```

2. **移除 Extension 依赖**
```typescript
// 删除:
// export default function(pi: ExtensionAPI) { ... }

// 改成:
export function installCommandAliases(
  tui: TUI,
  keybindings: KeybindingsManager
) {
  // 安装别名逻辑
  const editor = tui.getEditor();
  // ...
}
```

3. **在 TUI 初始化时调用**
```typescript
// pi/tui/src/index.ts
import { installCommandAliases } from "./editor/aliases.ts";

export function createTUI(options: TUIOptions) {
  const tui = new TUI(options);
  installCommandAliases(tui, options.keybindings);
  return tui;
}
```

4. **删除旧代码**
```bash
rm harness/extensions/pi/bundled/command-aliases.ts
```

---

### Task 2.2: 迁移 `events-monitor` UI

**当前位置：** `harness/extensions/pi/bundled/background-events/events-overlay.ts`  
**目标位置：** `pi/tui/src/overlays/events-monitor.ts`

#### 步骤类似 Task 2.1

---

### Task 2.3: 迁移 `side-chat`

**当前位置：** `harness/extensions/pi/bundled/side-chat.ts`  
**目标位置：** `pi/tui/src/overlays/side-chat.ts`

#### 步骤类似 Task 2.1

---

### Task 2.4: 迁移 `ui-optimize`

**当前位置：** `harness/extensions/pi/bundled/ui-optimize/`  
**目标位置：** `pi/tui/src/renderers/optimize/`

#### 步骤：

```bash
mkdir -p pi/tui/src/renderers/optimize
cp -r harness/extensions/pi/bundled/ui-optimize/* pi/tui/src/renderers/optimize/

# 重写 index.ts
# export function installUIOptimize(tui: TUI) { ... }

# 在 TUI 初始化时调用
```

---

## Phase 3: 迁移系统功能到 Pi Core（1 天）

### Task 3.1: 迁移 `local-credential-bridge`

**当前位置：** `harness/extensions/pi/bundled/local-credential-bridge.ts`  
**目标位置：** `pi/coding-agent/src/core/providers/credential-provider.ts`

#### 步骤：

1. **创建 Credential Provider**
```bash
mkdir -p pi/coding-agent/src/core/providers

cat > pi/coding-agent/src/core/providers/credential-provider.ts << 'EOF'
/**
 * Credential provider - 从本地配置读取 API keys
 * 
 * Migrated from harness/extensions/pi/bundled/local-credential-bridge.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Credentials {
  anthropicApiKey?: string;
  openaiApiKey?: string;
  baseUrl?: string;
}

export async function loadCredentialsFromLocal(): Promise<Credentials> {
  const credentials: Credentials = {};
  
  // 读取 ~/.codex/config.toml
  const codexConfig = join(homedir(), ".codex", "config.toml");
  if (existsSync(codexConfig)) {
    const content = readFileSync(codexConfig, "utf8");
    credentials.anthropicApiKey = readTomlString(content, "anthropic_api_key");
  }
  
  // 读取 ~/.cursor/settings.json
  const cursorSettings = join(homedir(), ".cursor", "settings.json");
  if (existsSync(cursorSettings)) {
    const content = JSON.parse(readFileSync(cursorSettings, "utf8"));
    credentials.openaiApiKey = content.env?.OPENAI_API_KEY;
  }
  
  return credentials;
}

function readTomlString(text: string, key: string): string | undefined {
  const match = new RegExp(`^\s*${key}\s*=\s*"([^"]*)"`, "m").exec(text);
  return match?.[1];
}
EOF
```

2. **在 Session 启动时注入**
```typescript
// pi/coding-agent/src/core/session-manager.ts
import { loadCredentialsFromLocal } from "./providers/credential-provider.ts";

async startSession(options: SessionOptions) {
  // 自动加载凭证
  const credentials = await loadCredentialsFromLocal();
  if (credentials.anthropicApiKey) {
    process.env.ANTHROPIC_API_KEY = credentials.anthropicApiKey;
  }
  // ...
}
```

3. **删除旧代码**
```bash
rm harness/extensions/pi/bundled/local-credential-bridge.ts
```

---

## Phase 4: 迁移特殊工具（2 天）

### Task 4.1: 迁移 `ssh` 到 Runtime

**当前位置：** `harness/extensions/pi/bundled/ssh.ts`  
**目标位置：** `harness/runtime/ssh/`

#### 概念：

SSH 不是一个"工具"，而是一个"远程运行时"，像 Docker 一样

#### 步骤：

1. **创建 SSH Runtime**
```bash
mkdir -p harness/runtime/ssh/pi

cat > harness/runtime/ssh/ssh.toml << 'EOF'
kind = "runtime"
name = "ssh"
description = "SSH remote execution proxy for read/write/edit/bash tools"
source = "pi"
EOF
```

2. **重写为 Runtime Proxy**
```typescript
// harness/runtime/ssh/pi/ssh-proxy.ts

export interface SSHRuntimeOptions {
  remote: string;  // user@host or user@host:/path
  cwd: string;
}

export class SSHRuntime {
  constructor(private options: SSHRuntimeOptions) {}
  
  // 拦截工具调用
  async proxyToolCall(toolName: string, params: unknown): Promise<unknown> {
    switch (toolName) {
      case "read":
        return this.proxyRead(params);
      case "write":
        return this.proxyWrite(params);
      case "edit":
        return this.proxyEdit(params);
      case "bash":
        return this.proxyBash(params);
      default:
        throw new Error(`SSH runtime does not support tool: ${toolName}`);
    }
  }
  
  private async proxyRead(params: any) {
    const { path } = params;
    const cmd = `cat ${shellQuote(path)}`;
    return await this.sshExec(cmd);
  }
  
  // ... 其他代理方法
  
  private async sshExec(command: string): Promise<string> {
    // SSH 执行逻辑
  }
}
```

3. **CLI 集成**
```typescript
// pi/coding-agent/src/cli.ts
if (options.ssh) {
  const sshRuntime = new SSHRuntime({ remote: options.ssh, cwd });
  agent.setRuntime(sshRuntime);
}
```

---

## Phase 5: 删除 Extension 系统（1 天）

### Task 5.1: 删除 Extension Loader

```bash
# 删除整个 extensions/ 子系统
rm -rf pi/coding-agent/src/core/extensions/

# 删除 resource-loader 中的扫描逻辑
# 编辑 pi/coding-agent/src/core/resource-loader.ts
# 删除:
# - getBundledExtensionResources()
# - discoverBundledExtensionPaths()
# - loadExtensionsCached()
# - BUNDLED_EXTENSION_ENTRIES
```

### Task 5.2: 删除 Harness Extensions

```bash
rm -rf harness/extensions/

# 更新 harness.toml
# 删除:
# [[components]]
# kind = "extension"
# name = "extensions"
# path = "extensions/extensions.toml"
```

### Task 5.3: 清理导入

```bash
# 搜索并删除所有 ExtensionAPI 的导入
grep -r "ExtensionAPI" pi/coding-agent/src --include="*.ts" | grep import

# 删除这些导入
```

---

## Phase 6: 测试和文档（2-3 天）

### Task 6.1: 单元测试

```bash
# 运行所有测试
cd harness && npm test
cd pi/coding-agent && npm test
cd pi/tui && npm test
```

### Task 6.2: 集成测试

```bash
# 测试所有迁移的功能
pi-dev

# 测试清单:
- [ ] todo 工具可用
- [ ] /todos 命令可用
- [ ] bg_shell 工具可用
- [ ] sub_agent 工具可用
- [ ] /events 显示后台任务
- [ ] /side 快速问答可用
- [ ] 命令别名 (exit, quit, clear) 工作
- [ ] UI 渲染优化正常
- [ ] 凭证自动加载
- [ ] --ssh 远程执行正常
```

### Task 6.3: 更新文档

```bash
# 删除旧文档
rm docs/extensions.md

# 创建新文档
cat > docs/hcp-components.md << 'EOF'
# Magenta3 组件系统

## 架构

Magenta3 使用 HCP (Harness Component Protocol) + Magnet 统一管理所有扩展能力。

### 不再有 "Extensions"

旧的 PI Extension 系统已废弃。功能已重新归类：

- **UI 增强** → pi/tui/src/
- **工具** → harness/tools/
- **运行时** → harness/runtime/
- **系统功能** → pi/coding-agent/src/core/

## 创建自定义工具

### 方式 1: 本地 Harness 工具

\`\`\`bash
.magenta/harness/tools/my-tool/
  my-tool.toml
  pi/my-tool.ts
\`\`\`

### 方式 2: NPM 包

\`\`\`json
{
  "name": "@myorg/magenta-tools",
  "magenta": {
    "harness": "dist/harness"
  }
}
\`\`\`

详见: docs/creating-tools.md
EOF
```

---

## 执行时间表

| Week | 任务 | 完成标准 |
|------|------|----------|
| Week 1 前半 | Phase 1: 迁移 todo, bg-shell, sub-agent | 3 个工具在 harness/tools/ 下工作 |
| Week 1 后半 | Phase 2: 迁移 UI 组件 | 4 个 UI 功能在 pi/tui/ 下工作 |
| Week 2 前半 | Phase 3-4: 迁移系统功能和 ssh | 凭证加载和 SSH 运行时工作 |
| Week 2 中 | Phase 5: 删除 Extension 系统 | `grep -r Extension` 无结果 |
| Week 2 后半 | Phase 6: 测试和文档 | 所有测试通过，文档更新 |

---

## 成功检查清单

### 代码层面
- [ ] `harness/extensions/` 目录已删除
- [ ] `pi/coding-agent/src/core/extensions/` 目录已删除
- [ ] `grep -r "ExtensionAPI" pi/` 无结果（除了类型定义）
- [ ] `grep -r "loadExtension" pi/` 无结果
- [ ] 所有单元测试通过
- [ ] 所有集成测试通过

### 功能层面
- [ ] Todo 工具正常工作
- [ ] bg_shell 和 sub_agent 工具正常工作
- [ ] /events 监控面板正常显示
- [ ] /side 快速问答正常工作
- [ ] 命令别名 (exit/quit/clear) 正常工作
- [ ] UI 渲染优化正常应用
- [ ] 凭证自动从本地配置加载
- [ ] --ssh 远程执行正常工作

### 架构层面
- [ ] 所有工具通过 HCP Registry 注册
- [ ] 所有 UI 功能内置到 pi/tui
- [ ] 所有系统功能内置到 pi/coding-agent/src/core
- [ ] 没有 "extension" 的概念
- [ ] 文档已更新

---

## 风险和缓解

### 风险 1: 状态管理变化
**问题:** todo 的状态存储从 extension session entries 改为 harness tool details  
**缓解:** 
- 先实现状态持久化逻辑
- 测试分支场景
- 确保向后兼容

### 风险 2: bg_shell 的进程管理
**问题:** 后台进程生命周期管理复杂  
**缓解:**
- 保留 event-monitor 的进程管理逻辑
- 增量迁移，确保每步可工作
- 充分测试进程启动/取消/超时场景

### 风险 3: UI 组件依赖
**问题:** UI 组件可能有隐藏的 ExtensionAPI 依赖  
**缓解:**
- 逐个组件迁移
- 每次迁移后立即测试
- 保留 git 历史便于回滚

---

## 下一步行动

**今天就可以开始：**

```bash
# 1. 创建分支
git checkout -b refactor/retire-extensions

# 2. 开始 Task 1.1: 迁移 todo
mkdir -p harness/tools/todo/pi
# 按照上述详细步骤执行

# 3. 测试 todo 工具
cd harness && npm test -- tools/todo

# 4. 提交
git add harness/tools/todo/
git commit -m "refactor: migrate todo from extension to harness tool"
```

**然后按照计划逐个完成其他任务。**
