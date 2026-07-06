# Magenta3 架构文档

> ⚠️ 本文档描述的是高层包结构与设计理念。harness 内部布局以 `harness/README.md`
> 的五区布局(`hcp-contract/`、`hcp-client/`、`hcp-magnet/`、`modules/`、`core/`)
> 为准。若两者冲突,以 `harness/README.md` 为准。

## 概述

Magenta3 采用分层的模块化架构,将核心功能拆分为独立的包,提高可维护性和可测试性。

## 包结构

### 核心层 (Core Layer)

#### @earendil-works/pi-ai
- **职责**: LLM API 抽象层
- **包含**: Models, Message, Tool 等基础类型
- **依赖**: 无
- **位置**: `pi/ai/`

#### @earendil-works/pi-agent-core
- **职责**: Agent 核心逻辑
- **包含**: 
  - `runAgentLoop` - 主循环实现
  - `AgentMessage`, `AgentTool`, `AgentEvent` 等核心类型
  - `CustomAgentMessages` 扩展机制
- **依赖**: `@earendil-works/pi-ai`
- **位置**: `pi/agent/`

### 实现层 (Implementation Layer)

#### @magenta/harness
- **职责**: Agent 运行环境和会话管理
- **包含**:
  - `AgentHarness` - 高级 agent 封装
  - `Session` - 会话管理
  - `NodeExecutionEnv` - Node.js 环境实现
  - `Compaction` - 上下文压缩
  - `BranchSummarization` - 分支总结
- **依赖**: `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`
- **位置**: `harness/` (五区布局: `hcp-contract/`、`hcp-client/`、`hcp-magnet/`、`modules/`、`core/`;详见 `harness/README.md`)
- **特性**: 通过 module augmentation 扩展 agent-core 的 `CustomAgentMessages`

#### @magenta/memory
- **职责**: 记忆系统和向量检索
- **包含**:
  - `MemoryStore` - 记忆存储接口
  - `InMemoryStore` - 内存实现
  - `EmbeddingProvider` - 向量化接口
  - `SimpleHashEmbedding` - 简单哈希实现
  - 向量相似度计算工具
- **依赖**: `@earendil-works/pi-ai`
- **位置**: `harness/modules/memory/`

### 应用层 (Application Layer)

#### @earendil-works/pi-coding-agent
- **职责**: 完整的编码助手应用
- **包含**: 
  - CLI 工具
  - 交互式模式
  - RPC 服务器
  - 工具集 (Read, Write, Edit, Bash, Grep 等)
- **依赖**: 
  - `@magenta/harness`
  - `@earendil-works/pi-agent-core`
  - `@earendil-works/pi-ai`
  - `@earendil-works/pi-tui`
- **位置**: `pi/coding-agent/`

#### @earendil-works/pi-tui
- **职责**: 终端 UI 组件
- **依赖**: `@earendil-works/pi-ai`
- **位置**: `pi/tui/`

## 依赖关系图

```
coding-agent
    ├── harness
    │   ├── agent-core
    │   │   └── ai
    │   └── ai
    ├── agent-core
    │   └── ai
    ├── ai
    └── tui
        └── ai

memory
    └── ai
```

## 设计原则

### 1. 分离关注点
- **agent-core**: 纯逻辑,无环境依赖
- **harness**: 环境实现和会话管理
- **memory**: 独立的记忆系统
- **coding-agent**: 应用组装

### 2. 依赖注入
- `agent-core` 通过接口定义需求 (如 `ExecutionEnv`)
- `harness` 提供具体实现 (如 `NodeExecutionEnv`)
- 应用层组装依赖

### 3. 类型安全的扩展
- `agent-core` 定义 `CustomAgentMessages` 接口
- `harness` 通过 module augmentation 扩展自定义消息类型
- TypeScript 确保类型安全

### 4. 平台无关
- `agent-core` 可在任何 JavaScript 环境运行
- `harness` 提供 Node.js 特定实现
- 未来可添加浏览器/Deno 等其他实现

## 构建流程

```bash
# 按依赖顺序构建
npm run build -w @earendil-works/pi-ai
npm run build -w @earendil-works/pi-agent-core
npm run build -w @magenta/harness
npm run build -w @magenta/memory
npm run build -w @earendil-works/pi-tui
npm run build -w @earendil-works/pi-coding-agent

# 或使用 workspaces 自动排序
npm run build --workspaces
```

## 扩展点

### 添加新的消息类型

在 `harness/core/messages/messages.ts`:

```typescript
export interface MyCustomMessage {
  role: "myCustom";
  data: string;
}

declare module "@earendil-works/pi-agent-core" {
  interface CustomAgentMessages {
    myCustom: MyCustomMessage;
  }
}
```

### 添加新的执行环境

实现 `harness/core/types/types.ts` 中的 `ExecutionEnv` 接口:

```typescript
export class BrowserExecutionEnv implements ExecutionEnv {
  // 实现 FileSystem 和 Shell 接口
}
```

### 添加新的记忆后端

实现 `harness/modules/memory/pi/types.ts` 中的 `MemoryStore` 接口:

```typescript
export class RedisMemoryStore implements MemoryStore {
  // 实现持久化存储
}
```

## 迁移说明

### 从旧架构迁移

**之前**:
```typescript
import { AgentHarness, Session } from "@earendil-works/pi-agent-core";
```

**现在**:
```typescript
import { AgentHarness, Session } from "@magenta/harness";
```

agent-core 现在只包含核心类型和循环逻辑,具体实现在 harness 中。

## 未来规划

1. **Browser Harness**: 浏览器环境的 harness 实现
2. **Persistent Memory**: 基于数据库的持久化记忆存储
3. **Distributed Execution**: 支持多节点分布式执行
4. **Plugin System**: 动态加载工具和扩展的插件系统

## 维护指南

### 修改原则
- 修改 `agent-core` 需谨慎,影响所有下游包
- `harness` 的修改只影响使用它的应用
- `memory` 是独立的,可单独演化

### 测试策略
- `agent-core`: 单元测试覆盖核心逻辑
- `harness`: 集成测试验证环境实现
- `coding-agent`: E2E 测试验证完整流程

### 版本管理
- `agent-core` 遵循严格的语义化版本
- `harness` 和 `memory` 独立版本
- `coding-agent` 版本反映用户可见的变更

---

**最后更新**: 2026-07-05
**架构版本**: 2.0.0 (五区重构后)
