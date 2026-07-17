# Pi v0.80.8 升级与 Magenta/HCP 冲突边界审查

## 0. 审查范围与基准

- Magenta current: `/Users/mjm/Magenta3` at `4a08f6305ed3fa88067d7dbd9a19ced606dcef0f`。
- Upstream U2: tag/checkout `v0.80.2` at `0201806adfa825ab3d7957a4267d46e5030fd357`。
- Upstream U8: tag/checkout `v0.80.8` at `fae7176cb9f7c4725a40d9d481d8d70b80f18086`。
- Upstream Git evidence: `/tmp/magenta-pi-upstream-v0.80.8-20260717`。
- Import snapshot: `/tmp/magenta-import-f1da4c/pi`，用于辨认 `f1da4c9` 后已经迁出 Pi 的 HCP 代码；最终 owner 判断均以 current `4a08f63` 为准。
- Current 仍把四个 Pi workspace 标为 `0.80.2`，证据：`pi/ai/package.json:3`、`pi/agent/package.json:3`、`pi/tui/package.json:3`、`pi/coding-agent/package.json:3`；coding-agent 的三个内部 Pi 依赖也固定为 `0.80.2`，见 `pi/coding-agent/package.json:45-47`。
- 本次只读审查没有修改主仓库，也没有运行会改写生成物/格式的 gate。

## 1. 结论

**总决策：有条件 GO，禁止 big-bang 覆盖。** 应把 `v0.80.2..v0.80.8` 拆成 owner 对齐的语义批次：Pi 保留 ModelRuntime/auth/provider、extension API、dynamic-tool turn refresh、TUI 与构建；已经抽入 HCP 的 session primitive 和 compaction 只接受“语义移植”，不能从 upstream 路径覆盖回来。HCP 只负责一次性装配/解析，运行时直接调用已解析产品。

**明确 STOP：**

1. STOP 将 upstream `packages/*` 整树覆盖 current `pi/*`。current 在 agent-session、TUI、multiagent、release 与 HCP adapter 上已有大幅分叉。
2. STOP 把 upstream experimental `pi-orchestrator` 合并成 HCP `multiagent` 或第四种 HCP role。两者分别是 persistent RPC process supervisor 与 sessionless one-shot workflow，生命周期和安全模型不同。
3. STOP 同时保留 current 旧 `ModelRegistry` 状态机和 upstream `ModelRuntime` 状态机。只允许一个 canonical model/auth owner；`ModelRegistry` 最多保留无状态兼容 facade。
4. STOP 为 dynamic tools、provider headers、Package 或 orchestrator 新增第二 registry、第二 Client、per-call HCP middleware。

治理依据：HCP 只有 Client/Server/Magnet 三个 role，且不得新增第二 Client、registry 或 parallel selection service（`HarnessComponentProtocol/docs/governance/contract.md:15-21`）；HCP 在 assembly/resolution 后结束（同文件 `:19`），不进入 tool execution hot path（`HarnessComponentProtocol/docs/governance/hcp-architecture.md:19`）。Application composition、settings、auth、resource loading、session policy 和 UI 属于 `pi/coding-agent`（`contract.md:48-51`）。

## 2. 必须保留的不变量

| INV | 不变量 | 本地证据 | 升级含义 |
|---|---|---|---|
| INV-01 | 每 session 只有一个 `HcpClient`；HCP 仅三 role。 | `contract.md:11-21`；`hcp-architecture.md:9-19` | ModelRuntime/orchestrator 不能包装成新 HCP Client/Server 层。 |
| INV-02 | `HCP_SERVERS`/`HCP_MAGNETS` 是 TOML 生成投影，不是 extensibility registry。 | `contract.md:64-75`；`.HCP/assembly/session-hcp.ts:6,115-121` | Dynamic provider/tool 不得写第二表，也不得手工编辑 `sources.generated.ts`。 |
| INV-03 | HCP assembly 之后消费者直接调用产品。 | `contract.md:19`；current extension runner 已缓存 HookProvider 后直调，`pi/coding-agent/src/core/extensions/runner.ts:292-334` | provider header 与 active-tool refresh 保留在 Pi 请求/turn 路径；不做每请求 HCP resolve。 |
| INV-04 | rejected/replaced/unroutable live product 必须 dispose。 | `contract.md:156`；`.HCP/assembly/session-hcp.ts:192,250,391,395`；`HcpClient.ts:121` | 升级不能绕开 `HcpClientassemble()` 自行注册工具或 capability。 |
| INV-05 | `_magenta/session` 是 host support，不是可选 Module。 | `_magenta/session/README.md:3-16`；`contract.md:38-46` | 上游 session primitive 的改动落这里，不新增 session `HcpServer`。 |
| INV-06 | compaction 已由 HCP `compaction/pi` 拥有，Pi coding-agent 仅为兼容 adapter。 | `pi/coding-agent/src/core/compaction/compaction.ts:1-17`；generated assembly `sources.generated.ts:135-146` | 上游 compaction bugfix 必须语义移植到 HCP owner，不能恢复两份实现。 |
| INV-07 | `multiagent` 是 sessionless one-shot workflow capability，不是 persistent team runtime。 | `HarnessComponentProtocol/multiagent/README.md:3-17`；`multiagent/workflow/magenta/worker.ts:4-35` | upstream persistent orchestrator 不得替代此 slot。 |
| INV-08 | Todo 的完整 branch-aware state 是唯一计划账本。 | `contract.md:123-141` | session/context projector 迁移不得丢失 tool-result details 或创建第二计划存储。 |
| INV-09 | Pi renderer 以 `renderKind` 选择，未知 kind 回退文本。 | `contract.md:91-105` | upstream TUI component 不能覆盖 current renderer registry/HTML export 约定。 |
| INV-10 | current 的 TS7/build/release 是 Magenta owner。 | root `package.json:17,50,58`；`scripts/tsc.mjs:2-20`；`pi/coding-agent/package.json:34-38` | 不接受 upstream TypeScript/Bun/lockfile 的版本回退或脚本整段替换。 |

