# HCP/Magnet 取代 PI Extension - 执行摘要

> Archived note (2026-07-03): this summary predates the final ownership decision. Current state: Pi owns Agent-loop, session, slash command, overlay, and TUI UX features; Harness owns reusable tools/protocol capabilities including SSH remote workspace operations; the bundled extension registry has been removed. See `extension-migration-progress.md` for the final result.

## 背景

当前 Magenta3 有两套并行的扩展系统：
1. **PI Extension（旧）** - ExtensionAPI, resource-loader, .pi/extensions/
2. **HCP/Magnet（新）** - 协议驱动，统一管理

**目标：** 完全废弃旧系统，用 HCP/Magnet 统一所有扩展能力

---

## 核心架构

### HCP (Harness Component Protocol) - 单例
- 全局唯一的 `HcpRegistry`
- 管理和发现所有组件
- **不在执行热路径上**（Agent Loop 直接调用 tool.execute）

### Magnet - 多种适配器
```
NativeMagnet        → TypeScript 工具
ProcessToolMagnet   → Rust 进程工具
HcpProcessMagnet    → HCP JSONL 进程
ExtensionMagnet     → 桥接旧 PI Extension（过渡期）
McpMagnet           → 未来：MCP 工具
```

---

## 实施策略

### Phase 1: 基础设施（1-2 天）
✅ 创建 `ExtensionMagnet` - 包装旧 extension 的桥接层
✅ 创建 `HcpHookSystem` - 事件拦截机制
✅ Agent Loop 注入事件分发点

### Phase 2: 迁移简单 Extensions（2-3 天）
- `todo` → `harness/tools/todo/`
- `command-aliases` → 内置命令映射
- `ssh` → `harness/tools/ssh/`

### Phase 3: 迁移复杂 Extensions（3-4 天）
- `background-events` → 拆分成 `bg-shell`, `sub-agent`, `events` 三个工具
- `side-chat` → `harness/tools/side-chat/`

### Phase 4: 迁移高级 Extensions（3-5 天）
- `local-credential-bridge` → HCP credential provider
- `ui-optimize` → HCP rendering hook

### Phase 5: 清理旧系统（1-2 天）
- 删除 `extensions/loader.ts`
- 删除 `.pi/` 目录扫描
- 更新文档

**总工期：2-3 周**

---

## 关键设计决策

### 1. 为什么需要 ExtensionMagnet？
旧 extensions 使用了复杂的 ExtensionAPI 能力：
- 事件拦截（`pi.on("tool_call")`）
- 动态注册（`pi.registerTool`）
- 用户交互（`ctx.ui.confirm`）

ExtensionMagnet 作为**桥接层**，让这些能力在 HCP 下继续工作，给迁移留出时间。

### 2. 事件系统如何桥接？
**问题：** HCP 不在热路径，但 extensions 需要拦截工具调用

**解决：** Agent Loop 注入事件分发点
```typescript
async executeToolCall(toolCall) {
  // 1. 触发 "tool_call" 事件
  const block = await hcpHooks.dispatch("tool_call", toolCall);
  if (block) return block;
  
  // 2. 执行工具
  const result = await tool.execute(...);
  
  // 3. 触发 "tool_result" 事件
  await hcpHooks.dispatch("tool_result", result);
  
  return result;
}
```

### 3. 用户扩展的新方式
```
废弃：
  ~/.pi/agent/extensions/
  .pi/extensions/

新方式 1（本地项目）：
  .magenta/harness/tools/my-tool/
    my-tool.toml
    pi/my-tool.ts

新方式 2（用户包）：
  ~/.magenta/packages/my-tools/
    package.toml
    tools/...

新方式 3（NPM 包）：
  node_modules/@myorg/magenta-tools/
    (package.json 声明 magenta.harness)
```

---

## 迁移对比

### 旧 Extension
```typescript
// ~/.pi/agent/extensions/my-tool.ts
export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "greet",
    execute: async (id, params) => ({ content: "Hello!" })
  });
}
```

### 新 HCP Component
```typescript
// harness/tools/greet/pi/greet.ts
export const greetSpec: NativeToolSpec = {
  name: "greet",
  createExecute: (cwd) => async (id, params) => ({ content: "Hello!" })
};

export function createGreetMagnet(cwd: string) {
  return new NativeToolMagnet(greetSpec, cwd);
}
```

```toml
# harness/tools/greet/greet.toml
kind = "tool"
name = "greet"
source = "pi"
```

---

## 性能保证

### 启动时间
- **目标：** Assembly < 200ms
- **优化：** 延迟加载、并行扫描、缓存 Magnet

### 运行时
- **保证：** Agent Loop 零开销
- **机制：** 直接调用 `tool.execute()`，不通过 HCP dispatch

### 内存
- **优化：** 简单工具用 NativeMagnet，不保留 extension 对象

---

## 向后兼容

### 过渡期（2-3 个月）
- 同时支持两套系统
- 旧 extensions 显示废弃警告
- 提供迁移工具和文档

### 完全废弃后
- 删除 ExtensionAPI 实现
- 只保留 HCP/Magnet

---

## 风险与缓解

### 风险 1：事件系统性能开销
**缓解：** 
- 只在需要时启用 hook
- Hook 优先级队列优化
- 测试：确保事件分发 < 1ms

### 风险 2：迁移破坏现有功能
**缓解：**
- 完整的单元测试覆盖
- E2E 测试验证所有场景
- 过渡期保留旧系统

### 风险 3：用户自定义 extensions 无法迁移
**缓解：**
- 提供迁移工具自动转换
- 详细的迁移文档和示例
- ExtensionMagnet 作为兜底方案

---

## 成功标准

1. ✅ 所有 7 个 bundled extensions 迁移完成
2. ✅ 旧 Extension 系统完全删除
3. ✅ 启动时间 < 200ms
4. ✅ 运行时性能无退化
5. ✅ 单元测试覆盖率 > 90%
6. ✅ 用户迁移文档完善

---

## 下一步行动

### 立即开始
1. 创建 `/Users/mjm/Magenta3/harness/assembly/magnet/pi/extension.ts`
2. 实现 `ExtensionMagnet` 类
3. 单元测试验证桥接逻辑

### 本周完成
- Phase 1: 基础设施
- Phase 2: 迁移 todo, command-aliases, ssh

### 两周内完成
- Phase 3-4: 迁移所有 bundled extensions

### 三周内完成
- Phase 5: 清理旧系统
- 发布 beta 版本

---

**详细设计文档：** `/Users/mjm/Magenta3/docs/design/hcp-extension-migration.md`
