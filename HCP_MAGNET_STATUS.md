# HCP/Magnet 架构开发状态

**日期**: 2026-07-03  
**接续会话**: Codex session `019f25dc-8005-73b3-a2c0-6ea3422c4dc5`

## 概述

本文档总结了 HCP (Harness Component Protocol) 和 Magnet 架构的当前实现状态。这个架构是从之前的 Extension 系统迁移而来，目标是建立一个统一的、source-agnostic 的能力解析和装配系统。

## 核心架构原则

### 设计哲学

1. **HCP 是唯一的能力解析器** - 不存在第二个并行的 registry
2. **Magnet 是适配层** - 连接 Source 实现和 HCP，吸收不同 source 的差异
3. **Source 是实现来源** - `pi`, `magenta`, `codex`, `claude-code` 等，不是编程语言
4. **Consumer 是 source-agnostic** - 只通过名字请求能力，不知道具体 source
5. **HCP 不在热路径** - 解析通过 HCP，但运行时直接调用实例
6. **Pi 拥有 UX** - Agent loop、TUI、session、命令都归 Pi
7. **Harness 拥有能力** - 可复用的执行能力和装配系统

### 架构流程

```
Source 实现 → Magnet 适配器 → HCP 管理/解析
                           ↓
         resolved AgentTool/Capability 实例 → 直接运行时调用
```

### 关键术语

- **API**: 模块间的稳定交互边界
- **Source**: 实现来源或所有权家族（如 `pi`, `magenta`）
- **Capability**: 可装配的能力（tool、memory、compaction、policy 等）
- **Tool**: 模型可见的 Capability 子类型
- **HCP**: Harness Component Protocol - 控制面 API
- **Magnet**: 适配层，一头连 HCP，一头连 Source 实现
- **Registry/Package Overlay**: 声明和发现层
- **Runtime**: 解析后的实例实际运行的地方
- **Pi**: 拥有 agent loop、TUI、session、UX
- **Harness**: 拥有可复用能力和装配系统

## 当前实现状态

### ✅ 已完成的 Capabilities

所有以下 capabilities 已经接入 HCP/Magnet 架构：

| Capability | Source(s) | 位置 | 说明 |
|------------|-----------|------|------|
| `compaction` | `pi` | `harness/compaction/` | 会话上下文压缩 |
| `context` | `magenta` | `harness/context/` | 上下文管理 |
| `hook` | `magenta` | `harness/hooks/` | 钩子系统 |
| `memory` | `magenta` | `harness/memory/` | Session grounding 记忆 |
| `policy` | `magenta` | `harness/policy/` | 审批和 shell 策略 |
| `runtime:process` | `magenta` | `harness/runtime/` | 进程运行时 |
| `runtime:script-runtimes` | `magenta` | `harness/runtime/` | 脚本运行时 |
| `sandbox` | `magenta` | `harness/sandbox/` | 沙箱管理 |

### 实现细节

#### Capability Builder 表

位置: `harness/assembly/magnet/capability.ts`

```typescript
const BUILTIN_CAPABILITY_BUILDERS: CapabilityBuilderTable = {
  "compaction:pi": async () => ...,
  "context:magenta": async () => ...,
  "hook:magenta": async () => ...,
  "memory:magenta": async (context) => ...,
  "policy:magenta": async () => ...,
  "runtime:magenta": async (context) => ...,
  "sandbox:magenta": async (context) => ...,
};
```

#### 默认 Source 选择

```typescript
const DEFAULT_CAPABILITY_SOURCES: Record<string, string> = {
  compaction: "pi",
  context: "magenta",
  hook: "magenta",
  memory: "magenta",
  policy: "magenta",
  "runtime:process": "magenta",
  "runtime:script-runtimes": "magenta",
  sandbox: "magenta",
};
```

#### Capability Contract 结构

每个 capability 都有：

1. **`contract.ts`** - Source-neutral 接口定义
   - 不引用 HCP 类型（已修复）
   - 定义 Provider 接口和结果类型
   - 示例：`CompactionProvider`, `MemoryProvider`

2. **`<source>/` 目录** - Source-specific 实现
   - 实现 contract 中定义的接口
   - 可以有 source-specific 的扩展类型
   - 示例：`pi/provider.ts`, `magenta/session-grounding.ts`

3. **`<capability>.toml`** - 组件描述符
   - 声明 kind, name, description
   - 通过 package overlay 选择 source

### ✅ 已完成的 Extension 迁移

