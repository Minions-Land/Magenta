# Magenta3 设计:基于 PI 的统一 Harness 重构

- 状态:Design / 待用户复核
- 日期:2026-06-30
- 仓库:`/Users/mjm/Magenta3`(唯一 git 仓,根级)
- 子项目:Magenta 主线第 1 阶段

## 1. 定位

Magenta3 是新主线,基于 PI(已验证的 TS coding-agent)开发,用 TypeScript 快速迭代,
取代此前的 Rust 路线。最终形态:

> **纯 agent loop 内核 + 一个统一的顶层 Harness 层。** 所有可插拔能力
> (Tool / Memory / Hook / Compact)从内核解耦,集中到顶层 `harness/` 统一管理。
> `harness/` 就是未来 HCP/Magnet 的落点。

PI 相关说明保留,但 PI 的 monorepo 排布可以打散。Package 机制暂当不存在,后续再谈。

本阶段范围(用户定:"一步到位提四块"):一次性把 Tool / Memory / Hook / Compact
四类能力提炼进顶层 Harness 统一管理,同时跑通真实对话。

> **已知的未来能力:Skill。** Harness 层还会纳入 Skill 作为又一类可插拔能力
> (PI 的 `agent/harness/skills.ts` 本就在 harness 域内,Skill 天然与
> Tool/Memory/Hook/Compact 并列)。本阶段不展开 Skill 设计,搬迁 Harness 时
> 保留其现有机制即可,留待后续子项目细化。

## 2. 现状(需清理)

之前另一个 Codex 在 `Magenta3/` 搭了一套已"跑通"但不符合规划的结构:

```
Magenta3/
├── .git/                 根 git,已跟踪 ~1029 文件
├── docs/
└── Magenta/              ← 要消除的嵌套层
    ├── pi/               PI monorepo 拷贝(无独立 git)
    ├── LazyPi/           LazyPi 原样拷贝
    ├── .pi/agent/        从 LazyPi 复制的活动配置(经 MAGENTA_CODING_AGENT_DIR 加载)
    └── package.json      用 tsx 跑 cli.ts
```

问题:① 多套一层 `Magenta/`;② LazyPi 仍是外挂配置(靠环境变量硬加载),
而非融入代码;③ 能力未提炼。Codex 已把 coding-agent 的 `piConfig.name` 改成 "Magenta"。

## 3. 查证结论(决定提炼难度的关键事实)

读 PI 源码后修正了若干假设:

- **PI 的 `agent` 包(`@earendil-works/pi-agent-core`)本身已是一个 Harness 层**。
  `packages/agent/src/harness/agent-harness.ts` 的 `AgentHarness` 类已统一管理:
  - 工具:`private tools = new Map<string, TTool>()`
  - 压缩:`async compact(...)` + `session_before_compact` hook
  - 钩子:`emitHook(...)`、`normalizeHarnessError(error, "hook")`
  所以 **Compact 和 Hook 已存在**,不是从零造。
- **工具实现**(bash/edit/find/grep/ls/read/write)在 `coding-agent/core/tools/`,
  通过 `agent/src/types.ts` 的统一 `AgentTool` 接口被 harness 注册。
- **Memory 不存在**独立子系统("memory" 一词散落在 settings/session/read,指上下文),
  是唯一需要全新设计的部分。
- **PI 原生没有 search/fetch 工具**(来自 `pi-web-access` 包,已约定忽略)。
  第一阶段原生工具 = bash/edit/find/grep/ls/read/write 七个。
- **依赖方向干净**:`ai ← agent ← coding-agent`,`tui` 独立,无循环。

## 4. 顶层目录布局

决策:消除嵌套、PI 提到根、另起顶层 `harness/`、搬迁 `agent/harness` 到顶层、
不单独建 git。