## 3. HC 决策矩阵

| ID | Upstream 变更 | Current owner / 实现 | 冲突或替代 | 决策 |
|---|---|---|---|---|
| HC-001 | ModelRuntime/auth/provider composition | `pi/ai` + `pi/coding-agent`；current 仍有 600+ 行有状态 `ModelRegistry` | upstream 用 canonical `ModelRuntime` 替换内部 registry | **GO，整簇迁移；旧 registry 降为 facade，不并存** |
| HC-002 | `before_provider_headers` 与请求 header transform | Pi extension API + SDK request path | current HCP `pre-llm` hook 不是 header hook，不能代替 | **GO，保留在 Pi 请求路径；HCP 不进 hot path** |
| HC-003 | message-anchored deferred tools + same-run active tool refresh | `pi/ai`、`pi/agent`、`pi/coding-agent`; HCP 只提供 assembled AgentTool pool | current 有 `setActiveToolsByName()`，缺 upstream transcript marker/turn refresh | **GO，Pi 语义移植；禁止动态重装 HCP** |
| HC-004 | session context projectors、header metadata、short UUID fix | `_magenta/session` primitive + coding-agent session policy | extracted HCP copy停在旧实现；coding-agent 又有应用 facade | **GO，先更新 `_magenta/session`；host facade 只适配，不复制 owner** |
| HC-005 | compaction custom-message accounting、split-turn serialization、pre-prompt no-continue | HCP `compaction/pi` + Pi thin adapter | current HCP split-turn 两摘要仍 `Promise.all`，与 upstream serial fix 冲突 | **GO，语义移植至 HCP；保留 Magenta mid-loop barrier** |
| HC-006 | experimental persistent orchestrator package | Upstream `pi-orchestrator`; current HCP `multiagent` 是另一产品 | persistent RPC/session/RADIUS 与 one-shot workflow 生命周期冲突 | **STOP 默认导入；可在主升级后独立 Pi pilot** |
| HC-007 | TUI normalization/key parsing/status/message rendering | Pi TUI + heavily forked Magenta interactive mode | core fixes可移植；interactive 文件不可覆盖 | **GO，按行为/测试 cherry-pick；拒绝整文件覆盖** |
| HC-008 | OAuth binary bundling、catalog refresh、install lock、Bun/build changes | Pi auth/model + Magenta TS7/release/binary pipeline | upstream build/toolchain落后或结构不同；OAuth bundle fix仍必要 | **GO 部分；保留 Magenta toolchain，移植 bundle/catalog 能力** |
| HC-009 | HCP assembly compatibility across all batches | `HcpClient` + `.HCP/assembly/session-hcp.ts` | 把新 runtime/provider/tool 当 HCP role 会造第四 role/第二 registry | **硬门：默认 assembly 无新增角色/表/hot-path middleware** |

## 4. 各 HC 的可执行适配方案

### HC-001 ModelRuntime/auth: replace, not layer

**Upstream evidence**

- `9993c969 feat(coding-agent): replace model registry with model runtime` 引入 `packages/coding-agent/src/core/model-runtime.ts`、`model-config.ts`、`provider-composer.ts`、runtime credentials/models store，并大幅缩减 `model-registry.ts`。
- 后续 `cd7cad4e`/`ff28097a` 合并 facade，`bd9e09db` 暴露 dynamic provider refresh，`fab309e9` 修复 picker catalog refresh，`97f9978f` 增加 model catalog refresh flag。
- U8 `model-runtime.ts:92-160` 创建唯一 `MutableModels` collection；`:418-483` 在统一 request preparation 中完成 auth、base URL、headers、env；`:496-564` 统一 config reload/refresh/extension provider registration。
- U8 `model-registry.ts:17-24` 明言它只是 extension-facing synchronous compatibility facade，coding-agent internals 直接使用 ModelRuntime。

**Current conflict**

- current `pi/coding-agent/src/core/model-registry.ts:414-451` 自己持有 models、provider request configs、headers、registeredProviders 和 AuthStorage；`:903-921` 也直接注册/注销 provider。这与 U8 ModelRuntime 是两个状态 owner。
- current `pi/ai/src/models.ts:101,198` 已有早期 `Models.refresh(provider?)`，但 U8 已变为 `refresh(options): ModelsRefreshResult`（U8 `packages/ai/src/models.ts:147,276`），所以不能只复制 coding-agent facade。

