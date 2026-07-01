# Magenta3 Harness 重组:模块化 harness + HCP/Magnet 装配层

- 状态:Design → Implementing
- 日期:2026-06-30
- 仓库:`/Users/mjm/Magenta3`

## 0. 目标(用户原话提炼)

1. harness 下每个文件夹只代表一个**组件(module)**,具体实现放进该组件下的
   **实现子目录**,比如 pi 的实现就是 `harness/compaction/pi/xxx.ts`。
2. harness 下直接是 module 组件(**不要** general-harness 那种
   `components/<category>/<component>` 的两层分类)。
3. 把 **HCP** 和 **Magnet** 坐进 harness(TS 实现,装配层)。
4. **tools** 移到 `harness/tools`。
5. `pi/` 最终只剩基础逻辑:**llm provider / tui / cli / agent loop**。
6. TOML/YAML 注册表提前做好,含 HCP。
7. 用 TS 做快速开发。
8. **最终诉求**:PI 代码里的 Tool Call 与 Harness 部分**只剩抽象概念**——
   真正实现下沉到 harness,pi 侧只持有 `trait Tool`/harness 接口等抽象,
   装配阶段由 HCP/Magnet 把实现注入 loop。

## 1. 参考架构提炼

- **general-harness**(成熟,Rust):`components/<category>/<component>/<name>.toml`
  + 顶层 `harness.toml` 注册索引。每个组件一个声明式 TOML(kind/name/
  description/parameters schema/capabilities)。**用户要去掉 `<category>` 中间层**。
- **Magenta2 specs**(最新,非过时)关键纠正:
  - `magenta-hcp` = 纯协议/管理层,**HCP 不在热路径**。loop 直接进程内
    `tool.execute()`,不把 tool call 包成 HCP 消息。否定旧 "Tool Call = HCP Call"。
  - HCP/Magnet 在**装配阶段**:发现/接入/配置组件 → 产出 loop 用的工具集合
    `Vec<Box<dyn Tool>>`(TS 里是 `AgentTool[]`)。core 对工具一视同仁。
  - core 的工具抽象 = `trait Tool { name; schema; execute() }`,execute 抛错而非
    编码进 content。**这正是 pi 现有的 `AgentTool`**。

## 2. 现状关键事实(已核实)

- pi **100% 走包级导入** `@magenta/harness`,零深引内部文件
  → harness 内部重构对 pi 完全绝缘,只改 `harness/index.ts`。
- harness 内部跨模块相对引用 32 处,集中在 compaction/loop/session/messages/types。
- 工具**已是两层**:`createXxxTool = wrapToolDefinition(createXxxToolDefinition(...))`。
  - `AgentTool`(`pi/agent/src/types.ts:371`)= 纯执行,execute 抛错 = Magenta2 `trait Tool`。
  - `ToolDefinition`(`extensions/types.ts:435`)= execute + renderCall/renderResult + prompt 元数据。
  - 接缝天然:execute/schema/ops/类型 = 纯逻辑;renderCall/renderResult/format* = 渲染。
- 工具支撑文件分类:
  - PURE→harness:`truncate.ts` `path-utils.ts` `output-accumulator.ts`
    `file-mutation-queue.ts` `edit-diff.ts`(560 行核心算法,唯一 render-ref 是注释)
  - RENDER→pi:`render-utils.ts` `tool-definition-wrapper.ts`(wrapToolDefinition 本身)
- 工具行数:bash 453 / edit 437 / read 362 / grep 385 / find 374 / write 267 / ls 225,
  渲染相关 ~200 行集中在 edit/write/read。

## 3. 目标结构