```
Magenta3/                      ← 唯一 git 仓
├── packages/                  ← PI 的包提到根(打散原 monorepo 外层)
│   ├── ai/                    LLM 抽象(PI 原样保留)
│   ├── tui/                   终端 UI(PI 原样保留)
│   └── core/                  纯 agent loop 内核 + CLI/TUI 应用层
│                              (= 原 agent 包去掉 harness/ 后的 loop + 原 coding-agent)
├── harness/                   ← 【核心】统一 Harness 层(HCP/Magnet 的家)
│   │                            = 原 agent 包里【所有】harness 相关物整体解耦提上来
│   ├── src/                    原 agent/src/harness/(19 文件)
│   │   ├── agent-harness.ts   AgentHarness 主类(统管 tools/compact/hook)
│   │   ├── compaction/        Compact(已有)
│   │   ├── session/           会话持久化(含 memory-repo = 内存型 session 存储,非长期记忆)
│   │   ├── skills.ts          Skill(已有,搬迁保留)
│   │   ├── system-prompt.ts / prompt-templates.ts / messages.ts / types.ts
│   │   ├── env/ utils/
│   │   ├── tools/             【收拢】7 个原生工具实现 + 融入的 LazyPi 工具
│   │   └── memory/            【全新】长期记忆子系统(与 session/memory-* 区分)
│   ├── test/                  原 agent/test/harness/(13 测试 ~2890 行)
│   ├── docs/                  原 agent/docs/{agent-harness,durable-harness}.md
│   ├── vitest.config.ts       原 agent/vitest.harness.config.ts
│   └── index.ts               Harness 装配 + 对外导出(吸收原 agent/src/index.ts 的 harness 导出行)
├── docs/                      specs / plans
├── package.json               根 workspace(重组)
└── README.md
```

依赖方向(搬迁后):`ai` ← `harness` ← `core`(内核反向依赖 harness 取得能力)。
**已验证耦合是单向的**:内核候选(`agent-loop.ts`/`agent.ts`/`proxy.ts`/`src/types.ts`)
**零引用 harness**;只有 harness 引用内核(`../types.ts`/`../agent-loop.ts` 等)。
故内核可干净留下,harness 整体搬走只需重接它对内核的引用 + 重接 index/node 导出,
不产生循环。

## 5. 能力提炼计划(整体提升 + 收拢 + 新建)

核心动作:**把 `packages/agent` 里【所有】harness 相关物整体解耦到顶层 `harness/`**
——不止 `src/harness/`,而是六处全迁:

| harness 相关物 | 位置 | 动作 |
|---|---|---|
| 源码 | `src/harness/`(19 文件 ~5909 行) | 提到 `harness/src/` |
| 测试 | `test/harness/`(13 测试 ~2890 行) | 提到 `harness/test/` |
| 测试配置 | `vitest.harness.config.ts` | 提到 `harness/vitest.config.ts` |
| 文档 | `docs/agent-harness.md` + `docs/durable-harness.md`(698 行) | 提到 `harness/docs/` |
| 对外导出 | `src/index.ts` 的 16 行 `export ... from "./harness/..."` | 移入 `harness/index.ts` |
| node env 导出 | `src/node.ts` 的 `NodeExecutionEnv` | 随之重接 |

`agent` 包只留 loop 内核(`agent-loop.ts`/`agent.ts`/`proxy.ts`/`types.ts`)。
主要机械工作量 = 重接跨目录 import(harness 原本引用 `../types.ts`/`../messages.ts`/
`../agent-loop.ts`)+ 重接 index/node 导出 + 修正测试相对路径。

| 能力 | 来源 | 动作 |
|---|---|---|
| **Compact / Hook / Skill / session / 系统提示** | `agent/src/harness/` 内已有 | 随整个文件夹一并提上,保留现有机制 |
| **Tool(实现)** | `coding-agent/core/tools/*`(7 个)+ 融入的 LazyPi 工具 | **收拢**进 `harness/src/tools/`,保留统一 `AgentTool` 接口;内核通过 harness 取工具集 |
| **Memory(长期记忆)** | 无(全新) | 见 §6;注意与 `harness/src/session/memory-*` 区分 |

`AgentHarness` 类是核心载体:它本就持有 tools/compact/hook,整体提上后内核 loop
通过它取得一切可插拔能力。

## 6. Memory 子系统(全新,最小可用)

第一阶段只做最小骨架,作为 Harness 管理的一类能力,接口先立、实现可简:

- **职责**:为 agent 提供跨轮/跨会话的可检索长期记忆(区别于 compaction 的"压缩历史",
  也区别于 `harness/session/memory-*` —— 后者是内存型 session 存储,不是长期记忆)。
- **接口(初版)**:`harness/src/memory/` 暴露 `MemoryProvider`,提供
  `read(query)` / `write(entry)` 两个原子能力,挂进 Harness 的能力集。
- **实现(初版)**:文件型最小实现即可(读写本地 memory 目录),复杂检索/向量化留后续。
- 设计上对齐"原子能力 + LLM 编排"的原则(Bitter Lesson),不在第一版做编排逻辑。

## 7. LazyPi 融入(全部进代码,不再硬加载)

6 个 extension(~3933 行)按能力性质拆分归位,不再走 extension loader 动态加载:

| Extension | 性质 | 归位 |
|---|---|---|
| background-jobs(bg_shell / sub_agent) | 工具 | `harness/tools/` |
| todo | 工具 | `harness/tools/` |
| ssh | 工具 | `harness/tools/` |
| side-chat(`/side`、`/btw`) | 交互 | 应用层(`packages/core` 的 TUI) |
| command-aliases | 交互 | 应用层 |
| ui-optimize | 渲染 | 应用层 |

## 8. PI 跑通(贯穿全程的验收基线)

提炼是大改动,必须保证每一步后 PI 仍能跑。验收基线 = 跑通真实对话:

1. 根 `npm install --ignore-scripts` + `npm run build`(tsgo 编译,产出 CLI)。
2. `magenta -p "say hello"` 非交互跑一轮,OpenAI provider + `gpt-5.5`,拿到真实回复。
3. 融入的 LazyPi 能力可用:`/jobs`、`/side`、todo、bg_shell 正常工作。

## 9. 凭证

`bin/magenta`(或根 scripts)启动时从本地配置抓 key,注入子进程环境,不落盘、不打印:
- OpenAI:读 `~/.codex/auth.json` 的 `OPENAI_API_KEY` → 注入 `OPENAI_API_KEY`。
- Anthropic(备选):环境中 `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL`,需验证 base URL 兼容。
当前 shell 无 `OPENAI_API_KEY`,但 `~/.codex/auth.json` 有,故自动抓取。

## 10. 验证与测试

- 构建:根 `npm run build` 通过。
- PI 自带测试:`./test.sh`(无 key 时自动跳过 LLM 用例);搬迁后全绿是提炼正确的硬指标。
- 提炼回归:每搬一块能力后跑一次真实对话 + 相关测试,确认无功能丢失。
- 清理:临时 session 不入库。

## 11. 实施顺序(分步,每步可跑通)

为控制"一步到位提四块"的风险,内部仍分小步,每步后 PI 必须仍跑通:

1. **清理 + 摊平**:删 `Magenta/` 嵌套层,PI 包提到 `packages/`,重组根 workspace,
   构建 + 真实对话验收(此时未提炼,确认基线)。
2. **LazyPi 融入**:6 个 extension 拆分归位为内置代码,验收。
3. **整体解耦 Harness**:把 `packages/agent` 里所有 harness 相关物(源码 `src/harness/`、
   测试 `test/harness/`、配置 `vitest.harness.config.ts`、文档两份、index/node 导出)
   全部提到顶层 `harness/`;`agent` 包只留 loop 内核(已验证内核零引用 harness);
   工具实现收拢进 `harness/src/tools/`,重接 import/导出/测试路径,内核反向依赖,验收。
4. **新建 Memory**:最小 `MemoryProvider` 挂进 Harness,验收。

## 12. 关键决策记录

- Magenta3 = 新主线,TS 基于 PI,取代 Rust。
- 最终形态:纯 loop 内核 + 顶层统一 Harness(Tool/Memory/Hook/Compact),= HCP/Magnet 落点。
- 消除 `Magenta/` 嵌套;PI 包提到根 `packages/`;不单独建 git。
- 另起顶层 `harness/`:把 PI `agent` 包里**所有** harness 相关物**整体解耦**提上来
  (源码 `src/harness/` + 测试 `test/harness/` + `vitest.harness.config.ts` + 两份 docs
  + index/node 导出,六处全迁),`agent` 包只留 loop 内核(接受打散 PI 排布的代价)。
- 已验证耦合单向:内核零引用 harness,仅 harness 引用内核,故解耦无循环风险。
- LazyPi 全部融入代码,不再 extension 硬加载;按性质分入 harness/tools 或应用层。
- Compact/Hook/Skill 已存在(在 agent/harness),随文件夹一并提上;Memory 全新最小实现,
  与 harness/session/memory-*(内存型 session 存储)区分。
- Package 与其他 Harness 暂当不存在。
- 验收基线 = 真实对话(OpenAI + gpt-5.5);每步提炼后回归。

## 13. 后续子项目(本 spec 之外)

1. HCP/Magnet 的完整协议:散装工具双属性模型(`implementation_name` + `source_harness`)
   + Magnet 连接配置 + Schema 注册表(`schema_profile` + `param_mapping`)+ 回退选择器 + Pack
   (草稿:`Reference_Repo/Magenta-main/DRAFT-tool-pluggable-management.md`)。
2. Memory 子系统进阶(检索/向量化/跨会话策略)。
3. Skill 作为 Harness 可插拔能力的细化(搬迁阶段先保留 PI 现有机制)。
4. Package 机制与其他 Harness 接入。
5. PI 引擎品牌彻底改名(如需要)。
