# Magenta 升级 PI v0.80.8: 完整对照清单与实施计划

> 调研日期: 2026-07-17
>
> 本文是实施前计划，不代表升级已经开始。

## 1. 目标与边界

目标是把 Magenta 当前 vendored PI 基线从名义上的 `0.80.2` 对齐到 upstream `v0.80.8` 的行为和公共契约，同时保留 Magenta/HCP 已建立的 owner、multiagent、external auth、background runtime、TUI 和发布能力。

本轮只完成四件事:

1. 枚举 `v0.80.2..v0.80.8` 的全部 upstream changes。
2. 对每项判断 Magenta 是否已实现、部分实现、替代、缺失或冲突。
3. 指定正确 owner、迁移动作、依赖、测试和回滚点。
4. 给出可以逐批执行的升级计划。

本轮明确不做:

- 不覆盖 `pi/*` 运行代码。
- 不 bump 四个 PI package version。
- 不导入 experimental `packages/orchestrator`。
- 不建立第二个 model/tool/session registry。
- 不改变 HCP 三角色和单一 `HcpClient` assembly 路径。
- `v0.80.9`/`v0.80.10`只作为已知后续版本记录，不混入本次U8 target；其Kimi/xAI/catalog后续修复另做下一轮diff。

## 2. 固定基准

| 基准 | Commit | 用途 |
|---|---|---|
| upstream U2 | `0201806adfa825ab3d7957a4267d46e5030fd357` | vanilla `v0.80.2` |
| Magenta import | `f1da4c98bd3b8df522a0e80e2f6e6bfcdb064328` | 首次顶层 `pi/` 导入，已带 external-auth 等早期分叉 |
| Magenta checkpoint | `4a08f6305ed3fa88067d7dbd9a19ced606dcef0f` | 六份语义审计使用的 current 基准 |
| upstream U8 | `fae7176cb9f7c4725a40d9d481d8d70b80f18086` | 目标 `v0.80.8` |
| 当前后续修复 | `e7a6e770385e2c6ca16888f7ed5a97bd38bdb39e` | 仅改 Magenta 专有 bg-shell-return renderer，不影响 upstream 对照集合 |

各附录中的`/tmp/magenta-pi-*`和`/tmp/magenta-import-*`只是source-browsing别名，不是额外证据源；`file-triage.csv`和validator直接读取上表四个fixed Git objects，不依赖live/exported tree。

首次导入并非 vanilla U2 的逐字复制。导入时已经存在以下 path 差异:

- `pi/ai`: 21 paths
- `pi/agent`: 5 paths
- `pi/coding-agent`: 22 paths
- `pi/tui`: 1 path

因此本报告使用 U2 -> import -> current -> U8 四方对照，不能只做 U2/U8 diff。

## 3. 覆盖证明

| 维度 | 数量 | 结果 |
|---|---:|---|
| upstream commits | 243 | 237 linked to evidence IDs，6 only mechanical/N/A |
| upstream package paths | 393 | 全部完成四方 hash triage |
| all-repo commit/file change records | 1,257 | Git name-status记录，rename算一个change |
| package commit/file change records | 1,194 | 排除63个root/config records，用于检查跨workspace commit |
| semantic evidence items | 178 | 无重复、无未分类、全部至少绑定一个commit |
| domain reports | 6 | AI、agent、coding-core、coding-UI、TUI/repo、HCP |

`commit-ledger.csv` 另外保留 1,265 个 path endpoints；比 1,257 个change records多8，是因为8次rename同时记录old/new path。这三个口径在ledger中分别为 `changeCount`、`packageChangeCount` 和 `pathEndpointCount`。

当前 393 个package文件级候选状态:

| 机械状态 | 数量 | 含义 |
|---|---:|---|
| `exact_target` | 12 | current 与 U8 字节一致，仍需检查跨文件契约 |
| `exact_base` | 122 | current 仍是 U2 内容，通常需要移植 |
| `diverged` | 166 | Magenta 与 U2/U8 都不同，必须语义合并 |
| `missing_target_addition` | 83 | U8 新增、Magenta 不存在 |
| `deleted_or_absent` | 10 | Magenta 已移走/删除或 owner 改变 |

六个OAuth rename会在import/current优先解析target path，不存在时回退source path；CSV同时记录`upstreamSourcePath`、`upstreamTargetPath`和两个resolved path。文件hash只是triage，不直接等价于行为结论。

178 个 evidence items 归一化后的状态分布:

| 状态 | 数量 |
|---|---:|
| `MISSING` | 71 |
| `CONFLICT` | 60 |
| `PARTIAL` | 21 |
| `PRESENT` | 8 |
| `SUPERSEDED` | 5 |
| `N/A` | 12 |
| `CONDITIONAL` | 1 |

这些是域级 evidence units，其中跨 package contract 会在不同 owner 中各有一项；实施波次已将它们重新聚合，不应把 178 当成独立 commits 数。

## 4. 状态词汇

最终实施统一使用以下状态:

- `PRESENT`: 当前行为等价，可保留实现。
- `PARTIAL`: 当前只覆盖 upstream 契约的一部分。
- `SUPERSEDED`: Magenta/HCP 有更强或不同 owner 的等价能力，不复制 upstream 文件。
- `MISSING`: 当前没有该行为。
- `CONFLICT`: 当前与 upstream 修改同一 owner/契约，必须设计性合并。
- `N/A`: release metadata、上游仓库策略或产品不适用于 Magenta。
- `CONDITIONAL`: 仅在另一个产品决定成立后实施。

