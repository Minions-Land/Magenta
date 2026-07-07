# Magenta Self-Evo 技能体系完整指南

## 📊 整体统计

| 文件 | 行数 | 用途 |
|------|------|------|
| **self-evo (父技能)** | 213 行 | 总入口，路由器 |
| **skill-creator** | 539 行 | 创建和改进 Skills |
| **extension-intake** | 70 行 | 获取 Pi 扩展 |
| **extension-conversion** | 80 行 | 转换 Pi 扩展 |
| **package-forge** | 108 行 | 封装外部项目 |
| **总计** | **1010 行** | 完整自我进化体系 |

---

## 🎯 核心理念

Self-Evo 是 Magenta 修改自身 harness 的模式。核心动作是：

> **从某处获取能力 → 转换为四大原语之一 → 用 Magnet 挂载到 HCP 地址空间**

---

## 🏗️ Magenta 的四大原语

| 原语 | 说明 | 模型可见 | 需要代码构建器 | Magnet 输出 |
|------|------|----------|----------------|-------------|
| **Tool** | 可调用函数 | ✅ 在工具列表中 | ✅ (`execute` fn) | `toTool()` |
| **Capability** | 循环内部插槽实现 | ❌ | ✅ (`build` fn) | `toCapability()` |
| **Resource** | 内容合并（系统提示、skill等） | 间接（作为内容） | ❌ | `toResource()` |
| **Prompt** | 命名提示模板 | 调用时 | ✅ | (prompt-template) |

**One-of 不变式**：一个 Magnet 最多产生一个原语，不能混合。

---

## 📂 目录结构

```
harness/modules/skills/self-evo/
└── magenta/                          (source = magenta，因为这是 Magenta 的自我进化行为)
    ├── SKILL.md                      (213 行，父技能 - 入口和路由)
    ├── skill-creator/
    │   └── SKILL.md                  (539 行，创建 Skills)
    ├── extension-intake/
    │   └── SKILL.md                  (70 行，获取 Pi 扩展)
    ├── extension-conversion/
    │   └── SKILL.md                  (80 行，转换 Pi 扩展)
    └── package-forge/
        └── SKILL.md                  (108 行，封装外部项目)
```

所有 sub-skills 标记 `disable-model-invocation: true`，不能独立触发。

---

## 🔀 路由决策树

当用户说"扩展 Magenta"时，self-evo 根据需求路由：

```
你在构建什么？
│
├─ 🎨 新的 Skill (指令、工作流、领域专业知识)
│   └─ → skill-creator/SKILL.md
│
├─ 📦 单个 Pi 扩展 (npm/git/本地示例)
│   ├─ 获取和审查 → extension-intake/SKILL.md
│   └─ 转换为原语 → extension-conversion/SKILL.md
│
├─ 🏢 外部项目/重量级包 (整个 harness、Python 工具套件)
│   └─ → package-forge/SKILL.md
│
└─ ⚡ 一次性工具/能力 (手写，无现有来源)
    └─ 留在父技能，遵循基础流程
```

---

## 1️⃣ Self-Evo (父技能) - 213 行

**用途**：总入口和路由器

### 核心内容

1. **心智模型**
   - 四大原语表格
   - HCP 服务器的真正含义
   - One-of 不变式

2. **基础环境决策**
   - 确定原语类型（Tool/Capability/Resource/Prompt）
   - 探测现有插槽/地址
   - 判断是添加 source 还是创建新模块

3. **路由到子技能**
   - 根据来源类型路由
   - Dissolve（溶解到 trunk）vs Encapsulate（封装为 package）

4. **着陆流程**（适用于所有路径）
   - 创建目录结构
   - 编写 `.toml` 描述符
   - 连接 Magnet
   - 注册到 `harness.toml`
   - 验证门（`npm run build/test/check:structure/inspect`）

5. **源纪律**
   - `source` = 原始代理名称（`pi`、`magenta`、`codex`）
   - 永远不要用 `magenta` 误标产品来源

### 护栏规则

- ✅ 读取扩展/项目后再翻译
- ✅ Magnet 只绑定，不做选择逻辑
- ✅ 保留来源信息
- ✅ 优先复用现有模块
- ✅ 分步迭代

---

## 2️⃣ Skill-Creator (新增) - 539 行

**用途**：创建和迭代改进 Magenta Skills

### 什么是 Magenta Skill？

- **原语类型**：Resource（内容型，无代码构建器）
- **加载机制**：模式匹配 `description` 字段
- **结构**：YAML frontmatter + Markdown 指令 + 可选资源

