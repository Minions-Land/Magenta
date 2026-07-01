# Compaction 去重迁移:pi → harness(HCP/Magnet adapter)

- 状态:Completed(已落地; pi 侧保留 adapter, harness 为实现源)
- 日期:2026-07-01
- 仓库:`/Users/mjm/Magenta3`
- 前置:prompt-templates 与 skills 格式化已完成同类迁移(见 commit `6323a84`、`dd43065`),模式已验证。

## 0. 背景与目标

harness 重组后,`compaction`、`prompt-templates`、`system-prompt` 三个模块在 harness 下有了副本,但 pi 仍在用本地实现,形成重复。目标是按 **"越具体的下沉到 harness,越抽象的留在 pi"** 的原则去重:
harness 持有具体实现,pi 持有抽象接口 + 通过 Magnet adapter 注入具体依赖(DI 接缝)。

prompt-templates / skills 已按此模式落地。**compaction 是三者中风险最高、工作量最大的一个**,单独用本 spec 跟踪。

## 1. 为什么 compaction 不是薄 adapter

前两个模块:harness 有完整具体实现,pi 只需薄包装 + 注入 `sourceInfo`。
compaction **不同**:两边在 API 迁移的两个不同时间点分叉,形成两套**互不为超集**的实现。

| 维度 | pi 版(在用,`pi/coding-agent/src/core/compaction/`,893+371+170 行) | harness 版(死代码,`harness/compaction/pi/`,747+261+144 行) |
|---|---|---|
| LLM 调用 | 自由函数 `completeSimple`(来自 `@earendil-works/pi-ai/compat`)+ 显式传 `apiKey`/`headers`/`env`/`streamFn` | 注入 `Models` provider 对象,调 `models.completeSimple(...)` 方法(auth 已内置) |
| 流式 | **支持 `StreamFn` 流式**(compaction 时流式显示推理过程,有专门测试 `compaction-summary-reasoning.test.ts`) | **无 `StreamFn` 概念** |
| 错误处理 | 抛异常 / 返回裸对象 | `Result<T,E>` 判别联合(`err`/`ok`,`CompactionError`/`BranchSummaryError`/`SessionError`) |
| 会话类型 | `SessionEntry`(来自 `../session-manager.ts`) | `SessionTreeEntry`(来自 `../../types/types.ts`) |
| session I/O | `buildSessionContext` from `../session-manager.ts` | `buildSessionContext` from `../../session/pi/session.ts` |
| messages | `../messages.ts` | `../../messages/messages.ts`(同函数,相对路径不同) |
| 同步性 | `collectEntriesForBranchSummary` **同步** | 同名函数 **async** |
| 独有导出 | `SUMMARIZATION_SYSTEM_PROMPT`(在 pi `utils.ts`)、`StreamFn`/`SimpleStreamOptions`/`Context` 相关、本地定义的 `BranchSummaryResult` | 把 `SUMMARIZATION_SYSTEM_PROMPT` 移进了 `compaction.ts`;`BranchSummaryResult` 从 `types.ts` import |
| 测试 | **9 个 compaction 测试文件**(见 §5) | **零测试** |

关键结论:pi 功能更全(流式、更多公开导出)但用旧的显式传参风格;harness 抽象更干净(Result、Models DI)但**砍掉了流式**、缺 pi 的公开导出。谁都不是对方超集。

## 2. 风险

- compaction 是**长会话自动压缩的承重逻辑**。压缩出错会**静默损坏会话历史**(裁剪点算错、摘要丢失)。
- 目标 harness 侧**零测试**保护。
- pi 的流式 compaction(`StreamFn`)是真实在用的能力,`agent-session.ts` 多处引用 `this.agent.streamFn`(行 398/1723/1922/1997/2820)。盲目切到 harness 会丢流式推理显示。

## 3. 迁移方案(分步,每步验证)

### 步骤 A — 补齐 harness 能力到 pi 水平
1. 给 harness compaction 加回 `StreamFn` 流式支持(可选参数,不破坏现有 async 签名)。
2. 补 pi 独有的公开导出:`SUMMARIZATION_SYSTEM_PROMPT`(决定放 utils 还是 compaction,与 pi 对齐)、以及 pi `index.ts` re-export 的全部符号(见 §4 清单)。
3. 决定 `utils.ts` 是否从 `harness/index.ts` 导出。当前 harness **不导出** `compaction/pi/utils.ts`,仅在 `compaction.ts:627` re-export 了 `serializeConversation`。pi 则 `export * from "./utils.ts"`。要保 pi 公开面,需让这些 utils 符号可达。

### 步骤 B — pi 侧写 Models-shaped adapter(Magnet 接缝)
4. 写一个 adapter 把 pi 的 `completeSimple` + `apiKey/headers/env/streamFn` 包装成 harness 期望的 `Models` provider 对象(`models.completeSimple(...)`)。这是核心 DI 接缝:自由函数+auth 参数 ↔ provider 对象。
5. 调和 `SessionEntry`(pi)vs `SessionTreeEntry`(harness)类型。确认二者结构关系,必要时在 adapter 层做映射。
6. 调和 `Result<T,E>`(harness)与 pi 的抛异常/裸对象风格:adapter 层把 harness 的 `Result` 解包成 pi 消费方期望的形态。