**Adaptation**

1. 以 upstream `pi/ai` Models/auth/types/provider factories 为第一原子批次，先对齐 `ModelsRefreshOptions/Result`、ModelsStore、OAuth auth contracts。
2. 以 upstream `ModelRuntime + ModelConfig + ProviderComposer + RuntimeCredentials + models-store + remote-catalog-provider` 为第二原子批次。
3. 先拆开 current `loadExternalAuth()` 中混合的 environment 与 Claude/Codex read-only file sources，再构造单一 composite credential resolver；不能直接把现有混合API包成adapter，也不能在 ModelRuntime 外再建 overlay map。
4. 只有Magenta-owned store可mutate/logout；external file只读；environment只解析一次，`includeFallback=false`不得绕回env。external baseUrl属于request auth/config，不修改catalog。
5. coding-agent internals 全部改用 ModelRuntime；仅 extension context 暂时暴露 upstream 兼容 `ModelRegistry(runtime)` facade。facade 不持有 models/auth/provider map。
6. HCP 不新增 `model-runtime` Module/Capability。治理已明确 auth 属于 application composition（`contract.md:48-51`）。HCP compaction 继续通过调用参数接受 `Models`，不拥有 credential lifecycle。

**Must preserve**

- Current Magenta model extensions、external auth/baseUrl、Codex cache telemetry、unknown-price handling与 `max` thinking 支持。
- 只有一个 provider collection 与一个 credential mutation path。
- OAuth refresh/storage failure必须显式传播，不能静默回退到另一个 registry。

**Tests / rollback**

- 先跑 U8 `packages/ai/test/models-runtime.test.ts`、OAuth/auth/provider tests，再跑 coding-agent `model-runtime-auth-options`、cloudflare compat、modify-models compat、model resolver/picker tests。
- 增加 synthetic Magenta stored/external-file/env/ambient collision、baseUrl、`includeFallback=false`、logout ownership、unknown-price、GPT-5.6 max-thinking 回归；不得读取真实credential fixture。
- rollback boundary分为“pi-ai contract commit set”与“coding ModelRuntime commit set”；第二批失败可整体回退到旧registry，但不得发布半迁移状态。新`models-store.json`是cache，可删除回滚；真实`auth.json`不得由测试/migration/rollback读取、备份或重写。

### HC-002 Provider headers/extensions: Pi owns request interception

**Upstream evidence**

- `244f1dea feat(coding-agent): add before_provider_headers extension hook (#6350)` 修改 extension types/runner/SDK。
- U8 `extensions/types.ts:674,1193` 定义事件；`extensions/runner.ts:1003-1029` 顺序执行 mutation handlers；`core/sdk.ts:306-321` 通过 stream option `transformHeaders` 调 runner。
- U8 `pi-ai/src/models.ts:60,480-483` 在 provider dispatch 前应用 `transformHeaders`，随后移除该非 provider option。

**Current conflict**

- current extension runner 只有 HCP lifecycle `pre-llm` direct call（`pi/coding-agent/src/core/extensions/runner.ts:1018`），没有 `emitBeforeProviderHeaders`。
- `pre-llm` payload hook与“auth/config/model headers 已合并后的最后 header mutation”语义不同。把 headers 塞进 HCP hook既会改变 hook contract，又会让 HCP进入每请求路径。

**Adaptation**

1. 原样保留 extension event 名称与 in-place mutation兼容语义，但在 ModelRuntime `prepareRequest()` 的最终 header merge 后执行。
2. HCP lifecycle provider继续只通过 session setup时缓存的 capability直调；不要让 `before_provider_headers` resolve HCP。
3. Header merge必须 case-insensitive覆盖，允许删除值的行为与 U8一致；在最终 HTTP adapter前过滤 `null` deletion marker。
4. Extension reload 后 runner ref 应即时生效，不捕获 stale runner。

**Tests / rollback**

- U8 `extensions-runner.test.ts`、`sdk-stream-options.test.ts`、regression `5661-uppercase-header-values.test.ts`。
- 新增 auth header、model header、extension header 的 precedence/case/delete矩阵，以及 reload stale-runner 测试。
- rollback 只撤 hook接线；ModelRuntime 本体不回退。若 headers 可能泄露，立即 STOP release。

### HC-003 Dynamic tools: update turn context, not HCP topology

**Upstream evidence**

- `3d8f7435 feat(ai): support message-anchored tool loading (#6474)` 增加 `addedToolNames`、deferred-tool split 和 provider支持。
- U8 `pi-ai/src/utils/deferred-tools.ts:8-38` 从 transcript 中识别 load point；`pi-ai/src/types.ts:411-414` 与 `pi-agent/src/types.ts:356` 承载 additive marker。
- U8 `extensions/wrapper.ts:29-33` 只记录本次 tool execution 新增的 tool names。
- `e547bb9f fix(coding-agent): refresh session state before next turn` 引入 `Agent.prepareNextTurnWithContext` 与 `_installAgentNextTurnRefresh()`；随后 `fd6659dd fix(coding-agent): preserve run prompt during tool refresh` 保住 run-local system-prompt override。U8 `agent-session.ts:499-516` 在同一 run 的下一次 provider request 前刷新 system prompt/tools/model/thinking，而不是等下一 prompt。
- U8 regression `6162-extension-active-tools-next-turn.test.ts` 覆盖 same-run可见性、`addedToolNames` 与 system-prompt override保留。

