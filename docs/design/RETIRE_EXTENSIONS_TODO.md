# 退役 Extension 系统 - 执行摘要

## 📋 任务清单（按优先级）

### ✅ Phase 1: 迁移工具到 Harness（2-3 天）

#### 1.1 Todo 工具（模板示例）⭐ 从这里开始
- [ ] 读取 `harness/extensions/pi/bundled/todo.ts`
- [ ] 创建 `harness/tools/todo/todo.toml`
- [ ] 创建 `harness/tools/todo/pi/todo.ts` (NativeToolSpec)
- [ ] 写单元测试 `harness/tools/todo/pi/todo.test.ts`
- [ ] 注册到 `harness/harness.toml`
- [ ] 导出到 `harness/index.ts`
- [ ] 运行测试：`cd harness && npm test todo`
- [ ] 集成测试：确认 LLM 能调用 todo 工具
- [ ] 删除旧代码：`rm harness/extensions/pi/bundled/todo.ts`

**预计时间：** 2-3 小时

---

### ✅ Phase 2: 迁移 UI 组件到 Pi TUI（3-4 天）

#### 2.1 Command Aliases（最简单）
- [ ] 移动 `command-aliases.ts` → `pi/tui/src/editor/aliases.ts`
- [ ] 在 `pi/tui/src/index.ts` 中导入并初始化
- [ ] 测试：确认 `exit` → `/quit` 仍然工作
- [ ] 删除旧文件

**预计时间：** 1-2 小时

#### 2.2 Side Chat
- [ ] 移动 `side-chat.ts` → `pi/tui/src/overlays/side-chat.ts`
- [ ] 提取共享的 `floating-window.ts`
- [ ] 在命令系统中注册 `/side`, `/btw`, `/s`
- [ ] 测试：确认侧边对话正常工作
- [ ] 删除旧文件

**预计时间：** 半天

#### 2.3 UI Optimize
- [ ] 移动整个目录 → `pi/tui/src/renderers/optimize/`
- [ ] 在 `pi/tui/src/index.ts` 中初始化
- [ ] 测试：确认 markdown 渲染、工具折叠、图片 token 正常
- [ ] 删除旧目录

**预计时间：** 1 天

#### 2.4 Events Monitor UI
- [ ] 从 `background-events/events-overlay.ts` 提取
- [ ] 移动到 `pi/tui/src/overlays/events-monitor.ts`
- [ ] 提取 `event-monitor.ts` 为独立模块
- [ ] 测试：确认 `/events` 命令显示监控面板

**预计时间：** 半天

---

### ✅ Phase 3: 迁移系统功能到 Pi Core（1 天）

#### 3.1 Credential Provider
- [ ] 移动 `local-credential-bridge.ts` → `pi/coding-agent/src/core/providers/credential.ts`
- [ ] 在 `session-manager.ts` 的 `startSession()` 中调用
- [ ] 测试：确认凭证自动加载
- [ ] 删除旧文件

**预计时间：** 半天

---

### ✅ Phase 4: 迁移复杂工具（3-4 天）

#### 4.1 bg_shell 工具
- [ ] 从 `background-events/background-shell.ts` 提取核心逻辑
- [ ] 创建 `harness/tools/bg-shell/pi/bg-shell.ts`
- [ ] 创建 `bg-shell.toml`
- [ ] 单元测试
- [ ] 注册到 harness

**预计时间：** 1 天

#### 4.2 sub_agent 工具
- [ ] 从 `background-events/sub-agents.ts` 提取
- [ ] 创建 `harness/tools/sub-agent/pi/sub-agent.ts`
- [ ] 创建 `sub-agent.toml`
- [ ] 单元测试
- [ ] 注册到 harness

**预计时间：** 1 天

#### 4.3 SSH Runtime Proxy
- [ ] 移动 `ssh.ts` → `harness/runtime/ssh/pi/ssh-proxy.ts`
- [ ] 创建 `ssh.toml` (kind = "runtime")
- [ ] 重新设计为 HCP runtime adapter
- [ ] 测试：`pi --ssh user@host` 工作正常

**预计时间：** 1 天

---

### ✅ Phase 5: 删除 Extension 系统（1-2 天）

#### 5.1 删除 Extension Loader
- [ ] 删除 `pi/coding-agent/src/core/extensions/` 目录
- [ ] 从 `resource-loader.ts` 删除 extension 扫描逻辑
- [ ] 删除 `harness/extensions/` 目录
- [ ] 从 `harness/harness.toml` 删除 extensions 组件