### 步骤 C — 切换 pi 引用
7. 把 `pi/coding-agent/src/core/compaction/{compaction,branch-summarization,utils}.ts` 改成 adapter,委托 harness,保留:
   - `index.ts` 的 `export * from` 三个文件(公开面不变)
   - `agent-session.ts` 导入的符号:`CompactionResult`、`calculateContextTokens`、`collectEntriesForBranchSummary`、`compact`、`estimateContextTokens`、`estimateTokens`、`generateBranchSummary`、`prepareCompaction`、`shouldCompact`
   - `pi/coding-agent/src/index.ts` re-export 的符号(见 §4)
   - `extensions/types.ts` 的 `CompactionPreparation`/`CompactionResult`

### 步骤 D — 验证
8. 跑全部 9 组 compaction 测试(见 §5)+ resource-loader + agent-session 相关测试,全绿。
9. 全量 build 干净。
10. 特别验证流式 compaction(`compaction-summary-reasoning.test.ts`)与 extensions 示例(`compaction-extensions*.test.ts`)。

## 4. 必须保留的 pi 公开导出(来自 `pi/coding-agent/src/index.ts`)

`CompactionResult`(type)、`calculateContextTokens`、`compact`、`estimateTokens`、`findCutPoint`、`generateBranchSummary`、`generateSummary`、`serializeConversation`、`shouldCompact`、`CompactionEntry`(type)、`getLatestCompactionEntry`、`CompactionSettings`(type)、`CompactionSummaryMessageComponent`。
另:`extensions/types.ts` 依赖 `CompactionPreparation`、`CompactionResult`。
`agent-session.ts` 额外依赖 `collectEntriesForBranchSummary`、`estimateContextTokens`、`prepareCompaction`。

## 5. 必须保持全绿的测试(pi/coding-agent/test/)

- `compaction.test.ts`
- `agent-session-compaction.test.ts`
- `agent-session-auto-compaction-queue.test.ts`
- `compaction-serialization.test.ts`(直接从 `../src/core/compaction/utils.ts` 导入 `serializeConversation`)
- `compaction-summary-reasoning.test.ts`(流式推理,关键)
- `compaction-extensions.test.ts`
- `compaction-extensions-example.test.ts`
- `interactive-mode-compaction.test.ts`
- `trigger-compact-extension.test.ts`

## 6. utils.ts 事实(已核实)

- pi `utils.ts` 导出:`FileOperations`、`createFileOps`、`extractFileOpsFromMessage`、`computeFileLists`、`formatFileOperations`、`serializeConversation`、`SUMMARIZATION_SYSTEM_PROMPT`(+ 私有 `truncateForSummary`、`TOOL_RESULT_MAX_CHARS`)。
- harness `utils.ts` **几乎逐字重复**上述前 6 个,差异:(a) harness `serializeConversation` 用本地 `safeJsonStringify` 而非裸 `JSON.stringify`(不会在循环引用时抛错);(b) harness `utils.ts` **不含** `SUMMARIZATION_SYSTEM_PROMPT`(被移进了 harness `compaction.ts`)。
- harness `index.ts` 不导出 utils,仅 `compaction.ts:627` re-export `serializeConversation`。
- pi utils 的唯一直接路径导入者:`compaction-serialization.test.ts`;其余都走 barrel。

## 6.5 实施环境与命令(工作在独立 worktree/分支)

- **worktree**:`/Users/mjm/Magenta3-compaction`,分支 `compaction-dedup`(基于 main `6795c67`)。所有 compaction 改动在此进行,不碰主树。已 `npm install`,有独立 node_modules。
- **关键构建约束**:`@magenta/harness` **没有** vitest alias(不像 pi-ai/pi-agent-core/pi-tui alias 到源码),经 node_modules 符号链接解析到 `harness/dist`。**改了 harness 源码后必须先 build harness,测试/CLI 才能看到新代码。**
- **构建命令**(有序,harness 依赖 pi-ai/pi-agent-core 的 dist):
  - 全量:`cd /Users/mjm/Magenta3-compaction && npm run build`(baseline 已验证通过)
  - 单独 harness(pi 包 dist 已存在时):`npm run build -w @magenta/harness`
  - coding-agent:`npm run build -w @earendil-works/pi-coding-agent`
- **单测**(vitest,worktree 内):`cd /Users/mjm/Magenta3-compaction/pi/coding-agent && npx vitest run test/<file>`。
  - 注意:`compaction.test.ts` 的 LLM 段是 `describe.skipIf(!process.env.ANTHROPIC_OAUTH_TOKEN)`,无 token 时跳过;其余 23 个测试纯同步、快。
  - `compact(preparation, model, apiKey)`、`generateBranchSummary(...)` 等 **pi 现有调用签名必须保持不变**(测试直接这样调)。
- **真实终端验证**(Playwright + node-pty,verificator 用):
  - config:`/Users/mjm/Magenta3/playwright.config.ts`(testDir `tests/e2e/`,`workers:1`)。在 worktree 里对应 `/Users/mjm/Magenta3-compaction/playwright.config.ts`。
  - 需先 `npm run build`(TUI 测试跑 `pi/coding-agent/dist/cli.js`)。
  - 跑 TUI:`cd /Users/mjm/Magenta3-compaction && npx playwright test --project=tui-tests`。
  - compaction 真实终端场景:TUI 里输入 `/compact`(见 `interactive-mode.ts:2639`)触发压缩,断言出现压缩摘要组件且会话未损坏。需要 `ANTHROPIC_OAUTH_TOKEN`(外部 auth 已配)。
- **9 组必过单测**见 §5。

## 7. 完成标准

- pi compaction 三文件变为薄 adapter,具体逻辑只存在于 harness。
- 9 组 compaction 测试 + 下游全绿,build 干净。
- 流式 compaction 能力保留。
- pi 公开 API 面不变(§4 全部符号可达)。
- 删除 harness 侧的死代码分叉,harness 成为唯一实现源。