**Current conflict**

- current 有 `setActiveToolsByName()`（`pi/coding-agent/src/core/agent-session.ts:1424`）和 HCP-built tool registry，但 current `pi/agent` 没有 `prepareNextTurnWithContext`/`addedToolNames`，因此同一 tool loop 下一 provider request 可能仍用旧 snapshot。
- 若每次 active-tools 变化重跑 `HcpClientassemble()`，会把 selection/assembly拖进 hot path并产生 replacement/disposal风险。

**Adaptation**

1. Port message schema + provider deferred encoding + extension wrapper marker作为一组；任何一层缺失都不发布。
2. Port `prepareNextTurnWithContext`，把 current Magenta `shouldStopAfterTurn`、mid-loop compaction、external activation queue 的 context合并逻辑保留；不得用 upstream agent-loop整文件覆盖。
3. Active tool变化只从已经 assembled 的 `_toolRegistry` 重建 `agent.state.tools`/system prompt。HCP topology保持不变。
4. 只有纯 additive变化写 `addedToolNames`；删除/替换工具走安全 fallback，使 provider发送完整当前 tool list并允许 cache miss。
5. Provider不支持 deferred tools时行为必须等价于 U2全量 tools。

**Tests / rollback**

- 移植 U8 deferred-tools tests和 `6162` regression；加 HCP-native Tool、Package Tool、extension Tool混合场景。
- 加“工具变更 + mid-loop compaction + queued peer/background message”次序测试。
- 记录assembly/resolution/disposal counts与对象identity：same-run additive activation保持同一HcpClient和selected product；explicit package/MCP reload只replacement/dispose一次；replay/compaction读取marker不触发activation。
- rollback可关闭 provider deferred feature flag，但 same-run context refresh bugfix应保留；transcript `addedToolNames` 是 additive字段，旧 reader应忽略。

### HC-004 Session/context/storage: update extracted primitive at its new owner

**Upstream evidence**

- `dd1c690f fix(agent): add session context entry projection`：U8 `agent/src/harness/session/session.ts:22-34` 新增 entry transform/projector contract，`:82-132` 分离 context entries 与 message projection，`:171-184` 支持 Session级和call级组合。
- `7198e78f feat(agent): support custom metadata in jsonl session headers (#6417)`：U8 `jsonl-storage.ts:15,217` 支持 metadata并验证 object shape。
- `1dac0990 fix(agent): derive short session entry ids from uuidv7 random tail`：同时修改 JSONL 与 in-memory storage；U8 `jsonl-storage.ts:39-40` 从 `.slice(-8)` 取随机尾部，修复timestamp prefix碰撞。

**Current conflict**

- extracted current `_magenta/session/pi/session.ts:26-119` 仍是单体 `buildSessionContext()`，没有 entryTransforms/projectors。
- current `_magenta/session/pi/jsonl-storage.ts` 的 header无 metadata；JSONL与memory backend仍分别在 `jsonl-storage.ts:37`、`memory-storage.ts:24` 取 UUIDv7前8位。
- coding-agent自己的 `SessionManager` 仍拥有应用策略、migration、UI listing和sync API；机械替换会破坏 Magenta branching/Todo/external activation。

**Adaptation**

1. 将三个 upstream semantic patch落入 `HarnessComponentProtocol/_magenta/session/pi/*` 和 `_magenta/types`。这是私有 host support，不声明 HcpServer/Magnet，不进 generated assembly。
2. Context projector是注入选项，不是 registry；保持默认 custom entry 不进入模型上下文。
3. HCP root公开`Session`、storage interfaces和JSONL/in-memory factories。HCP拥有tree mutation、entry IDs、projection、storage semantics；Pi只拥有discovery、legacy migration policy、naming/listing UI和application lifecycle。
4. coding-agent `SessionManager` 保持 application facade，但production reopen/fork/context/append必须委托HCP primitive；删除Pi重复projector和direct JSONL append。legacy parser只负责migration input，禁止deep Source import。
5. 保持 session version 3，metadata为optional additive字段；旧文件可读，新文件被 U2 reader忽略未知字段。
6. Todo complete snapshot仍留在 tool-result details；projector不能把 Todo state复制到独立文件或 header。
7. 先同时修 JSONL 与 in-memory 两个 backend 的随机tail ID，再做 projector，以免新投影测试被碰撞噪声干扰。

**Tests / rollback**

- HCP `session.test.ts` + U8 agent harness session/storage/repo tests；覆盖 malformed metadata、old header、branch selection、compaction transform、projector precedence、ID collision。
- coding-agent session reopen/fork/tree/Todo branch restoration完整回归；加production path spy证明调用HCP factory且Pi无第二projector/write path。
- rollback metadata/projector是代码级可回退；已写 metadata的 v3 header不能被“严格拒绝未知字段”的旧实现读取，因此 rollback reader必须继续容忍 metadata。