### 关键区别（vs Claude Skills）

| 维度 | Claude | Magenta |
|------|--------|---------|
| 原语 | 独立文件 | Resource 原语 |
| 结构 | 扁平 | `modules/skills/<name>/<source>/` |
| 触发 | 模型调用 | 加载到上下文 |
| 源标记 | 无 | magenta/pi/codex 等 |

### 创建循环（7步）

1. **Capture Intent** - 捕获用户意图
2. **Interview and Research** - 访谈和研究
3. **Write SKILL.md** - 编写技能
4. **Create Test Cases** - 创建测试用例
5. **Run and Evaluate** - 运行和评估（sub-agents）
6. **Iterate** - 迭代改进
7. **Gate and Register** - 验证和注册

### SKILL.md 结构

**YAML Frontmatter**（必需）：
```yaml
---
name: skill-name
description: >
  触发条件 + 功能描述。这是主要触发机制。
  稍微"激进"以对抗触发不足。
  包含关键词和相关场景。
---
```

**Body 结构**（推荐 < 500 行）：
```markdown
# Skill Name

## 1. Input Check
## 2. Core Workflow
## 3. Output Format
## 4. Quality Requirements
## 5. Examples
## 6. References (如有大型文档)
```

### 渐进式公开（三层加载）

1. **Metadata** (name + description) - 始终在上下文 (~100 字)
2. **SKILL.md body** - 技能触发时加载 (<500 行)
3. **Bundled resources** - 按需加载（无限制）

### 测试和评估

**工作区组织**：
```
<skill-name>-workspace/
├── skill-snapshot/          (如改进现有技能)
└── iteration-1/
    ├── eval-0-descriptive-name/
    │   ├── with_skill/outputs/
    │   ├── without_skill/outputs/
    │   ├── timing.json
    │   └── eval_metadata.json
    ├── eval-1-another-case/
    └── feedback.json
```

**并行运行**：
- 每个测试用例同时启动两个 sub-agents
- with_skill（使用技能）
- without_skill（基线）
- 捕获 timing 数据（tokens、duration_ms）

**手动审查**（Magenta 暂无 eval-viewer）：
- 向用户展示输出对比
- 收集定性反馈
- 保存到 `feedback.json`

### 改进原则

1. **泛化反馈** - 这些是训练示例，技能将被使用数百万次
2. **保持精简** - 删除无效指令
3. **解释原因** - LLM 聪明，理解"为什么"比死记"必须"更有效
4. **查找重复工作** - 如果所有测试都独立写了相同脚本，打包到 `assets/scripts/`

### 高级：描述优化

1. 生成 20 个触发评估查询（10 应触发，10 不应触发）
2. 查询必须真实、详细（不是抽象的）
3. 测试当前描述
4. 基于失败改进描述
5. 迭代最多 5 轮
6. 使用保留测试集避免过拟合

---

## 3️⃣ Extension-Intake (Pi 扩展获取) - 70 行

**用途**：获取和审查 Pi 扩展（Pi 路径的前半部分）

### Pi 扩展来源

| 来源 | 如何获取 | 备注 |
|------|----------|------|
| 本地官方示例 | `pi/coding-agent/examples/extensions/` | 最短路径，直接读取 |
| npm 包 | `npm:<pkg>` | 检查发布的 tarball，不执行 |
| git 仓库 | `git:github.com/<owner>/<repo>` | 只读克隆，固定 ref |

### 获取流程

1. **只读获取** - 获取到临时位置，固定版本/ref，永不运行扩展
2. **读取入口模块** - Pi 扩展是 `export default function(pi: ExtensionAPI) { ... }`
3. **枚举注入点**：
   - `pi.registerTool(...)` → 候选 Tool
   - `pi.registerCommand(...)` → 候选命令/UI
   - `pi.on(<event>, ...)` → 候选 Capability
   - 系统提示/帮助文本 → 候选 Resource
4. **映射依赖** - 列出所有导入，标记需要运行时的部分
5. **安全审查** - 网络调用、进程生成、文件系统写入、密钥访问
6. **决定溶解 vs 封装**
   - 轻量单一原语 + 轻依赖 → 交给 conversion 集成到 trunk
   - 重依赖/多组件/独立环境 → 路由回 package-forge
7. **记录来源** - 来源（url + 固定 ref/版本）、许可证、注入点清单

### 交给 Conversion 的合同

产出：
- 固定的源位置
- 注入点清单 → 每个点的暂定原语
- 依赖/运行时分类（原生 TS vs 需要进程）
- 安全发现
- 溶解 vs 封装决策