详细状态见 `semantic-index.csv` 和各域报告。

## 5. 总结论

**有条件 GO，禁止 big-bang sync。**

可以升级到 v0.80.8，但实际工作是一次按 owner 切分的语义迁移，不是 `cp packages/* pi/*`，也不是一次 merge commit。

最重要的事实:

1. 当前 catalog 比 runtime protocol 更新。Magenta 已出现 GPT-5.6、Grok 4.5、MAI-Code、Claude 5 等条目，但部分 API route、thinking、context、pricing、auth 和 tool protocol 仍旧。这比 catalog 单纯过旧更危险。
2. `v0.80.8` 最大 breaking change 是 `Models + ModelRuntime + provider-owned auth`。它必须成为唯一 model/auth owner，旧 `ModelRegistry` 只能暂时保留无状态 compatibility facade。
3. HCP 已抽走 session primitive 和 compaction owner。相关 upstream fix 只能语义移植到 HCP owner，不能把旧 Pi concrete implementation 放回来。
4. Message-anchored dynamic tools 是 ai + agent + coding-agent 的原子协议。只改 extension registry 或 provider serializer都会产生半兼容状态。
5. Upstream experimental orchestrator 与 HCP multiagent/managed teammate 不是同一产品。主升级中明确排除。
6. 升级到 v0.80.8 不会修复 Anthropic tool schema 根级约束截断。该缺陷在 U8 仍存在，需要 Magenta 单独修复。

## 6. 实施前必须确认的产品决定

### D1. Model/auth 唯一 owner

建议: 接受 upstream `ModelRuntime` 方向，但做 Magenta credential adapter。

全链路 precedence:

1. request/runtime explicit override
2. Magenta stored credential
3. external Claude Code/Codex credential source
4. provider env/ambient auth

W5只建立2 -> 3 -> 4的provider-owned base resolver；W6在final request assembly中把1置于其上。两个wave不能各自再解析environment。

约束:

- current `loadExternalAuth()`把environment与external files先合并，不能直接作为新adapter；W5必须先拆成独立sources。
- 只允许Magenta-owned store写入/删除；external file只读，logout不删除外部文件。
- environment只在composite resolver解析一次，`includeFallback=false`不得绕回env。
- external base URL作为request auth/config结果，不修改immutable catalog。
- 不允许旧registry与ModelRuntime双写。

### D2. Default prompt 日期

Upstream v0.80.7 删除 current date 以稳定 prompt cache；当前 HCP system-prompt 明确注入日期并有测试。

建议: 从 default prompt 删除日期，需要时由 time tool、用户 prompt 或显式 capability 提供。若保留日期，必须记录为有意 divergence，并接受每日 cache prefix invalidation。

### D3. Edit item 额外字段

Upstream 放宽 `edits[]` item 的 unknown fields；当前 HCP schema 对 item 使用 `additionalProperties:false`。

建议二选一:

- 严格方案: 保持拒绝，依赖 typed error/repair。
- 兼容方案: 只放宽 item，顶层继续 strict，execute 先投影 `{oldText,newText}`。

不能为了容错把整个 tool schema 设为开放对象。

### D4. `agent_settled` 的 Magenta 定义

`AgentSession`是唯一settlement owner；background idle和external quiescence仍是独立host barriers。每次prompt创建单调`runId/generation`，RPC `promptAndWait`只能由同一run的settled event完成，旧event不得满足新wait。

| 状态 | 阻塞agent settled | 说明 |
|---|---|---|
| provider run / retry timer / compaction | 是 | 都属于当前run |
| steering/follow-up/continuation queue | 是 | 直到queue drain和final state recheck |
| `agent_end` extension callback | 是 | callback必须await；新增same-run work后继续quiescence loop |
| `agent_settled` extension callback | 通知阶段，不可新增same-run work | stable后仅通知；异步callback会await后才完成RPC barrier |
| claimed auto-return activation及其continuation | 是 | 直到delivery和run-owned continuation完成 |
| passive peer mailbox/context | 否 | 尚未claim不属于当前run |
| detached background job运行中 | 否 | 由`waitForBackgroundIdle`单独等待 |
| external coordinator batching但未关联run | 否 | 由external-quiescence barrier单独等待 |

协议分两阶段：先运行`agent_end` handlers并反复drain/recheck，直到当前run稳定；随后只发一次run-correlated `agent_settled` notification。settled handler尝试修改已完成run时必须reject或排到新`runId`，不能让同一run重新进入settling。所有settled callbacks完成后，内部completion barrier才resolve RPC。

### D5. Remote catalog publication

建议: 可以吸收 runtime catalog consumer/store；R2 publisher workflow 单独 CONDITIONAL，不复制 Earendil account/secrets。

### D6. Experimental orchestrator

决定: 主升级不导入。未来如需要 machine-wide daemon，另立产品和 ADR；不得替换 HCP multiagent，也不得进入 HCP generated projection。

### D7. Session owner boundary

决定:

- HCP `_magenta/session`拥有tree mutation、entry ID、context projection、storage interfaces与storage semantics。
- `@magenta/harness` root公开`Session`和JSONL/in-memory storage factories；coding-agent禁止deep import Source实现。
- coding-agent只拥有session discovery、legacy migration policy、naming/listing UI和application lifecycle。
- current Pi `buildSessionContext`、direct JSONL append和等价tree mutation必须删除或委托HCP；legacy parser只负责把旧格式输入交给HCP factory。

### D8. Vendored package/version policy