### HC-005 Compaction: HCP owns implementation, Pi owns policy/continuation

**Upstream evidence**

- `f58c1156 fix(coding-agent): serialize split-turn compaction summaries` 将 history summary 与 turn-prefix summary 从并行改为串行，避免同一 provider的并发摘要与顺序不确定。
- `a6f720e6 fix(coding-agent): count custom messages in compaction budget` 修正 custom message token accounting。
- `73581ea9 fix(coding-agent): avoid pre-prompt compaction continue` 防止用户新 prompt 前 compaction 后错误调用 `agent.continue()`。
- U8 compaction实现先完成 history result，再生成 turnPrefix（`packages/coding-agent/src/core/compaction/compaction.ts:765-794`）。

**Current conflict**

- current Pi adapter明确把 concrete logic委托给 HCP（`pi/coding-agent/src/core/compaction/compaction.ts:1-17`）。
- current HCP owner已计入 `custom_message`（`HarnessComponentProtocol/compaction/pi/compaction.ts:79,330,336,347`），但 split-turn仍在 `:882-914` 用 `Promise.all` 同时跑两个summary，回归了 upstream `f58c1156`。
- current agent-session还增加 mid-loop compaction与external-activation barrier（例如 `pi/coding-agent/src/core/agent-session.ts:750-779,1591-1595`），不能被 U8 host文件覆盖。

**Adaptation**

1. 在 HCP `compaction/pi/compaction.ts` 把 split-turn两个摘要串行化，同时保持 current Result/Models DI、progress callback和 abort contract。
2. Pi adapter保持薄层；不得恢复 upstream第二份 concrete compaction。
3. 将 U8 custom-message budget testcase移植到 HCP test，确认 current实现确实等价而非仅出现关键字。
4. 在 current agent-session policy层移植/确认 pre-prompt no-continue，保留 mid-loop threshold latch、peer/background queue barrier和HCP-resolved CompactionProvider direct call。
5. Compaction product每个HCP generation只resolve一次并缓存；只在explicit loader reload替换且old product dispose一次。HCP loader存在但selected slot missing时fail，只有完全无HCP的legacy/test loader允许compat fallback。

**Tests / rollback**

- HCP compaction injection、split-turn order、abort、progress monotonicity、custom-message budget；coding-agent pre-prompt/mid-loop/queued-message/auto-compaction tests。
- 用 fake Models记录最大并发数，split-turn必须 `maxConcurrent === 1`；加resolve count、selected product identity、disabled-slot、reload-disposal tests。
- rollback只撤本批semantic patch；session文件格式不变。出现重复summary、丢queued message或Todo branch state即STOP。

### HC-006 Orchestrator: distinct product, no HCP merge

**Upstream evidence**

- `87ad8243 feat(experimental): pi orchestrator` 与前置 `7ece19b..2f853bbc` 引入 standalone `packages/orchestrator`；U8 README `:3` 明确 API/行为不稳定、可能移除。
- U8 `supervisor.ts:270-310` spawn persistent coding-agent RPC process；`ipc/protocol.ts:39,49,111` 提供 `rpc_stream`；Supervisor还维护 sessionId/sessionFile、instances storage 和 Radius presence。

**Current conflict**

- HCP `multiagent` 文档 `:3-4` 明确是 sessionless one-shot worker，不是 persistent agent-team runtime。
- Worker在 grant层禁止 `sub_agent/bg_shell/teammate_agent/send_message`（`worker.ts:24-43`），并用 `PI_MAORCH_DEPTH` 限制递归（`:54-61`）。
- Upstream orchestrator的 persistent RPC、UI attach、machine/instance storage与current managed teammate/peer mailbox重叠，但不等价；合并会产生第二生命周期 owner和第二session/instance registry。

**Decision / adaptation**

- **v0.80.8 主升级默认 STOP 导入 `pi/orchestrator`。** 它不是修复主CLI所需依赖，且上游自己标注experimental。
- 主升级稳定后若业务明确需要persistent RPC fleet，单独做 pilot：代码仍放 Pi独立 package，不声明 HCP Module/Source，不替换 `capability:multiagent`，不暴露给model默认tools。
- Pilot必须先定义与current teammate/peer mailbox、RPC mode、Radius auth、session storage的唯一owner；在此之前不得落库。
- 不能把 upstream `OrchestratorSupervisor` 命名/包装为 HcpServer；也不能为它新增 HCP registry。若未来需要可选启动，application host显式启动并直接消费其API。

**Tests / rollback**

- Pilot gate：Radius disabled/offline、socket stale/restart、spawn failure cleanup、stop idempotency、RPC serialization、child death、Windows socket、auth separation。
- rollback为移除独立 package/CLI；HCP generated projection必须 byte-identical。若 pilot需要修改 `HCP_SERVERS/HCP_MAGNETS`，直接 STOP。

### HC-007 TUI: semantic cherry-picks only

**Upstream evidence**