---

## 4️⃣ Extension-Conversion (Pi 扩展转换) - 80 行

**用途**：将 Pi 扩展的注入点转换为 harness 原语并连接 Magnet

### 翻译表

| Pi 注入点 | Harness 原语 | Magnet / 连接 |
|-----------|-------------|--------------|
| `pi.registerTool(...)` | **Tool** | `NativeToolMagnet` (原生 TS) 或 process Magnet |
| `pi.on("tool_call/result", ...)` 门控/变异 | **Capability** (policy) | `CapabilitySourceMagnet` 注册到 `sources.ts` |
| `pi.on("compact"/summarization)` | **Capability** (compaction) | compaction source magnet |
| `pi.on("session_start"/context)` | **Capability** (context/memory) | 匹配的能力插槽 |
| 系统提示/帮助/静态文本 | **Resource** | 仅 `content_path`，无代码构建器 |
| `pi.registerCommand(...)` | 通常**不是**原语 | 命令是 Pi TUI 表面；重新表达为 Tool/Capability 或放弃 |

**One-of 不变式**：如果一个扩展注册多个工具+事件钩子，那是**多个组件**，每个有自己的 Magnet。

### 转换流程

1. **剥离 ExtensionAPI 外壳** - `export default function(pi)` 是 Pi 运行时胶水
2. **重新绑定上下文** - Pi 的 `execute` 接收 `(toolCallId, params, signal, onUpdate, ctx)`
   - Harness 工具是基于绑定的 `cwd` 的纯函数
   - 替换 UI/会话访问为 harness 原生等价物
3. **放置和重命名**
   - `harness/modules/tools/<name>/pi/<name>.ts`（trunk 工具）
   - 重命名为 harness 约定（kebab tool name，`create<Name>Magnet` 工厂）
   - `source` 目录是 `pi`（因为代码起源是 Pi）
4. **编写描述符** - `<name>.toml`
   - **原生工具有工厂**：使用 `[exports]` (`module`, `factory`)
   - **Process/schema 声明的工具**：声明 `[parameters]`
   - **Capability**：额外携带 `[assumption]` 块
5. **连接 Magnet** - 保持简洁：仅绑定 + 传输选择
6. **注册** - 添加 `[[components]]` 到 `harness.toml`
7. **门控** - `npm run build/test/check:structure/inspect`

### 常见转换陷阱

- ❌ 将系统提示贡献视为 capability（它是 Resource）
- ❌ 逐字移植 `ctx.ui` 提示（harness 循环无交互式 TUI 钩子）
- ❌ 将多个注册工具捆绑到一个 Magnet（违反 one-of）
- ❌ 标记产物 `source = "magenta"`（代码来自 Pi，标记 `pi`）

---

## 5️⃣ Package-Forge (外部项目封装) - 108 行

**用途**：将外部项目或重量级工作封装为自包含 package

### 何时 Forge 而非 Dissolve

当满足以下任何条件时 forge：
- 来源是完整项目/另一个代理的 harness，不是单个扩展
- 携带重或固定的运行时（Python + pixi、Rust crate、原生二进制）
- 多个应该在一起的组件，需要边界
- 应该独立发布/版本化

否则，优先通过 intake + conversion 溶解。

### Package 解剖（基于 `packages/AutOmicScience/`）

```
packages/<Name>/
  package.toml              - schema_version, id, name, kind, domain, [[components]]
  skills/<skill>/SKILL.md   - 打包的 skills（扁平：package 内无 <source> 子目录）
  tools/<tool>/<tool>.toml  - 打包的工具描述符 (+ python/, rust/, pixi.toml, ...)
  system-prompt/            - 打包的资源（append-system-prompt 等）
  brands/<Name>             - 可选品牌资源
```

**关键规则**：
- `packages/` 是唯一的 package 内容根（没有 `harness/packages`）
- Package 组件使用扁平 `tools/<tool>/` 布局（不是 `<name>/<source>/`）
- 发布清单 + lock，不是构建环境（`pixi.toml` + `pixi.lock` 被跟踪；`.pixi/` 被忽略）

### "无 HCP 服务器时"的答案

- Process-backed package tool 声明其运行时（如 `runtime = "aose_omics_runtime"`）
- 通过 `runtime://process` + **process Magnet** (`HcpProcessMagnet`, JSONL 传输) 到达循环
- 该 Magnet **就是**工具的 HCP 服务器

### Forge 流程