决定: upstream U8已经公开占用`@earendil-works/pi-*@0.80.8`，Magenta不得用同一name/version发布fork。当前批采用vendored/private策略:

- 四个Pi workspace packages设为`private`并使用lockstep local version `0.80.8-magenta.0`，internal deps exact-pin该版本。
- `@magenta/harness`因W7行为变化在W9统一bump到自己的`0.0.2`，coding-agent exact-pin；它与四个Pi packages一起进入local dependency closure。
- `scripts/publish.mjs`对这些private packages fail closed；本批只发布Magenta GitHub CLI binaries/resources，不发布npm fork tarballs。
- package metadata/changelog记录U8 tag和完整SHA。未来若要公开SDK，必须先迁到Magenta-owned npm scope并另做consumer migration ADR。

U9/U10不混入本批。

## 7. 逐版本主对照

### v0.80.3 - 93 commits

| Upstream cluster | Magenta current | 计划 |
|---|---|---|
| `Usage.reasoning` | 缺失 | W2 原子移植 type + provider parsers，禁止双计 output |
| Azure Foundry URL | 已存在 | 保留并跑回归 |
| Retry utility、HTTP error body、context-aware max tokens | 缺失 | W1/W2 移植并做 redaction/long-context tests |
| Responses out-of-order reasoning replay | 缺失，且同文件有 Magenta signature/cache hardening | W3 手工合并状态机，禁止覆盖 |
| Sonnet 5/catalog refresh | 数据已独立刷新，但 protocol不完全等价 | W9 按U8 target generator一次重建 |
| `prepareNextTurnWithContext` | public Agent API 缺失 | W7 增量加入，保留 legacy AbortSignal |
| pre-prompt compaction stop | 当前 orchestration 分叉 | W7 在 AgentSession policy 层重实现 |
| outputPad/externalEditor | 缺失或 partial | W4 低风险 UI batch |
| RPC `get_entries/get_tree`、`./rpc-entry` | core getEntries/getTree 已有，protocol/export 缺失 | W4 增量加入 Magenta RPC/runtime host |
| BMP disk input | clipboard BMP已有，disk/CLI/read 缺失 | W1 共用 image utility |
| invalid session protection | partial | W1 先 port failure-preservation tests |
| TUI backslash escape | 缺失 | W4 isolated TUI patch |
| experimental orchestrator | HCP/teammate已覆盖实际需求 | N/A/SUPERSEDED，不导入 |

### v0.80.4 - 82 commits

| Upstream cluster | Magenta current | 计划 |
|---|---|---|
| Session projectors/header metadata/storage exports/UUID tail | 缺失，owner已移至 HCP private session support | W7 语义移植到 `_magenta/session` |
| split-turn compaction serialize | HCP 当前仍 `Promise.all`，明确冲突 | W7 改 HCP owner，max concurrency必须为1 |
| reject length-truncated tool calls | 缺失，Magenta literal recovery扩大执行面 | W1 safety first |
| null content ingestion | ai/agent/coding boundaries均缺 | W1 跨包原子修复 |
| bash timeout validation | HCP bash对0/负值可静默无timeout | W1 在 HCP pure tool验证 |
| edit extra replacement fields | 与HCP strict schema冲突 | 等 D3 |
| `before_provider_headers` | 缺失 | W6 在 final request assembly接线，不经HCP hot path |
| `agent_settled` | 缺失 | W4，先确认D4 |
| entry renderers/InlineExtension | 缺失且与current renderer/HCP reload交叉 | W4 适配，不覆盖registry |
| project-local config三态/Tab | 双scope基础已有，交互/三态缺 | W4 保留trust/HCP packages |
| cache miss notices | telemetry更强但setting/transcript projection缺 | W4 复用现有telemetry，不建第二统计器 |
| provider correctness/retry/Codex/Bedrock | 多项缺失 | W1/W3 按provider patch移植 |
| TUI paste marker cleanup | current registry更复杂 | W4 ADAPT，保留snapshot/undo和ID不复用 |
| native clipboard Bun packaging | 缺失 | W9 packaging fix |

### v0.80.5 - 3 commits

没有 production runtime change。仅 `[Unreleased]`、一个 interactive fixture 和 release/version metadata。

计划: 不复制功能，不单独建立迁移 batch。

### v0.80.6 - 14 commits

| Upstream cluster | Magenta current | 计划 |
|---|---|---|
| `max` thinking | 类型/UI已有，但支持矩阵过宽且theme fallback缺 | W2/W4 按U8 target规则收紧，保留Ultra |
| input pricing tiers | 完全缺失 | W2 type/generator/calculateCost/telemetry同批 |
| GPT-5.4/5.5/5.6 context/pricing | current direct GPT-5.6 context和bare alias冲突 | W2修协议，W9重生成catalog |
| stale pre-compaction usage | current AgentSession已有独立防护，ai estimator缺 | 保留current；若引入estimate同时移植U8测试 |
| empty thinking + valid signature | 缺失 | W1 small correctness patch |
| shellPath `~` expansion | 缺失 | W4 small setting patch |
| release full-test gate | Magenta release未跑完整suite | W9 先保证test isolation，再加入gate |

### v0.80.7 - 31 commits