**预计时间：** 2-3 小时

#### 5.2 清理导入和依赖
- [ ] 全局搜索 `ExtensionAPI` 并删除所有引用
- [ ] 全局搜索 `loadExtension` 并删除
- [ ] 更新 TypeScript exports
- [ ] 运行 `npm run build` 确认无编译错误

**预计时间：** 1-2 小时

#### 5.3 更新文档
- [ ] 删除 `docs/extensions.md`
- [ ] 创建 `docs/hcp-components.md`
- [ ] 更新 README
- [ ] 创建迁移指南（给外部开发者）

**预计时间：** 2-3 小时

---

### ✅ Phase 6: 全面测试（1-2 天）

#### 6.1 单元测试
- [ ] 运行 `cd harness && npm test`
- [ ] 运行 `cd pi && npm test`
- [ ] 确认所有测试通过

#### 6.2 集成测试
- [ ] 启动 Pi：`pi`
- [ ] 测试 todo 工具：让 LLM 添加 todo
- [ ] 测试 bg_shell：让 LLM 运行长时间命令
- [ ] 测试 sub_agent：启动并行任务
- [ ] 测试 /side：快速问答
- [ ] 测试 /events：监控后台任务
- [ ] 测试 UI：markdown 渲染、工具折叠
- [ ] 测试凭证：API keys 自动加载

#### 6.3 回归测试
- [ ] 运行完整的 E2E 测试套件
- [ ] 手动测试所有核心场景
- [ ] 性能测试：启动时间 < 200ms

---

## 📊 进度跟踪

### 总任务数：7 个组件迁移

| 组件 | 目标位置 | 优先级 | 状态 | 预计时间 |
|------|----------|--------|------|----------|
| todo | harness/tools/todo/ | P0 | ⏸️ 待开始 | 2-3h |
| command-aliases | pi/tui/src/editor/ | P0 | ⏸️ 待开始 | 1-2h |
| side-chat | pi/tui/src/overlays/ | P1 | ⏸️ 待开始 | 0.5d |
| ui-optimize | pi/tui/src/renderers/ | P1 | ⏸️ 待开始 | 1d |
| credential-bridge | pi/coding-agent/src/core/providers/ | P1 | ⏸️ 待开始 | 0.5d |
| bg_shell + sub_agent | harness/tools/ | P2 | ⏸️ 待开始 | 2d |
| ssh | harness/runtime/ssh/ | P2 | ⏸️ 待开始 | 1d |

### 总时间：8-12 天

---

## 🚀 立即开始

### 第一步：迁移 Todo（今天）

```bash
# 1. 创建分支
git checkout -b refactor/retire-extensions

# 2. 查看现有代码
cat harness/extensions/pi/bundled/todo.ts

# 3. 创建新结构
mkdir -p harness/tools/todo/pi

# 4. 按照计划文档的步骤执行
# 详见：docs/design/retire-extensions-plan.md Task 1.1
```

### 第二步：每完成一个组件

```bash
# 1. 运行测试
cd harness && npm test

# 2. 提交
git add .
git commit -m "refactor: migrate todo from extension to harness tool"

# 3. 继续下一个
```

---

## 📈 成功标准

### 最终状态检查

```bash
# ❌ 不应该存在
ls harness/extensions/               # 目录不存在
ls pi/coding-agent/src/core/extensions/  # 目录不存在
grep -r "ExtensionAPI" pi/           # 无结果（除了类型定义）
grep -r "loadExtension" pi/          # 无结果

# ✅ 应该存在
ls harness/tools/todo/               # ✓
ls harness/tools/bg-shell/           # ✓
ls harness/tools/sub-agent/          # ✓
ls pi/tui/src/overlays/side-chat.ts  # ✓
ls pi/tui/src/renderers/optimize/    # ✓
ls pi/coding-agent/src/core/providers/credential.ts  # ✓

# ✅ 功能正常
pi                                   # 启动成功
# 在对话中测试 todo 工具
# 在对话中测试 bg_shell
# 测试 /side 命令
# 测试 /events 命令
```

---

## 📝 详细指南

**完整步骤和代码示例见：**
`/Users/mjm/Magenta3/docs/design/retire-extensions-plan.md`

**设计文档见：**
`/Users/mjm/Magenta3/docs/design/hcp-extension-migration.md`
`/Users/mjm/Magenta3/docs/design/hcp-migration-summary.md`