1. **只读审查外部项目** - 将其组件映射到 harness 原语
2. **决定边界** - 什么留在 package vs 什么溶解到 trunk
3. **脚手架 `packages/<Name>/`** - 编写 `package.toml`
4. **引入运行时** - Python: `pixi.toml` + `pixi.lock`；Rust: crate
5. **声明 tools/skills/resources** - Package 本地相对路径
6. **保留来源** - 在 `package.toml` 中记录原始仓库 + commit
7. **门控** - `npm run build/test/check:structure/inspect`

---

## 🔧 验证门控（所有路径共享）

从 `harness/` 运行：

```bash
npm run build            # tsc + 资产复制 - 必须绿色
npm test                 # vitest - 无回归
npm run check:structure  # 强制执行模块/源布局规则
npm run check:assumptions # 强制执行 [assumption] 放置（仅能力）
npm run inspect          # 解析真实注册表 + packages；检查诊断
```

`npm run inspect` 是最快确认新组件解析的方式，并显示误分类诊断（如 `capability_factory_missing`）。

---

## 📏 源纪律（贯穿所有子技能）

**核心原则**：`source` = **原始代理名称**，不是语言或协议

| 来源 | Source 标记 |
|------|------------|
| Magenta 自己创建 | `magenta` |
| Claude Code / Pi 扩展 | `pi` |
| GitHub Copilot | `codex` |
| 其他代理 | 该代理的名称 |

**永远不要**：
- ❌ 仅因为 Magenta 做了集成就用 `magenta` 标记产品
- ❌ 使用 `typescript`、`rust`、`python` 作为 source（这些是语言）

**正确做法**：
- ✅ 转换的 Pi 扩展 → `source = "pi"`
- ✅ 从外部仓库迁移的包 → 记录该仓库的来源
- ✅ Self-evo 本身 → `source = "magenta"`（因为自我进化的**行为**是 Magenta 的）

---

## 🎯 使用场景示例

### 场景 1：用户说"创建一个分析财务报表的 skill"
```
1. self-evo 加载
2. 路由到 skill-creator
3. Capture Intent: 问清楚财务分析的具体需求
4. 研究：查找现有 skills、相关 tools
5. 编写 SKILL.md：财务指标计算、报表解读流程
6. 创建测试用例：3个不同公司的财报
7. Sub-agent 并行测试（with_skill vs without_skill）
8. 用户审查输出，提供反馈
9. 迭代改进
10. npm run build/test/check → 注册到 harness.toml
```

### 场景 2：用户说"集成 Pi 的 markdown-to-slides 扩展"
```
1. self-evo 加载
2. 路由到 extension-intake
3. 获取：从 pi/coding-agent/examples/extensions/ 读取
4. 审查：发现它注册了一个 tool（markdownToSlides）
5. 安全检查：需要写文件、调用外部库
6. 决定：单一工具，轻依赖 → dissolve
7. 路由到 extension-conversion
8. 转换：
   - 剥离 ExtensionAPI 包装
   - 提取 tool 逻辑
   - 创建 harness/modules/tools/markdown-to-slides/pi/
   - 编写 markdown-to-slides.toml
   - 连接 NativeToolMagnet
9. 注册到 harness.toml
10. 门控验证
```

### 场景 3：用户说"把 AutOmicScience 项目集成进来"
```
1. self-evo 加载
2. 路由到 package-forge
3. 审查：完整的生物信息学工具套件，Python + pixi，多个工具
4. 决定：重量级，独立环境 → encapsulate
5. 创建 packages/AutOmicScience/
6. 编写 package.toml
7. 复制 pixi.toml + pixi.lock
8. 为每个工具创建描述符（process tools）
9. 声明运行时（aose_omics_runtime）
10. 门控验证，inspect 确认 package 解析
```

---

## 🚀 总结

Magenta 的 self-evo 是一个**1010 行的完整自我进化体系**：

- **213 行** 父技能提供路由和基础流程
- **539 行** skill-creator 实现 Claude 风格的迭代式 skill 创建
- **150 行** Pi 扩展路径（intake + conversion）
- **108 行** package-forge 封装重量级项目

所有子技能都是"章节"（`disable-model-invocation: true`），只能通过父技能访问，确保统一的入口点和流程。

**核心价值**：
- ✅ 规范化的自我扩展流程
- ✅ 明确的原语和源纪律
- ✅ 溶解 vs 封装的清晰判断
- ✅ 完整的验证门控
- ✅ 保留所有来源信息

**Magenta 现在可以自我进化了！** 🎉