| Upstream cluster | Magenta current | 计划 |
|---|---|---|
| message-anchored/deferred tools | registry/tool search有，transcript/provider protocol缺 | W8 原子跨三包 + HCP pool adapter |
| `sessionAffinityFormat` breaking | 仍用 `sendSessionIdHeader` | W3 类型/serializer/custom config迁移 |
| Responses required/named toolChoice | 缺失 | W3 |
| OpenRouter/OpenCode transport + Bedrock/Cloudflare auth fixes | partial/missing | transport归W3；provider auth归W5，W6 final assembly复测 |
| Ctrl+X copy、Ctrl+V text fallback | 缺失 | W4，适配Magenta focus和image queue |
| prompt date removal | HCP明确冲突 | 等D2后改HCP owner |
| TUI legacy Alt symbols | 缺失 | W4 direct port |
| npm peer-conflict removal | install策略已有，remove路径需核 | W4/package small patch |
| Radius precursor | 当前无 | 不移植早期版本；W9采用U8 provider/runtime终态 |

### v0.80.8 - 20 commits

| Upstream cluster | Magenta current | 计划 |
|---|---|---|
| provider-owned auth/Models contract | 仍为旧contract + external auth分叉 | W5 pi-ai foundation |
| async coding-agent ModelRuntime | 完全缺失 | W6整簇迁移，旧registry只facade |
| ModelsStore/remote catalog/force refresh | 缺失 | W5/W6，R2 publish等D5 |
| xAI device OAuth/Grok 4.5 Responses | catalog存在但route仍Completions，无OAuth | W9，在auth/runtime之后 |
| Bun static OAuth bundle | 缺失 | W9，覆盖五类loader |
| Codex session ID clamp | 缺失 | W3 |
| TUI terminal tab normalization | 缺失 | W4 direct port |
| adjacent thinking coalescing | 缺失且current有animation/tag normalization | W4行为重实现 |
| Windows title restore | partial/missing | W4 small patch |

## 8. 无 changelog 单列但必须覆盖的 4 项

| ID | Commit | 当前 | 动作 |
|---|---|---|---|
| MX-001 | `ec857fec` | question example无 `executionMode:sequential` | 加示例/测试，避免同turn多个问题互相抢UI |
| MX-002 | `4a9c962b` | pnpm self-update无cache prune提示 | 适配Magenta self-update文案，低优先级 |
| MX-003 | `86afffe0` | fork selector缺明确double-select guard | 加一次性提交/disable guard测试 |
| MX-004 | `12545274`, `c6d83715` | Windows update check可能覆盖terminal title | 在async check完成后恢复Magenta session title |

## 9. 实施波次

[`wave-map.csv`](./wave-map.csv) 是唯一实施 owner 表。178 个 semantic IDs 各有且仅有一个primary disposition；`CANONICAL`/`GOVERNANCE` rows才拥有代码动作，aggregate evidence使用`CROSSWALK`并指向`canonicalImplementationIds`，不能再建第二实现。本节执行顺序是 W0 -> W1 -> W2 -> W3 -> W4 -> W5 -> W6 -> W7 -> W8 -> W9。

- `CROSSWALK`: `AG-013`, `AG-015`, `CC-014`, `CC-056`, `CU-011`, `CU-012`, `CU-015`, `CU-017`, `CU-018`, `CU-021`, `CU-022`, `CU-023`, `CU-024`, `CU-025`。仅提供跨域证据，不独立改代码；canonical映射见CSV。
- `VERIFY`: `AG-002`, `AI-001`, `AI-010`, `AI-013`, `TR-007`, `TR-014`, `TR-016`。只保留当前等价/替代行为并跑回归。
- `EXCLUDED`: `AI-005`, `AI-016`, `AI-037`, `AI-045`, `CC-022`, `HC-006`, `TR-005`, `TR-006`, `TR-008`, `TR-009`, `TR-010`, `TR-011`, `TR-019`。明确禁止导入。

### W0. Characterization baseline

Primary ID: `HC-009`。状态: 计划阶段已完成，实施 worktree 仍需重跑。

Checklist:

- [ ] 从 `e7a6e770385e2c6ca16888f7ed5a97bd38bdb39e` 创建独立 upgrade worktree/branch。
- [ ] 冻结 synthetic/redacted auth、models、session v1/v2/v3、Todo v1/v2、Package v1/v2 fixtures；禁止复制真实 `auth.json`。
- [ ] 跑 root build/check:release/test、HCP gates、四 workspace tests、binary smoke。
- [ ] 记录 HCP assembly/resolution/disposal 次数与 selected product identity baseline。
- [ ] 记录既有失败；baseline红时不进入W1。

Rollback: 删除upgrade worktree，不触及main。

### W1. Safety and low-coupling correctness

Primary IDs: `AG-007`, `AG-008`, `AG-009`, `AG-010`, `AI-002`, `AI-006`, `AI-008`, `AI-014`, `AI-015`, `AI-017`, `AI-018`, `AI-019`, `AI-025`, `CC-002`, `CC-003`, `CC-005`, `CC-013`, `CC-024`。

Checklist:

- [ ] length-truncated tool call全部产出error result且不execute，包括Magenta recovered literal call。
- [ ] null content在ai/agent/session/RPC/import边界归一化。
- [ ] HCP shell timeout拒绝0、负数、non-finite、超Node上限。
- [ ] session ID改UUIDv7随机tail；invalid explicit session不覆盖原文件。
- [ ] provider retry/error body/overflow/token floor/empty output修复。
- [ ] empty-thinking valid signature保留。
- [ ] Codex header timeout；session clamp归W3 transport owner。
- [ ] Anthropic root schema截断作为Magenta独立patch和golden test，不等待U8。

Commit边界: agent safety、ingestion、HCP shell/session、provider-small-fixes分开提交。

GO: ai、agent、coding-agent、HCP四个受影响owner的build与focused tests全绿。STOP: tool仍执行、session文件被重写、error body泄露credential。