```
harness/
  <module>/<impl>/...        # 每个组件一个目录,实现进 <impl>/ 子目录
  compaction/pi/             # branch-summarization.ts compaction.ts utils.ts
  prompt-templates/pi/       # prompt-templates.ts
  skills/pi/                 # skills.ts
  system-prompt/pi/          # system-prompt.ts
  messages/                  # 通用类型,扁平不下沉(无 pi 专属语义)
  session/                   # 已提炼,保持现状(用户明示不动)
  loop/                      # 已提炼,保持现状(用户明示不动)
  types/ env/ utils/         # 通用,扁平不动
  tools/                     # 新:工具纯执行逻辑
    tool.ts                  #   Tool 抽象(re-export AgentTool 形状 + 工厂契约)
    pi/                      #   bash.ts edit.ts read.ts write.ts grep.ts find.ts ls.ts(去渲染)
    pi/support/              #   truncate path-utils output-accumulator file-mutation-queue edit-diff
  hcp/                       # 新:管理协议(TS 装配层,不入热路径)
    hcp.ts                   #   HcpTarget/HcpCall/HcpRegistry 接口 + 进程内 dispatch
  magnet/                    # 新:连接器
    magnet.ts                #   Magnet 接口:把实现包装成 Tool/HCP target
    native.ts                #   原生 TS 工具 magnet(包装 harness/tools/pi)
    (mcp/api/process 后续)
  registry/                  # 新:TOML 注册表加载器
    registry.ts              #   读 harness.toml + 各组件 *.toml → 组件目录
  harness.toml               # 顶层注册索引(去掉 category 层)
  <module>/<impl>/*.toml     # 每个实现一个声明式 TOML

pi/                          # 最终只剩基础逻辑
  ai/                        #   llm provider(不动)
  tui/                       #   tui(渲染层,工具渲染器迁入这里)
  agent/                     #   agent loop(不动,持有 AgentTool 抽象)
  coding-agent/              #   cli + 装配:从 harness 取实现,缝渲染器,注入 loop
    src/core/tools/          #   只剩渲染器 + ToolDefinition 装配(execute 来自 harness)
```

## 4. 工具拆分机制(发现1 的解法)

每个工具 `xxx.ts` 拆成:
- `harness/tools/pi/xxx.ts`:导出 `xxxSchema`、`xxxExecute`(纯 execute)、
  `XxxOperations`(可注入 ops)、`createXxxAgentTool(cwd, opts): AgentTool`、所有纯类型。
  **禁止** import theme/pi-tui/interactive。
- `pi/coding-agent/src/core/tools/xxx.ts`:导入 harness 的 execute+schema,
  保留 `renderCall`/`renderResult`/`format*`,组装成 `createXxxToolDefinition`。
  `createXxxTool = wrapToolDefinition(createXxxToolDefinition(...))` 不变。

对 pi 的公开 API(`createCodingTools`/`createAllToolDefinitions` 等)**签名完全不变**,
只是内部 execute 来自 harness。→ 所有调用点(index/agent-session/sdk/interactive 等)零改动。

## 5. HCP / Magnet / Registry(装配层,TS)

- **HCP**:`target` (URI-like) + `op` + `input` + `context`,进程内 dispatch。
  不入 loop 热路径。仅用于"发现/接入/配置/管理"组件。
- **Magnet**:连接器接口,把一种实现(原生 TS / 后续 mcp/api/process)
  注册为 HCP target 并能产出 `AgentTool`。第一版只做 `native` magnet(包 harness/tools/pi)。
- **Registry**:加载 `harness.toml` + 各 `*.toml`,枚举组件。第一版做加载 + 校验 +
  按 kind 返回组件描述;装配产出 `AgentTool[]` 交给 loop。

## 6. 分阶段(workflow 一次性执行,阶段内并行)

- P1:harness 重构成 `<module>/<impl>/` + 修内部相对 import + 改 index.ts。build+test 绿。
- P2:工具拆分 —— 7 工具并行,各拆 execute→harness / render→pi。pi 公开 API 不变。
- P3:HCP/Magnet/Registry 骨架 + TOML 注册表(harness.toml + 各组件 toml)。
- P4:瘦身校验 —— 确认 pi 侧 tools 目录只剩渲染+装配,跑全量 test + build + 类型检查。

## 7. 验证

- 每阶段:`npm run build`(harness→tui→ai→agent→coding-agent)+ `npm test`(pi 1459 tests)绿。
- 不变量:pi 对 harness 零深引;工具 pi 公开 API 签名不变;harness/tools/pi 不依赖 tui。
- 类型:`tsgo -p tsconfig.build.json --noEmit`。