- `1c799cec fix(tui): normalize tabs for terminal output (#6697)`：U8 `tui/src/utils.ts:274-309` 在terminal output层展开可见tab但跳过ANSI sequence。
- `8479bd84 fix(tui): parse legacy alt-prefixed symbols (#6523)` 修复 legacy terminal alt+symbol。
- `8a2ce5a5 fix(tui): decrement paste counter on paste marker delete and terminal clear (#6397)` 修复paste lifecycle。
- `5d499272 fix(coding-agent): stabilize interactive status indicators`、`45203abf` coalesce adjacent thinking blocks、`ba10b60b` entry renderers均影响interactive rendering。

**Current conflict**

- current TUI在组件层已有部分tab normalization（例如 `pi/tui/src/components/markdown.ts:190`、`text.ts:61`、`editor.ts:1100`），但 current `pi/tui/src/utils.ts:274+` 缺 U8 terminal-output兜底。
- current `interactive-mode.ts` 比 U8多约数千行，包含 floating menu、todo/events/side-chat/tool gallery、animated output等；U8 `status-indicator.ts`在current甚至不存在。覆盖interactive目录会删除Magenta功能。
- current assistant renderer有自定义 thinking-tag normalization、animation和usage display，与U8相邻thinking coalesce/outputPadding实现冲突。

**Adaptation**

1. `pi/tui` core按commit逐个移植：terminal tab normalization、legacy alt symbol、paste counter，并直接移植upstream tests。
2. `pi/coding-agent/modes/interactive`只按observable behavior重实现：thinking block coalescing、copy shortcut、status lifecycle、output padding、entry renderer；不得复制整文件。
3. current renderer registry、renderKind、HTML export、gallery/floating overlay和animation为保留面。
4. 对同一行为已存在但实现不同者，以upstream test作为contract，不要求代码同构。

**Tests / rollback**

- `pi/tui/test/tab-width.test.ts`、`keys.test.ts`、markdown/editor/paste tests；coding-agent assistant-message/status/footer/renderKind/HTML export tests。
- 终端快照至少覆盖窄宽、wide unicode、ANSI+tab、hidden thinking、tool call与streaming animation。
- 每个TUI semantic commit独立回滚；出现布局抖动、overlay遮挡或interactive功能消失即STOP。

### HC-008 Runtime/build/release: retain Magenta pipeline, import critical fixes

**Upstream evidence**

- `6442536b fix(coding-agent): bundle OAuth flows in Bun binaries` 新增 `pi-ai/src/bun-oauth.ts`，由 `coding-agent/src/bun/cli.ts` 静态注册OAuth实现，解决lazy dynamic import在compiled binary中缺失。
- `97f9978f` 增加 catalog refresh flag；`2be9efa1` 增加generated catalog发布；`622eca76` 增加coding-agent install lock生成。
- U8 root build显式构建 orchestrator；其 toolchain仍与current不同。

**Current conflict**

- current provider仍通过 `utils/oauth/load.ts` variable dynamic import加载（如 `pi/ai/src/providers/anthropic.ts:2-15`、`openai-codex.ts:2-13`），current `pi/coding-agent/src/bun/cli.ts`没有 U8 `registerBunOAuthFlows()`，所以binary有同类风险。
- current已经使用native TS7并有专用 resolver（root `package.json:50,58`; `scripts/tsc.mjs:2-20`），release还打包 HCP/process-tools/resources（`pi/coding-agent/package.json:34-38`）。

**Adaptation**

1. OAuth bundle fix跟随HC-001的新 auth目录布局移植；在Bun entry静态注册，不在通用Node/browser入口强制加载。
2. catalog refresh CLI/UI跟随ModelRuntime落地；remote fetch尊重 `PI_OFFLINE`、timeout与缓存完整性。
3. install-lock机制先评估是否能替代/补充current deterministic shrinkwrap；禁止同时维护两个互相漂移的发布锁。未证明收益前保持current shrinkwrap owner。
4. 保留TS7、HCP/process-tools binary assets、Magenta brand/version/release事务逻辑；不复制upstream root package.json/build scripts。
5. 上游已占用相同`@earendil-works/*@0.80.8`，因此四个Pi packages改为private local `0.80.8-magenta.0`并exact-pin；HCP bump到private `0.0.2`并纳入同一local closure。禁止用current names发布npm fork。随后重建root lock与coding-agent shrinkwrap。

**Tests / rollback**

- Node source-mode `/login` + compiled Bun binary须枚举并初始化 U8 静态注册的全部 bundled flows（Anthropic、OpenAI Codex、GitHub Copilot、xAI、Radius）；不得真实提交凭据。证据：`6442536b` 的 `packages/ai/src/bun-oauth.ts` 注册这五类 loader，并由 `packages/coding-agent/src/bun/cli.ts` 启动时调用。
- offline catalog、corrupt cache、timeout、refresh flag和picker refresh测试。
- macOS arm64、macOS x64、Linux x64、Windows x64 native runner分别执行binary/resource marker/process-tools/HCP/WASM/OAuth-loader offline smoke。
- rollback build入口前保留旧binary；OAuth bundle smoke失败即不发布。lockfile必须由generator生成，禁止手调。

### HC-009 HCP assembly hard gate

Current唯一assembly入口是 `.HCP/assembly/session-hcp.ts:115`，生成/动态component均进入这里；`:449-488` 选择real Server并调用唯一 `hcp.registerModule()`；`:590-653` 创建单session Client。升级期间：