### W2. Usage, context budget, pricing and thinking contract

Primary IDs: `AG-011`, `AG-014`, `AI-003`, `AI-007`, `AI-021`, `AI-022`, `AI-023`, `AI-024`, `CC-036`, `CC-037`, `CU-013`。

Checklist:

- [ ] `Usage.reasoning`在支持provider中填充，保持为output子集。
- [ ] estimate/context-aware max token cap和post-compaction boundary对齐。
- [ ] pricing tier类型、config、generator、calculateCost、telemetry原子迁移。
- [ ] 按U8 target matrix重做max/xhigh支持，不把Ultra写入provider type。
- [ ] 修正GPT-5.6 direct/Codex context、pricing和bare alias决策。
- [ ] custom theme缺thinkingMax时回退thinkingXhigh。

GO: ai、agent、coding-agent build；cost thresholds、provider usage fixtures、Ultra tests全绿。STOP: reasoning重复计费、catalog宣称模型支持实际payload不支持的effort。

### W3. Provider transport and compatibility

Primary IDs: `AI-004`, `AI-009`, `AI-011`, `AI-012`, `AI-030`, `AI-032`, `AI-033`, `AI-034`, `AI-035`, `AI-039`, `CC-020`, `CC-042`。

Checklist:

- [ ] Responses reasoning item/block map支持out-of-order和terminal encrypted content backfill。
- [ ] 合并而非覆盖Magenta foreign-signature/cache diagnostics。
- [ ] sessionAffinityFormat三种格式及旧字段临时migration warning。
- [ ] OpenAI/Codex required/named/none toolChoice。
- [ ] Codex zstd/UA/socket rotation/header timeout。
- [ ] Vercel attribution removal、session affinity config与transport-only compatibility。
- [ ] Anthropic proxy missing usage、Azure replay、Z.AI preserve thinking。
- [ ] Codex session ID确定性截断到64字符。
- [ ] 本波只处理transport/compat；Bedrock `/login` 与branch ambient auth分别归W6/W7。

GO: ai与coding-agent build；captured payload/header golden tests跨OpenAI/OpenRouter/OpenCode/Azure/Bedrock/Anthropic。STOP: header发错provider、reasoning replay丢失、cache fingerprint回归。

### W4. TUI, RPC, settings and extension UX

Primary IDs: `CC-001`, `CC-008`, `CC-009`, `CC-010`, `CC-011`, `CC-016`, `CC-021`, `CC-025`, `CC-026`, `CC-030`, `CC-032`, `CC-033`, `CC-035`, `CC-038`, `CC-040`, `CC-044`, `CC-046`, `CU-001`, `CU-002`, `CU-003`, `CU-004`, `CU-005`, `CU-006`, `CU-007`, `CU-008`, `CU-009`, `CU-010`, `CU-014`, `CU-016`, `CU-019`, `CU-020`, `CU-026`, `HC-007`, `MX-001`, `MX-002`, `MX-003`, `MX-004`, `TR-001`, `TR-002`, `TR-003`, `TR-004`。

Checklist:

- [ ] outputPad、externalEditor、shellPath tilde、benchmark shutdown ordering。
- [ ] RPC `get_entries/get_tree/rpc-entry`，保留Magenta headless manifest/background协议。
- [ ] 按D4 settlement state machine实现`agent_settled`和run-correlated RPC barrier。
- [ ] Ctrl+X copy、Ctrl+V image-first/text-fallback；thinking block coalesce。
- [ ] terminal tab normalization、legacy Alt symbols、backslash escapes。
- [ ] paste registry按Magenta snapshot/undo语义adapt，不复用deleted ID。
- [ ] cache miss notice复用现有telemetry；project config三态/Tab保留trust/HCP precedence。
- [ ] entry renderer/InlineExtension与现有message/tool renderer registry并存。
- [ ] `session_info_changed`保留current内部event，并补extension event type/dispatch/export与单次触发测试。
- [ ] Windows/UNC context traversal、npm peer-conflict uninstall、reload descriptions。
- [ ] HCP edit只处理D3选定的validation/schema；coding-agent只保留renderer/adapter。
- [ ] 实施MX-001..004，并在async fork前关闭selector。
- [ ] D2确认后处理prompt date；D3确认后处理edit schema。

GO: tui、coding-agent和受影响HCP tool owner的build/tests全绿；RPC、extension、project trust、narrow/wide viewport、overlay、renderKind、HTML回归全绿。STOP: stale run event满足新RPC wait、floating menu/gallery/todo/events/side-chat丢功能或UI重叠。

### W5. pi-ai Models/auth foundation

Primary IDs: `AI-027`, `AI-029`, `AI-038`, `AI-040`, `AI-043`, `HC-001`。

Checklist:

- [ ] port U8 provider-owned `Models`、auth、CredentialStore、ModelsStore contract。
- [ ] 移植Bedrock stored bearer vs ambient SigV4、ambient marker filtering和Cloudflare per-field ambient fallback（AI-027/029）。
- [ ] 先拆开current `loadExternalAuth()`中的environment与read-only external-file来源，再建立一个composite credential resolver；禁止直接包装现有混合API。
- [ ] 只有Magenta-owned store可mutate/logout；Claude/Codex external stores只读。
- [ ] 实现D1 sources 2 -> 3 -> 4的base-resolver precedence、base URL、`includeFallback=false`、refresh lock和error propagation；source 1只在W6接入。
- [ ] `Models.refresh`覆盖cache restore、network fail、abort、force、offline、credential change与并发共享。
- [ ] provider refresh context/legacy projection仍由pi-ai contract拥有；本波不创建coding ModelRuntime facade。
- [ ] HCP不新增role；本波只让后续compaction可接受`Models`依赖。