| Extension | 状态 | 新位置 | 说明 |
|-----------|------|--------|------|
| `todo` | ✅ 迁移 | `harness/tools/todo/` | HCP tool |
| `ssh` | ✅ 迁移 | `harness/tools/ssh/` + Pi `--ssh` | 作为 workspace backend |
| `local-credential-bridge` | ✅ 删除 | - | 被 `external-auth-loader.ts` 替代 |
| `command-aliases` | ✅ 迁移 | `pi/coding-agent/src/core/` | Pi core 功能 |
| `ui-optimize` | ✅ 迁移 | `pi/coding-agent` core/TUI | Pi UX 功能 |
| `background-events` | ✅ 迁移 | `pi/coding-agent/src/core/` | `bg_shell`, `sub_agent` 内置工具 |
| `side-chat` | ✅ 迁移 | `pi/coding-agent/src/core/` | Pi session 功能 |

**重要**: `harness/extensions/` 目录已被完全删除。Extension runtime 仍保留在 `pi/coding-agent/src/core/extensions`，用于支持用户/项目级别的扩展。

### ✅ HCP Registry 功能

位置: `harness/assembly/hcp/hcp.ts`

核心接口：

```typescript
interface HcpTarget {
  describe(): HcpTargetDescription;
  call(call: HcpCall): Promise<unknown> | unknown;
  instance?<T = unknown>(): T;  // 新增：类型化实例访问
}

class HcpRegistry {
  // 现有方法
  register(address: string, target: HcpTarget): void;
  resolve(address: string): HcpTarget | undefined;
  dispatch(call: HcpCall): Promise<unknown>;
  
  // 新增：按名字解析 capability
  resolveCapability<T>(name: string): T | undefined;
}
```

### ✅ 测试覆盖

- **Harness**: 27 test files, 225 tests ✅
- **Pi coding-agent**: 159 test files, 1516 tests ✅
- **Pi TUI**: 120 test suites, 689 tests ✅

所有测试都通过，包括：
- Capability magnet 创建和解析
- HCP registry 操作
- Source 切换能力测试
- Tool 和 capability 集成测试

### ✅ Bundle 机制（已实现）

位置: `harness/assembly/package-overlay/package-overlay.ts`

**功能**: 允许组件声明必需的配套组件，自动联动 source 选择。

**实现**:
```typescript
export interface PackageComponentBundle {
  kind: string;
  name?: string;
  source: string;
  raw: string;
}
```

**使用示例** (已在生产中使用):

```toml
# harness/sandbox/sandbox.toml
kind = "sandbox"
source = "magenta"
bundles = ["runtime:magenta"]  # sandbox 需要 runtime 配套

# harness/runtime/runtime.toml
kind = "runtime"
name = "process"
source = "magenta"
bundles = ["sandbox:magenta"]  # runtime 需要 sandbox 配套

# harness/runtime/script-runtimes.toml
kind = "runtime"
name = "script-runtimes"
source = "magenta"
bundles = ["sandbox:magenta", "runtime:process:magenta"]  # 双重依赖
```

**行为**:
- 当选择某个组件时，自动选择其 bundle 声明的配套组件的对应 source
- 如果 bundle 目标不存在，生成 `package_bundle_target_missing` 诊断
- 如果 bundle 冲突（不同组件要求同一目标的不同 source），生成 `package_bundle_conflict` 诊断
- 成功应用时生成 `package_bundle_applied` 诊断信息

## 代码组织

### Harness 目录结构

```
harness/
├── assembly/          # HCP/Magnet 装配层
│   ├── hcp/          # HCP Registry
│   ├── magnet/       # Magnet 适配器
│   ├── package-overlay/  # 包声明和选择
│   └── registry/     # 组件注册
├── compaction/       # Compaction capability
│   ├── contract.ts   # Source-neutral 接口
│   └── pi/          # Pi source 实现
├── context/          # Context capability
│   ├── contract.ts
│   └── magenta/
├── memory/           # Memory capability
│   ├── contract.ts
│   ├── magenta/
│   └── pi/          # （未来可扩展）
├── policy/           # Policy capability
│   ├── contract.ts
│   └── magenta/
├── runtime/          # Runtime capability
│   ├── contract.ts
│   └── magenta/
├── sandbox/          # Sandbox capability
│   ├── contract.ts
│   └── magenta/
├── hooks/            # Hook capability
│   ├── contract.ts
│   └── magenta/
└── tools/            # 内置工具
    ├── todo/
    ├── ssh/
    ├── bash/
    ├── read/
    ├── write/
    └── ...
```

## 关键修复和改进

### 1. Memory Contract Source-Neutral 化

**问题**: `memory/contract.ts` 引用了 `../assembly/hcp/hcp.ts`，违反了 source-neutral 原则，导致构建失败。

**修复**:
- 移除了 `MemoryProvider.toHcpTarget()` 方法要求
- 添加了可选的 `describe()` 方法返回 source-neutral 元数据
- 调整了 `memory/tsconfig.build.json` 的 `rootDir` 配置以支持必要的跨目录引用
- `toHcpTarget()` 仍在具体实现中保留，但不在 contract 中强制