- HC-001/002/003/007/008 **不应新增任何 HCP TOML component**。
- HC-004 只改 `_magenta/session` support，不进generated projection。
- HC-005 只改已存在 `compaction/pi` source；generated row仍是 `module=compaction, product=capability, source=pi`（`sources.generated.ts:135-146`）。
- HC-006 默认不导入；pilot也不得进入HCP projection。
- `sources.generated.ts` 只能由TOML codegen更新；预期本次大多数批次 `generate --check` 应 byte-clean。

## 5. 依赖拓扑

本附录的B/G编号是HCP domain-local分析标签；实施时以master `README.md`和`wave-map.csv`的W0-W9/G0-G9为唯一owner与gate编号。

```text
B0 characterization + fixture freeze
 |
 v
B1 pi-ai Models/auth/provider contracts (HC-001 foundation)
 |
 +--> B2 coding-agent ModelRuntime + extension provider/header facade (HC-001/002)
 |      |
 |      +--> B3 HCP session primitive + compaction semantic ports (HC-004/005)
 |              (compaction adapter consumes the new Models surface)
 |              |
 |              +--> B4 dynamic tool transcript/provider/turn refresh (HC-003)
 |
 +--> B5 low-coupling TUI core patches + Magenta interactive adaptations (HC-007)
        (may develop in parallel after B0; model/runtime UI remains in B2)

B1..B5 --> B6 versions/lock/shrinkwrap/Bun OAuth/catalog/release (HC-008)
B6 green --> B7 full gates + binary smoke
B7 green --> optional B8 standalone upstream orchestrator pilot (HC-006)
```

关键顺序约束：

1. ModelRuntime不能先于 `pi-ai` Models/auth contract。
2. Header hook必须在ModelRuntime request preparation稳定后接线。
3. Compaction必须在Models/ModelRuntime adapter编译通过后迁移；HCP owner改动先于Pi adapter调整。
4. Dynamic tool provider encoding、message schema、extension wrapper和turn refresh必须同批发布，并在session/compaction owner迁移后执行。
5. Versions/lock/binary必须最后做，避免中间态被误发布。
6. Experimental orchestrator不能阻塞或混入主升级。

## 6. 升级批次与 stop/go gates

### Gate G0: baseline characterization

**GO条件**

- 在独立upgrade worktree记录current `npm run build`, focused tests, HCP gates和关键binary smoke基线。
- 冻结session v1/v2/v3、Todo v1/v2、synthetic/redacted auth、models、Package v1/v2、custom extension/provider fixtures；禁止复制真实`auth.json`。
- 记录current worktree已有用户改动，升级不得覆盖。

**STOP**：current baseline本身红且无法区分既有失败；fixture不包含分支/compaction/queued peer场景。

### Gate G1: pi-ai foundation

**GO条件**

- `npm run build -w @earendil-works/pi-ai`。
- models/auth/oauth/provider tests green；deferred-tools留给B4/W8原子协议批次。
- HCP build仍能消费 `Models` 类型，且无HCP结构变化。

**STOP**：出现第二 provider collection、silent auth fallback、HCP为模型认证新增role。

### Gate G2: ModelRuntime + header extension

**GO条件**

- coding internals只引用ModelRuntime；ModelRegistry只有compat facade状态。
- auth/header precedence全矩阵、dynamic provider refresh、picker refresh、extension reload tests green。
- `before_provider_headers`仅在最终request preparation一次执行。

**STOP**：旧/新runtime双写；credential refresh竞态；header hook经HCP per-request resolve。

### Gate G3: session + compaction

**GO条件**

- HCP `check:hcp-sources/check:structure/check:assumptions/build/test` green。
- 所有旧session fixture可读；metadata/projector/branch/Todo state完整；production Pi facade实际委托HCP factory且无重复projector/write path。
- split-turn summary最大并发1；pre-prompt无错误continue；queued external payload不丢。
- 每HCP generation compaction resolve count=1；reload disposal=1；selected slot disabled/missing不静默fallback。

**STOP**：另建session Module/registry；Pi保留第二实现；Todo state不随branch恢复；compaction重复/乱序/丢消息或绕过selection。

### Gate G4: dynamic tools

**GO条件**

- U8 deferred-tool与6162 tests green。
- unsupported provider与non-additive变化安全fallback。
- HCP addresses/modules、HcpClient与selected product对象identity在same-run tool call前后不变，只有agent active-tool snapshot变化。
- assembly/resolution/disposal count不变；explicit reload恰好replacement/dispose一次；replay无activation副作用。

**STOP**：工具在same-run下一请求不可见；system prompt override丢失；tool change触发assembly；identity变化或replay产生副作用。

### Gate G5: TUI

**GO条件**

- TUI key/tab/paste tests + coding interactive component tests green。
- current floating menu/gallery/todo/events/side-chat/renderKind/HTML export无回归。

**STOP**：通过覆盖upstream interactive目录删除Magenta组件；终端输出tab错位或overlay互相覆盖。

### Gate G6: build/release

**GO条件**