GO: ai、agent、coding-agent和HCP Models consumer build；upstream models/auth/provider suites和synthetic external-auth collision矩阵全绿，只有一个credential resolution chain。STOP: silent fallback、logout删除外部文件、environment被解析两次、第二credential/model owner。

### W6. coding-agent ModelRuntime and request assembly

Primary IDs: `CC-015`, `CC-018`, `CC-019`, `CC-027`, `CC-028`, `CC-029`, `CC-047`, `CC-048`, `CC-049`, `CC-050`, `CC-051`, `CC-052`, `CC-053`, `CC-054`, `CC-055`, `CC-058`, `CC-059`, `HC-002`。

Checklist:

- [ ] 引入ModelRuntime/ModelConfig/ProviderComposer/RuntimeCredentials和remote catalog consumer。
- [ ] coding internals只用ModelRuntime/Models；旧ModelRegistry仅作无状态extension facade且有删除点。
- [ ] SDK async migration和public resolution helpers；禁止在ModelRuntime重建U8已删除的projection methods。
- [ ] final auth/baseUrl/header/env assembly只有一个入口；before_provider_headers在final merge后执行一次，不经HCP hot path。
- [ ] `/login <provider>`、Bedrock API-key/ambient auth、auth persistence status、live selector refresh、`update --models`。
- [ ] extension `refreshModels`/legacy `modifyModels`、override precedence、refresh race/abort。
- [ ] 保留cache telemetry、timeouts、session affinity、Ultra和HCP session factory。

GO: ai和coding-agent build；SDK compile fixtures、header precedence、synthetic external auth、refresh race、RPC/auth UI/model picker tests全绿。STOP: core仍读legacy facade、双registry、header hook重复/泄密、`update --models`触发self-update。

### W7. Session primitive and compaction owner migration

Primary IDs: `AG-001`, `AG-003`, `AG-004`, `AG-005`, `AG-006`, `CC-004`, `CC-007`, `CC-017`, `CC-023`, `CC-031`, `CC-034`, `CC-039`, `CC-043`, `HC-004`, `HC-005`。

Checklist:

- [ ] HCP root公开`Session`、storage interfaces/factories、entry transforms/projectors；Pi禁止deep Source import。
- [ ] HCP拥有tree mutation、entry IDs、projection和storage semantics；Pi只拥有discovery、legacy migration policy、UI/naming和application lifecycle。
- [ ] Pi production reopen/fork/context/append路径委托HCP primitive，删除重复projector和重复JSONL append实现；legacy parser只用于migration input。
- [ ] JSONL header metadata roundtrip/validation/fork inheritance；old readers保持unknown-field tolerant。
- [ ] split-turn summaries严格串行，custom visible messages计入budget，hidden receipts不计。
- [ ] compaction product每个HCP generation只resolve一次；只在explicit reload替换并dispose一次。HCP loader存在却missing slot时fail，只有无HCP legacy/test loader可fallback。
- [ ] pre-prompt compaction不错误continue；queued peer/bg payload和Todo branch state不丢。
- [ ] `prepareNextTurnWithContext`增量加入并保留legacy AbortSignal。
- [ ] branch summary通过W5/W6 `Models`依赖支持ambient auth。

HCP约束: session仍是private host support，不声明Server/Magnet；compaction继续只有现有pi Source capability，不新增registry。

GO: HCP structure/generated/build/test、agent build/test、coding session/compaction suites全绿；production path调用HCP factory，resolve count=1，reload disposal=1，split summary `maxConcurrent===1`。STOP: Pi仍保留第二projector/write path、disabled slot静默fallback、Todo branch state丢失或重复summary。

### W8. Message-anchored dynamic/deferred tools

Primary IDs: `AG-012`, `AI-028`, `CC-012`, `CC-041`, `HC-003`。

Checklist:

- [ ] ToolResultMessage/AgentToolResult加入addedToolNames并被after-hook保留。
- [ ] extension/package/HCP/MCP activation仅对additive变化写marker。
- [ ] same-run next request刷新tools/system prompt且保留run override。
- [ ] Anthropic/OpenAI Responses/Codex deferred serializer从anchor加载。
- [ ] unsupported provider/non-additive变化安全回退全量tools。
- [ ] HCP只提供session已assembled tool pool，不因tool result重新assembly。
- [ ] same-run activation保持同一个HcpClient、selected product对象identity和assembly count；只替换agent turn-local snapshot。
- [ ] explicit package/MCP reload只经existing Client replacement一次，old product dispose一次。
- [ ] replay/compaction读取anchor不触发activation副作用。
- [ ] canonical tool schema以JSON Schema结构传递，不字符串拼接。

GO: ai、agent、coding-agent、HCP build；deferred-tools、6162、cache-prefix、resume/compaction、filters/noTools、mixed-source、identity/count tests全绿。STOP: same-run不可见、prompt override丢、activation重装HCP、replay产生副作用或schema约束继续静默丢失。

### W9. Catalog, OAuth, packaging, version and release

Primary IDs: `AI-020`, `AI-026`, `AI-031`, `AI-036`, `AI-041`, `AI-042`, `AI-044`, `AI-046`, `CC-006`, `CC-045`, `CC-057`, `HC-008`, `TR-012`, `TR-013`, `TR-015`, `TR-017`, `TR-018`。

Checklist:

- [ ] 用U8 target generator一次性重生成catalog并人工审`api/compat/context/cost/thinking` overrides；U9/U10明确留给后续升级。
- [ ] xAI OAuth + Grok Responses；Radius/pi-messages作为可配置provider实现，但默认不激活。
- [ ] Bun静态注册Anthropic/OpenAI Codex/GitHub Copilot/xAI/Radius五类OAuth loader，并提供offline枚举测试，不提交真实凭据。
- [ ] native clipboard concrete `.node`进入wrapper目录。
- [ ] model refresh/store/offline/force；R2 publisher按D5单独CONDITIONAL，不复制上游secrets。
- [ ] release workflow新增non-mutating `full-gates` job：`npm ci`、root tests、lock clean、HCP gates。
- [ ] macOS arm64、macOS x64、Linux x64、Windows x64各自在native runner执行binary/resource/process-tools/HCP/WASM/OAuth-loader smoke，不能只cross-build或跑`--help`。
- [ ] 保留TS7、Magenta brand、HCP/process-tools/resources；GitHub tag/resource marker继续使用独立brand product version，不复用private package version，并包含checkout tag commit SHA。
- [ ] 按D8将四个private Pi packages/internal deps原子改`0.80.8-magenta.0`；HCP改`0.0.2`并由coding-agent exact-pin；记录upstream baseline SHA，重建root lock/shrinkwrap。
- [ ] `scripts/publish.mjs`对vendored/private packages fail closed；验证local workspace和packed-tarball exact dependency closure，不调用npm publish。
- [ ] GitHub CLI release先建draft，下载并验证实际draft assets/installers后再公开；公开后失败只能forward release，不能声称git revert已回滚。

GO: root build/check:release/test、shrinkwrap、HCP gates、source Node、四平台native binary、local five-package closure和实际GitHub draft assets全部绿。STOP: TS7回退、两个lock owner、binary缺OAuth/HCP资源、private/version只改一部分、public release job不依赖全部native/full gates。

## 10. HCP final owner map

| Concern | 升级后canonical owner | HCP参与方式 |
|---|---|---|
| Models/provider/auth/OAuth/catalog | `pi/ai` + coding-agent ModelRuntime | 无新HCP role |
| Header hook/provider refresh | coding-agent runtime/extensions | 无per-request HCP resolve |
| Dynamic/deferred tool transcript | ai + agent + coding-agent | HCP只装配tool pool |
| Session tree/IDs/projection/storage semantics | `HarnessComponentProtocol/_magenta/session` | private host support，通过HCP root factory公开 |
| Session discovery/legacy migration/UI/lifecycle | coding-agent | facade委托HCP primitive，不保留重复projector/write path |
| Compaction implementation | existing `compaction/pi` capability | 每HCP generation resolve一次后直接调用 |
| Compaction continuation/queues | coding-agent AgentSession | explicit reload才替换，missing selected slot不静默fallback |
| One-shot multiagent | existing HCP multiagent | 不受upstream orchestrator替换 |
| Persistent orchestrator | 默认不导入 | 不进入HCP projection |
| TUI/renderers | pi/tui + coding-agent | 继续renderKind/registry约定 |
| Build/release | root + coding-agent | 打包HCP assets，不改变runtime role |

## 11. Commit和回滚纪律

1. 每个W1-W9是ordered、owner-scoped commit set，不是“每wave一个commit”，也不创建`sync upstream v0.80.8`巨型提交。
2. owner不同必须分commit，例如agent safety、HCP session、HCP compaction分别提交；每组末尾才建立tested rollback boundary。
3. version/lock/catalog generated data最后提交。
4. 每组先移植upstream contract tests，再改实现，再跑Magenta regression；所有中间commit必须build其修改owner。
5. 只冻结synthetic/redacted auth fixture；真实`auth.json`永不由migration/rollback脚本读取、重写或删除。
6. models-store可删除回滚，credential store不可删除。
7. additive session/tool fields的旧reader必须unknown-field tolerant。
8. HCP generated files只由codegen更新；每wave检查assembly/resolution/disposal count与product identity。
9. 发布前失败直接abort；GitHub release公开后不能靠git revert撤销，必须forward release。
10. vendored/private Pi/HCP packages只做local exact closure，不npm publish；GitHub draft assets必须来自同一tag SHA并在公开前实装验证。
11. 任一gate失败两次停止堆补丁，回到该波次owner/contract重新设计。

## 12. 最小验证矩阵

### Types/API

- Usage.reasoning、pricing tiers、ThinkingLevel/max matrix。
- ModelRuntime/CredentialStore/Models refresh async contracts。
- sessionAffinityFormat、ToolResultMessage.addedToolNames。
- SDK/root/rpc-entry exports compile fixtures。

### Provider payload

- Anthropic schema fidelity、empty signature、missing usage、deferred tools。
- OpenAI/Azure/Codex reasoning replay、toolChoice、session affinity。
- OpenRouter/OpenCode headers、Cloudflare ambient IDs、Bedrock SigV4/bearer。
- xAI OAuth/Grok Responses、Radius/pi-messages only if enabled。

### Session/runtime

- invalid file preservation、metadata、projectors、UUID IDs、Pi facade实际委托HCP factory。
- pre/mid-loop compaction、serialized summaries、stale usage、resolve/reload/disposal counts。
- queued prompt/peer/background delivery、run-correlated agent_settled truth table、stale event rejection。
- length-truncated calls never execute。

### Tool/cache