### 2. Test 修复

修复了 `3592-no-builtin-tools-keeps-extension-tools.test.ts`，添加了 `show` 工具到期望列表中。

### 3. 文档完善

创建了 `harness/docs/governance/hcp-capability-resolver-contract.md`，明确了：
- HCP/Magnet 的设计合同
- 概念词汇表
- 不变量和成功门槛
- 实施顺序

## 未来工作

### 可能的扩展点

1. **多 Source 支持**
   - 为 memory 添加 `pi` vector-store 实现
   - 为 compaction 添加 `magenta` 实现
   - 验证 source 切换的实际效果

2. **更多 Capabilities**
   - `system-prompt`: 系统提示管理
   - `prompt-templates`: 提示模板
   - `env`: 环境变量管理
   - `session`: Session 生命周期
   - `loop`: Agent loop 配置

3. **Pi Runtime Deep Rewire**
   - 当前 Pi 的 resource-loader 仍使用传统方式
   - 未来可以更深入地集成 HCP 解析

## 验证清单

### ✅ 已验证

- [x] Harness build 成功
- [x] Harness 所有测试通过（225 tests）
- [x] Pi coding-agent build 成功
- [x] Pi coding-agent 所有测试通过（1516 tests）
- [x] Pi TUI build 成功
- [x] Pi TUI 所有测试通过（689 tests）
- [x] 没有 source 被硬编码在 consumer 中
- [x] HCP Registry 是唯一的能力解析器
- [x] Contract 是 source-neutral 的
- [x] Magnet 是 source 和 HCP 之间的唯一边界

### 🔄 待验证

- [ ] Source 切换的实际效果（需要多个 source 实现同一 capability）
- [ ] 生产环境运行验证
- [ ] 性能基准测试
- [ ] 完整的集成测试场景

## 架构遵从性

根据 `hcp-capability-resolver-contract.md` 的要求：

### ✅ 满足的不变量

1. ✅ **恰好一个 HCP** - 只有一个 `HcpRegistry` 类型，无并行注册
2. ✅ **每个模块一个 Magnet** - 所有能力通过 Magnet 收敛
3. ✅ **HCP 不在执行热路径** - 解析通过 HCP，调用直接执行
4. ✅ **Consumer 是 source-agnostic** - 无 consumer 代码指名 source
5. ✅ **Pi 不深度重构** - `assemblePackageToolMagnets` 保持向后兼容
6. ✅ **HCP/Magnet 不可选** - 不将 HCP 本身作为可选组件

### 接口变更

按照 contract 允许的"add interfaces on HCP"：

1. ✅ `HcpTarget.instance<T>()` - 提供类型化实例访问
2. ✅ `HcpRegistry.resolveCapability<T>(name)` - 按名字解析能力

## 工作区状态

### 未提交的更改

当前有 111 个文件有变更，主要包括：

1. **HCP/Magnet 重组** - 从 `pi/` 子目录移到顶层
2. **Extension 退役** - 删除 `harness/extensions/`
3. **Capability 接入** - 所有 7 个 capabilities 接入 HCP
4. **SSH 迁移** - 从 extension 到 `harness/tools/ssh/`
5. **Pi 集成** - CLI 参数、session 服务、工具加载
6. **文档更新** - 设计文档、迁移进度、架构说明
7. **Memory contract 修复** - Source-neutral 化
8. **Test 修复** - 添加 `show` 工具到期望列表

### 构建状态

- ✅ `npm --prefix harness build` - 成功
- ✅ `npm --prefix harness test` - 225 tests 通过
- ✅ `npm --prefix pi/coding-agent build` - 成功
- ✅ `npm --prefix pi/coding-agent test` - 1516 tests 通过
- ✅ `npm --prefix pi/tui build` - 成功
- ✅ `npm --prefix pi/tui test` - 689 tests 通过

## 参考文档

1. `harness/docs/governance/hcp-capability-resolver-contract.md` - HCP 设计合同
2. `docs/design/retire-extensions-plan.md` - Extension 退役计划（已归档）
3. `docs/design/extension-migration-progress.md` - 迁移进度
4. `harness/README.md` - Harness 架构概述
5. `harness/assembly/README.md` - 装配层文档

## 联系和贡献

这个架构是 Magenta3 项目的核心基础设施。任何对 HCP/Magnet 的修改都应该：

1. 遵循 `hcp-capability-resolver-contract.md` 中的不变量
2. 保持 source-neutral 的 contract 设计
3. 确保所有测试通过
4. 更新相关文档

---

**最后更新**: 2026-07-03  
**状态**: HCP/Magnet 架构基本完成，所有核心 capabilities 已接入，测试全部通过