- 四个private Pi packages/internal deps原子为`0.80.8-magenta.0`，HCP为`0.0.2`并由coding-agent exact-pin；记录U8 baseline SHA，lock/shrinkwrap generator clean。
- non-mutating full-gates使用`npm ci`并验证lock clean；root build/check:release/test和HCP gates green。
- macOS arm64、macOS x64、Linux x64、Windows x64 native runners分别执行binary/resource/process-tools/HCP/WASM/OAuth-loader offline smoke；`--help`不算OAuth验证。
- `scripts/publish.mjs`对private packages fail closed；local packed-tarball closure通过。GitHub release先建draft，实装验证actual assets后再公开；artifact marker包含tag SHA。

**STOP**：TS7降级；同时存在两个发布锁owner；compiled binary缺OAuth/HCP assets；public release不依赖全部native/full gates；尝试用upstream name/version发布npm fork。

### Gate G7: optional orchestrator pilot

**GO条件**

- 主升级已发布稳定；产品明确需要persistent RPC supervisor。
- 完成与teammate/peer/RPC/session/Radius的owner ADR；默认off；不进HCP projection。

**STOP**：试图替换HCP multiagent、默认暴露给model、复用第二registry管理相同session/process。

## 7. 推荐测试命令

Focused HCP（从repo root）：

```bash
npm run check:hcp-sources -w @magenta/harness
npm run check:structure -w @magenta/harness
npm run check:assumptions -w @magenta/harness
npm run build -w @magenta/harness
npm test -w @magenta/harness
```

按依赖顺序：

```bash
npm run build -w @earendil-works/pi-ai
npm test -w @earendil-works/pi-ai
npm run build -w @earendil-works/pi-agent-core
npm test -w @earendil-works/pi-agent-core
npm run build -w @earendil-works/pi-tui
npm test -w @earendil-works/pi-tui
npm run build -w @earendil-works/pi-coding-agent
npm test -w @earendil-works/pi-coding-agent
```

最终：

```bash
npm run check:docs
npm run build
npm run check:release
npm test
npm run check:shrinkwrap
npm run build:release-all -w @earendil-works/pi-coding-agent
```

注意：current `npm run check`含 `biome check --write`，升级worktree之外不得在只读审查或共享dirty tree直接运行；release gate使用不改写的 `check:release`。

## 8. 回滚策略

1. 每个B1-B6是ordered、owner-scoped commit set，并在组末建立tested rollback boundary；禁止“upstream sync”巨型单提交。
2. 每批前只保留synthetic/redacted auth/models/session fixture；真实`auth.json`绝不由test/migration/rollback读取、备份或重写。
3. `addedToolNames`、session header metadata都是additive字段，reader rollback必须保持unknown-field tolerant。
4. ModelRuntime rollback允许删除cache型 `models-store.json`，但不得删除credential store。
5. HCP generated projection只由codegen恢复；每批检查assembly/resolution/disposal counts和identity。
6. private Pi/HCP packages只做local exact closure，不npm publish；`scripts/publish.mjs`必须fail closed。
7. GitHub release先draft并验证actual assets；公开后不能靠git revert，只能forward release。
8. Release assets必须来自同一tag SHA；native binary smoke失败继续提供上一release，不发布混合平台版本。
9. Orchestrator pilot的rollback是整个独立package/CLI删除，HCP应无diff。

## 9. 最终 owner map

| Concern | Canonical owner after upgrade | HCP参与方式 |
|---|---|---|
| Models/provider/auth/OAuth/catalog | `pi/ai` + `pi/coding-agent` ModelRuntime | 无HCP role；compaction调用时只接受Models依赖 |
| Extension provider registration/header hook | `pi/coding-agent` extension/runtime | 无per-request HCP；已有HCP hook capability仍缓存后直调 |
| Dynamic/deferred tool transcript与turn refresh | `pi/ai` + `pi/agent` + `pi/coding-agent` | HCP只在session/reload装配AgentTool pool |
| Session tree/IDs/projection/storage semantics | `HarnessComponentProtocol/_magenta/session` | private support，通过HCP root factory公开，无Server/Magnet |
| Session discovery/legacy migration/UI/lifecycle | `pi/coding-agent` | facade委托support，不深导入Source、不保留重复实现 |
| Compaction implementation | `HarnessComponentProtocol/compaction/pi` | 每HCP generation resolve一次后直接调用 |
| Compaction continuation/queue policy | `pi/coding-agent/agent-session` | explicit reload才替换；missing selected slot不静默fallback |
| One-shot workflow multiagent | `HarnessComponentProtocol/multiagent/workflow/magenta` | 已有magenta Source capability |
| Persistent upstream orchestrator | 可选 `pi/orchestrator` standalone | 默认不导入；永不替代multiagent/不进projection |
| TUI/renderers/HTML export | `pi/tui` + `pi/coding-agent` | Pi renderer按renderKind消费Tool metadata |
| Build/release/binary assets | root scripts + `pi/coding-agent` Magenta pipeline | 构建并携带HCP assets，但不改变runtime role |

**最终建议：批准B0-B7分批升级；拒绝整树覆盖和默认orchestrator导入。** 最重要的先决条件是HC-001把ModelRuntime真正做成唯一model/auth owner；否则HC-002、HC-003、HC-008都会在双registry状态上继续分叉，后续无法可靠回滚。