- same-run activation、cache prefix、provider fallback、HcpClient/product identity不变。
- HCP/package/MCP/extension/native mixed tool pool；explicit reload仅replacement/disposal一次。
- filters/noTools、resume/replay/compaction anchors。
- edit/bash validation and typed repair behavior。

### TUI/RPC

- outputPad、clipboard、Alt symbols、tabs、thinking coalesce。
- floating menu/gallery/todo/events/side-chat/renderKind/HTML。
- get_entries/get_tree/rpc-entry、promptAndWait/settled。

### Auth/release

- stored/external-file/env/ambient precedence、`includeFallback=false`、logout ownership。
- Node source and Bun compiled OAuth loader offline enumeration。
- four native-platform binary assets、HCP resources、process-tools、wasm、tag SHA marker。
- root build/check:release/test、shrinkwrap、HCP all gates、private five-package local closure、实际GitHub draft assets。

## 13. Go/No-Go gates

| Gate | GO | STOP |
|---|---|---|
| G0 baseline | clean isolated worktree, current suite/identity counts characterized | existing red cannot be distinguished |
| G1 safety | no invalid effect/session overwrite/secret leak | any unsafe call still executes |
| G2 usage/contracts | usage/cost/thinking tests green | double count or unsupported model metadata |
| G3 provider transport | captured payload/header tests green | wrong route/header/reasoning replay |
| G4 TUI/RPC | UI regressions green; settled run correlation exact | stale event resolves wait or overlays regress |
| G5 pi-ai Models/auth | one composite credential chain and Models owner | env parsed twice or mutable external file |
| G6 coding ModelRuntime | one runtime/provider collection; SDK/UI green | dual registry or silent auth fallback |
| G7 HCP session/compaction | Pi delegates HCP; resolve/disposal counts exact | second owner, fallback bypass or branch/Todo loss |
| G8 dynamic tools | same-run/cache/fallback/identity green | reassembly, stale tools, prompt loss or replay side effect |
| G9 release | private versions atomic, full gates/native binaries/local closure/draft assets green | mixed versions/locks/platform artifacts or unverified public release |

## 14. 交付物索引

- [`semantic-index.csv`](./semantic-index.csv): 178 个 evidence items 的域、标题、归一化状态、源分类和来源。
- [`commit-ledger.csv`](./commit-ledger.csv): 243 commits，包含版本、status/path changes、direct/dependency semantic edges、coverage及三种edge口径。
- [`file-triage.csv`](./file-triage.csv): 393 paths 的rename-aware U2/import/current/U8 hashes和机械关系。
- [`file-triage-summary.tsv`](./file-triage-summary.tsv): workspace/current relation汇总。
- [`wave-map.csv`](./wave-map.csv): 178 IDs 的primary disposition、implementation role、canonical action targets、owner、dependency、test gate和rollback unit。
- [`validation.json`](./validation.json): four fixed snapshots、blob hashes、rename coordinates、canonical foreign keys、wave DAG和链接验证结果。
- [`scripts/README.md`](./scripts/README.md): 可复现生成顺序、环境变量和validator边界。
- [`SHA256SUMS`](./SHA256SUMS): 最终交付物与复现脚本的内容哈希。
- [`ai.md`](./ai.md): 46 AI items，92/92 ai commits。
- [`agent.md`](./agent.md): 15 agent items，33/33 direct commits。
- [`coding-core.md`](./coding-core.md): 59 core/runtime items，70/70 scoped commits。
- [`coding-ui.md`](./coding-ui.md): 26 UI/RPC/settings/SDK items，107/107 coding-agent commits。
- [`tui-repo.md`](./tui-repo.md): 19 TUI/root/orchestrator items，99/99 scoped commits。
- [`hcp-conflicts.md`](./hcp-conflicts.md): HC-001..009 owner/冲突、B0-B8/G0-G7、回滚设计。

旧的逐版本版本史位于 [`../pi-version-history-v0.80.2-to-latest.md`](../pi-version-history-v0.80.2-to-latest.md)。

## 15. 独立审查结论

三路首审分别检查ledger、semantic crosswalk和HCP architecture，随后又做closure review。两轮发现的实质问题均已进入当前版本:

- 六个OAuth rename改为source/target-aware四方hash，不再误报文件缺失。
- `AI-035`、`CC-010`、`CC-028`、`CC-047`、`CC-056`等归一化状态按源证据纠正。
- `wave-map.csv`以`CANONICAL/GOVERNANCE/CROSSWALK`区分代码owner与aggregate evidence；178 IDs全部有唯一disposition，canonical action不重复。
- auth work移到Models owner之后；session/compaction先于dynamic tools；AG-009明确覆盖env timer与bash tool两个HCP路径。
- session extension event、两阶段settlement correlation、HCP session delegation、compaction resolution和dynamic-tool identity均补成可测试契约。
- 四方hash改为直接读取fixed Git objects并锁定六个rename coordinates，不再信任live/exported trees。
- upstream npm namespace冲突改为private `0.80.8-magenta.0` Pi + private `0.0.2` HCP local closure；release gate改为full tests、四平台native smoke、GitHub draft asset验证和post-publication forward recovery。

修订后validator逐行重算Git changes、四个fixed snapshots的blob hash、semantic/canonical edges和wave DAG，结果见`validation.json`。本轮仍是static planning；没有运行provider credential tests，也没有修改PI/HCP runtime。

## 16. 建议的下一步

在开始写升级代码前，确认D1-D5；D6-D8和HCP owner边界按本计划执行。确认后从W0建立独立upgrade worktree，按W1 safety batch开始；不要先bump版本，也不要先导入generated catalog。
