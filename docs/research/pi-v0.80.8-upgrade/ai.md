# packages/ai v0.80.2 -> v0.80.8 语义升级审计

基准：upstream `v0.80.2`=`/tmp/magenta-pi-v0802`，upstream `v0.80.8`=`/tmp/magenta-pi-v0808`，历史仓库=`/tmp/magenta-pi-upstream-v0.80.8-20260717`；Magenta import=`/tmp/magenta-import-f1da4c`（包版本仍为 `0.80.2`），Magenta current=`$HOME/Magenta3` @ `4a08f6305ed3fa88067d7dbd9a19ced606dcef0f`。本审计只读源码、tag diff、commit diff 和测试；未运行测试、未修改 Magenta3。

## 结论摘要

- upstream 范围内共有 **92 个触及 `packages/ai` 的 commits**，已在附录逐一、且仅一次归属到 46 个 `AI-xxx` 项。
- 最大协议风险不是“catalog 旧”，而是 **catalog 已被 Magenta 单独刷新，但传输/计费/鉴权协议没有同步**：当前存在 Grok 4.5、MAI-Code、GPT-5.6、Claude 5 等条目，却仍用旧 API 路由或旧请求语义。
- 最高优先级缺口：`Usage.reasoning`（遥测口径）、input pricing tiers（直接错计费）、`sessionAffinityFormat`（破坏性 API 变更）、message-anchored/deferred tools（缓存前缀语义）、v0.80.8 provider-owned auth/Models contract（大面积破坏性 API）、xAI OAuth/Responses 路由。
- 当前本地 `max` 不是 upstream 的等价实现：虽然类型/UI/若干 catalog 已有 `max`，但生成结果把 `max`/`xhigh` 广泛写进不应原生支持的 Anthropic 条目，并保留 upstream 已删除的 bare `gpt-5.6`；应按 **CONFLICT** 而不是 PRESENT 处理。
- 当前本地 OpenAI Responses 有额外的 foreign-signature guard 和 prompt-cache hardening（`82e757c4`、`ebe88ca8`），移植 upstream reasoning replay、session affinity、deferred tools 时必须合并，不能覆盖。

分类：`PRESENT`=行为等价；`PARTIAL`=只有一部分；`SUPERSEDED`=本地已有更强实现但仍需回归；`MISSING`=缺失；`CONFLICT`=本地实现/数据与 upstream 目标相冲突；`N/A`=净行为为零或仅维护性元数据。

## 逐项语义矩阵

> 每个 `AI-xxx` 条目均记录 version、官方 wording、commit、upstream 文件/符号、行为/API、import 差异、current 证据、分类、移植动作、依赖和测试。

AI-001 | version `0.80.3` | official: “Added Azure OpenAI Responses support for modern Microsoft Foundry endpoint URLs” | commits `e3dcb244`, `a2e3e9d8` | upstream `src/api/azure-openai-responses.ts:getBaseUrl`、`test/azure-openai-base-url.test.ts` | 识别 `/openai/v1`、Foundry project endpoint，避免错误拼 deployment URL | import 相对 U2 已提前包含该变更 | current `pi/ai/src/api/azure-openai-responses.ts` 与相应 base-url 测试仍在 | **PRESENT** | 无移植；升级时保留本地 endpoint 分支 | 依赖 Azure Responses SDK URL 约定 | 跑 `azure-openai-base-url.test.ts`。

AI-002 | version `0.80.3` | official: “Fixed retry classification for provider errors that explicitly tell callers to retry” | commit `371adcf3` | upstream 新增 `src/utils/retry.ts:isRetryableError` 并从 `src/index.ts` 导出 | 识别 provider 明示 retry 的错误 | import 无 `utils/retry.ts` | current `pi/ai/src/utils` 无 `retry.ts`，各 provider 仍各自判断 | **MISSING** | 移植 retry utility 与导出，再决定是否替换本地 Codex 私有 retry | 无硬依赖 | 跑 upstream `retry.test.ts`，加 provider error cause-chain 用例。

AI-003 | version `0.80.3` | official: “Added an optional `reasoning` field to `Usage` ... subset of `output`” | commit `d7868b09` | upstream `src/types.ts:Usage.reasoning`；Anthropic、OpenAI Responses/Codex/Azure、OpenAI Completions、Google/Vertex usage parsers | 新字段不改变 `output`，仅报告其子集；Bedrock/Mistral 保持 undefined | import 无该字段 | current `types.ts:Usage` 无 `reasoning`；Google current 仍把 `thoughtsTokenCount` 加进 output，OpenAI parsers未写 reasoning | **MISSING** | 原样移植类型及 5 类 parser，检查 Magenta per-message usage 展示不要把 reasoning 再次相加 | 依赖所有 usage 初始化保持结构兼容 | 增加每 provider `undefined/0/nonzero`、total 不双计、序列化兼容测试。

AI-004 | version `0.80.3` | official: “Fixed OpenAI Responses streams to preserve reasoning replay state when output items finish out of order” | commit `8c9dbffa` | upstream `src/api/openai-responses-shared.ts:processResponsesStream` | 用 item/output index 关联 reasoning block，不依赖单一 `currentItem/currentBlock` | import 是旧单指针实现 | current 仍只有单一 `currentItem/currentBlock`（约 321 行起），本地 terminal/signature hardening未解决乱序归属 | **MISSING** | 以 block map 合并 upstream 状态机，同时保留 `82e757c4` foreign-signature 校验及 `ebe88ca8` terminal diagnostics | 与 AI-034、AI-028 同文件强冲突 | 跑 upstream out-of-order/terminal tests，再加 foreign signature + 乱序组合。

AI-005 | version `0.80.3` | official 曾记录 MiniMax shared-budget clamp，最终同版本已 revert | commits `b940c52e`, `f78b1637` | upstream `scripts/generate-models.ts`、`utils/estimate.ts`、Anthropic/MiniMax tests | 两提交净效果撤销；最终行为由通用 AI-007 承担 | import 无中间态 | current 无需复制中间 clamp | **N/A** | 不移植中间态；只实现 AI-007 | 无 | 由 AI-007 测试覆盖。

AI-006 | version `0.80.3` | official: “Fixed provider HTTP errors to include response bodies instead of opaque SDK messages” | commits `62fad94f`, merge `6fbeba51` | upstream 新增 `src/utils/error-body.ts` 并接入 Azure/Bedrock/Google/Vertex/Codex/Completions/Responses/OpenRouter images | 从 Response/SDK error 安全提取、截断 body 并保留状态信息 | import 无 utility | current `src/utils` 无 `error-body.ts` | **MISSING** | 移植 utility 与每个 provider catch；审查敏感 body 的日志/diagnostic redaction | 与本地 diagnostics/error formatting 有交叉 | 跑 `error-body.test.ts`、passthrough/regression，并加 secret redaction。

AI-007 | version `0.80.3` | official: “Fixed `streamSimple()` to send a context-aware max-token cap” | commit `09f10595` | upstream `src/utils/estimate.ts`、`src/api/simple-options.ts` 及所有 provider `streamSimple` | 根据 context estimate 和 model contextWindow 限制共享 input/output budget | import 无 `estimate.ts` | current `simple-options.ts` 只处理 thinking budget，不估算 context；`src/utils` 无 estimate | **MISSING** | 移植 estimate + 所有 provider 调用；与本地 cache telemetry token accounting 分离 | AI-021 使用同一 estimate 语义；AI-028也改 estimate | 跑 upstream estimate/empty-tools tests，覆盖长 prompt、图片、工具 schema。

AI-008 | version `0.80.3` | official: “Codex Responses SSE response-header waits [use] configured HTTP timeout” | commit `54113731` | upstream `src/api/openai-codex-responses.ts` | header timeout 跟随 `options.timeoutMs`，不固定 20s | import 固定 20s | current 仍有 `DEFAULT_SSE_HEADER_TIMEOUT_MS = 20_000` 并用于错误 | **MISSING** | 移植 configured timeout，注意本地 idle/websocket timeout 分层 | 与 AI-011 同文件 | 跑 Codex SSE slow-header、abort、zero/invalid timeout tests。

AI-009 | version `0.80.3` | official: “Fixed Z.AI preserved thinking ... send `thinking.clear_thinking: false`” | commit `b91bdd5a` | upstream `src/api/openai-completions.ts` | reasoning 开启且重放 `reasoning_content` 时禁止服务端清除 thinking，以参与缓存 | import 无 `clear_thinking` | current 搜索无 `clear_thinking`；仅有其他模板的 `preserve_thinking` | **MISSING** | 在 Z.AI thinking payload 分支移植，勿误用于其他兼容端点 | 依赖 compat thinkingFormat=`zai` | 跑 upstream tool-choice/ZAI payload test，加 preserved reasoning roundtrip。

AI-010 | version `0.80.3` | official: Sonnet 5 metadata、Xiaomi pricing/adaptive-thinking fixes及 catalog refresh | commits `9cd2c81a`, `3d6acb37`, `5c1a2977` | upstream 多个 `*.models.ts`、`image-models.generated.ts`、`scripts/generate-models.ts` | 0.80.3 时点的生成 catalog 与 Sonnet 5 protocol metadata | import 已提前带入多份生成文件，但不是 tag 全量同构 | current 后续经 `e68303b`, `a1cb8ad` 刷新，catalog 内容更晚且分叉 | **SUPERSEDED**（仅 catalog 数据） | 不逐 commit 覆盖生成文件；先移植 generator 规则，再一次性生成并审阅协议字段 | AI-020/022/024/026/041/046 | generator snapshot、关键模型 protocol contract tests。

AI-011 | version `0.80.4` | official: Codex Node/Bun UA race、zstd SSE compression、60-minute-before rotation fixes | commits `a3cc169d`, `0ac3cfe0`, `23d14626` | upstream `src/api/openai-codex-responses.ts` | 同步 OS UA；Node/Bun 可用时 SSE body zstd；cached websocket 提前轮换 | import/current 均没有 zstd 与轮换逻辑 | current 仍旧 Codex transport；本地有 prompt-cache diagnostics 但非这些行为 | **MISSING** | 三项一起移植并保留本地 telemetry hooks | Node/Bun zstd feature detect；websocket cache | 跑 upstream Codex stream zstd、UA、stale socket tests及 Bun smoke。

AI-012 | version `0.80.4` | official: “wait before the first token poll” + “honor server-provided `slow_down` interval” | commits `e2ccdc85`, `8133c94d` | upstream `utils/oauth/device-code.ts`, `github-copilot.ts` | 首次延迟；slow_down 采用 server interval，而非只固定 +5s | import/current device-code 是旧实现 | current 注释仍明确“increase by 5 seconds”，未携带 server-provided interval | **MISSING** | 移植轮询状态类型、interval propagation 与 GH flow | 后续 AI-038 会移动 oauth 路径 | 先在旧路径跑 OAuth tests；若整体上 AI-038，直接采用新路径版本。

AI-013 | version `0.80.4` | official: “Fixed Amazon Bedrock prompt-cache points/pricing for Claude 5” | commits `114bacf3`, `1d061b3f`, `8c943640` | upstream Bedrock API、generator fallback 与 generated Bedrock models | Claude Fable/Sonnet 5 cache points及去除 stale fallback | import catalog已有部分提前变更 | current `ebe88ca8` 又加入更完整 cache telemetry/diagnostics及 Claude 5 model metadata | **SUPERSEDED** | 不覆盖本地 cache hardening；只用 upstream tests/expected model fields做差分核验 | AI-020/046 generated models | 跑 Bedrock cache payload、cache retention、model pricing snapshot。

AI-014 | version `0.80.4` | official: “Fixed DS4 server context overflow detection for `Prompt has ... tokens ...`” | commit `21cb3807` | upstream `src/utils/overflow.ts` | 新增 DS4 文案正则 | import 无 | current overflow search未见该文案 | **MISSING** | 小范围移植 regex | 无 | 跑 upstream `overflow.test.ts` 加大小写/逗号变体。

AI-015 | version `0.80.4` | official: retry Cloudflare 524、Bun socket drops、gRPC `ResourceExhausted` | commits `d53b5676`, `4285712b`, `57d96d72` | upstream `src/utils/retry.ts` | 扩展 transient retry 分类 | import/current 无公共 retry utility | current 搜索无 524/socket-drop/ResourceExhausted 分类 | **MISSING** | 在 AI-002 utility 上一次性移植最终规则 | AI-002 | 跑 upstream retry matrix，确保 Abort/4xx 非误重试。

AI-016 | version `0.80.4` | official 未单列；commit “remove redundant record guards” | commit `035ea9c8` | upstream `src/utils/validation.ts` | TypeScript guard 简化，目标行为不变 | import/current 保留 guards | current `isRecord/hasTypeBoxMetadata` 仍存在但无已知行为缺口 | **N/A** | 不为升级目的移植；若 AI-028 暴露 schema 问题再单独处理 | TypeBox symbols | 保持现有 validation tests。

AI-017 | version `0.80.4` | official: “normalize `null` message content at ingestion boundaries” | commit `8c0ccd14` | upstream `src/api/transform-messages.ts` | lax imported transcript 的 null content 不再崩溃 | import/current 无 upstream lax test/normalize 分支 | current transform-messages 未见该边界处理 | **MISSING** | 移植 normalize，保持 Message 公共类型严格 | agent/coding-agent ingestion也有同提交跨包改动 | 跑 `lax-message-content.test.ts` 并做跨包 transcript load test。

AI-018 | version `0.80.4` | official: empty tool result without image uses “`(no tool output)`” | commit `279f53b0` | upstream Completions/Responses converters | 区分空无内容与仅图片 | import/current Responses/Completions 仍在无文本时无条件写 `(see attached image)` | **MISSING** | 移植 `hasImages` 分支，保留 sanitize | 无 | 跑两个 upstream empty/images tests。

AI-019 | version `0.80.4` | official: Responses “avoid sending `max_output_tokens` below provider minimum” | commit `2e4ad6a0` | upstream OpenAI/Azure Responses params | 对显式低值做 provider floor clamp | import/current 直接赋 `options.maxTokens` | **MISSING** | 移植共同 floor 常量/逻辑；检查本地 max reasoning cap交互 | AI-007/022 | payload tests覆盖 undefined、0、低于 floor、正常值。

AI-020 | version `0.80.4` | official: GPT-5.6 metadata、Copilot Sonnet 5、Fireworks GLM、Xiaomi catalogs、Copilot 1M context、models.dev refresh | commits `42063764`, `844d175e`, `1da1cdb2`, `e285e90f`, `ee24a9ec`, `cc2db980`, `9eedaf8c`, `72d77b53`, `7df2a94e` | upstream generator + 多 provider generated files | catalog/生成规则更新；其中 route/API 字段会影响运行时 | import 已提前包含一部分 Claude/Xiaomi 数据 | current 经本地刷新已含 Sonnet 5、Copilot 1M、GPT-5.6，但不等价：bare `gpt-5.6` 仍存在且 direct OpenAI context 为 372K，MAI/Grok route仍旧 | **PARTIAL/CONFLICT** | 禁止直接宣称“catalog refreshed=升级完成”；采用 v8 generator 规则后重生成，逐个审计 `api/compat/context/cost/thinkingLevelMap` | AI-022/024/026/031/041/046 | 固定关键模型 contract tests，不只 snapshot 数量。

AI-021 | version `0.80.6` | official: “post-compaction output-token budgeting [ignores] stale assistant usage” | commit `8973ae28` | upstream `src/utils/estimate.ts` | 遇 compaction boundary 后不使用旧 assistant usage估预算 | import/current 无 estimate utility | **MISSING** | 与 AI-007 一次性移植最终 `estimate.ts` | agent compaction message semantics | 跑 `context-estimate.test.ts`，加 Magenta compaction transcript fixture。

AI-022 | version `0.80.6` | official: “separate opt-in `max` ... adaptive Claude `max`; native `xhigh` only Opus 4.7/4.8, Sonnet 5, Fable 5” | commit `fbdd4638` | upstream `types.ts:ThinkingLevel`、`models.ts:getSupportedThinkingLevels`、all API clamp/payload、generator/models | `max` 与 `xhigh` 分离；不支持时按 model map/clamp | import 无 max | current 本地 `c97d255` 已加 max 类型及多 provider map，但当前 generated Anthropic 众多旧条目均含 `xhigh/max`，超出官方限定；`simple-options.clampReasoning` 对通用端点把二者都降 high | **CONFLICT** | 以 upstream v8 最终规则重做 generator 和 payload，保留 Magenta UI 接口；删除过宽 maps，核对 Claude/GPT 每一族 | AI-024/026；所有 provider options | 跑 upstream `max-thinking.test.ts`、supports-xhigh，再加旧 Claude 必须不暴露 max 的负例。

AI-023 | version `0.80.6` | official: “request-wide input-token pricing tiers ... usage cost calculation” | commits `a9ecf301`, test isolation `33874659` | upstream `types.ts:ModelCostRates/ModelCostTier/ModelCost.tiers`、`models.ts:calculateCost`、generator | 以 `input+cacheRead+cacheWrite` 选最高阈值，并将该 tier 费率应用全请求 | import/current `Model.cost` 无 tiers，calculateCost只用 base rates | **MISSING** | 完整移植类型、generator JSON/schema、calculateCost；本地 `cost.unknown` 字段必须保留 | AI-024 catalog tiers；schema serialization/consumer typings | 跑阈值等于/超过、多 tier、cache 1h、service-tier multiplier组合。

AI-024 | version `0.80.6` | official: GPT-5.4/5.5 long-context pricing；GPT-5.6 direct 272K vs Codex 372K、删除 bare alias | commits `3664806f`, `6c735db0` | upstream OpenAI/Codex generated models和 generator | 模型 context 与 pricing tier 精确分流 | import无 | current `openai.models.ts` 保留 bare `gpt-5.6`，且 direct条目显示 372K；无 `tiers` | **CONFLICT** | 在 AI-023/022 后采用 upstream v8 最终 metadata；若 Magenta有意支持 bare alias，须作为明确本地 override并加来源/测试，不能伪装 upstream | AI-020/022/023 | 关键 model ID/context/cost/tier snapshot和实际 usage calculation。

AI-025 | version `0.80.6` | official: “preserve thinking blocks with empty thinking text but a valid signature” | commit `6731a0ba` | upstream `src/api/anthropic-messages.ts:convertMessages` | 先检查 signature；空 thinking + 非空 signature 仍发送 thinking block | import/current 在 signature 判断前执行 `if (block.thinking.trim().length === 0) continue` | **MISSING** | 调整判断顺序；保留 current redacted handling及 compatible-provider `allowEmptySignature` | AI-022 Anthropic thinking payload | 跑 upstream empty-thinking-signature test，覆盖 valid/empty/missing/redacted signature。

AI-026 | version `0.80.7` | official: OpenRouter top-provider context；Fable 5 all catalogs `xhigh/max` | commits `46145bef`, `bc469b03` | upstream generator、OpenRouter/GitHub models | OpenRouter context source改为 top provider；仅 Fable 5补 effort | import/current后续 catalog有大量 max maps，但 generator规则与 upstream不一致 | **PARTIAL/CONFLICT** | 移植 generator 的 top-provider选择和精确 model-family rule，再重生成 | AI-022/046 | OpenRouter provider fixture、Fable positive与旧 Claude negative tests。

AI-027 | version `0.80.7` | official: Bedrock generic `apiKey` bearer；ambient AWS credentials preserved；compat filters ambient auth markers | commits `3ea064ea`, `19fe0e01`, `850c210b` | upstream Bedrock stream/provider、compat | stored key作为 bearer；ambient marker不作为真实 key转发；自定义 model仍走 SigV4 | import已有 provider-auth facade但不是最终实现 | current `amazon-bedrock.ts` 可将 stored key暴露为 apiKey，故 bearer部分存在；但 `compat.ts` 无 `AMBIENT_AUTH_MARKER` 过滤，完整 SigV4/compat修复缺失 | **PARTIAL** | 精确移植最终三提交逻辑，并在 AI-038 auth重构后重新验证 | AWS SDK signer、compat legacy stream | 跑 Bedrock endpoint/auth tests：stored bearer、AWS env、custom model、compat。

AI-028 | version `0.80.7` | official: “cache-friendly dynamic tool loading ... `ToolResultMessage.addedToolNames` ... native deferred loading” | commit `3d8f7435` | upstream `types.ts:addedToolNames/supportsToolSearch/supportsToolReferences`、新 `utils/deferred-tools.ts`、Anthropic/OpenAI Responses/Codex converters、estimate、generator | 工具定义锚定到具体 tool result；Anthropic使用 `defer_loading/tool_reference`，Responses使用 client `tool_search_call/output`；unsupported/non-additive回退为全部 immediate | import/current无这些字段/utility | current `ToolResultMessage` 无 `addedToolNames`，无 `deferred-tools.ts`，converters无 tool-reference/tool-search；schema仍只按旧 immediate tool path序列化 | **MISSING** | 连同跨包 agent-loop/extension active-tools标记移植；schema必须传普通 JSON Schema（去除非枚举 TypeBox symbols、保持 `$defs/anyOf/additionalProperties`），不要用字符串拼接；保留本地 tool signature/cache telemetry | AI-004、AI-007、agent/coding-agent跨包生产 `addedToolNames` | 跑全部 `deferred-tools.test.ts`，另加 TypeBox与纯 JSON Schema序列化、重复工具、重命名、图片 result、cache prefix测试。

AI-029 | version `0.80.7` | official: Cloudflare key-only stored credential falls back to ambient account/gateway IDs | commit `bdd5c53b` | upstream `providers/cloudflare-auth.ts:resolveValue` | credential存在时 key取 stored，但 account/gateway可回退 env | import/current `resolveValue` 在 credential存在且非 key时只读 `credential.env` | **MISSING** | 移植 per-field fallback；AI-038之后采用 provider-owned最终版本 | AI-038、Cloudflare endpoint placeholder | providers tests覆盖 key-only+ambient、完整 stored、missing gateway。

AI-030 | version `0.80.7` | official: “`toolChoice` support to OpenAI and Codex Responses, including required and named” | commit `eacaa130` | upstream Responses/Codex options/buildParams | 支持 auto/none/required/named function | import/current Codex payload类型固定 `tool_choice?: "auto"` 并总发 auto；Responses无该 option | **MISSING** | 移植共享 ToolChoice类型及两 transport payload | AI-028 tool declarations | 跑 forced named/required/none、无 tools非法组合。

AI-031 | version `0.80.7` | official: Copilot `mai-code-1-flash-picker` routes `/responses` | commit `f7b78e2a` | upstream generator + `github-copilot.models.ts` | model API从 completions改 Responses | import/current catalog存在该模型但 `api: "openai-completions"` | **MISSING**（典型 catalog存在/协议未实现） | 移植 generator override并重生成；确认 Copilot Responses compat/header | AI-020/030/032 | model contract + captured endpoint/payload测试。

AI-032 | version `0.80.7` | official BREAKING: remove `sendSessionIdHeader`; use `compat.sessionAffinityFormat`=`openai/openai-nosession/openrouter`; OpenRouter uses `x-session-id`; OpenCode omits session-id | commits `298665cf`, `1f9e846c` | upstream `types.ts:SessionAffinityFormat`、Completions/Responses header builders、generator compat | 按 provider格式发送 headers，prompt_cache_key独立 | import/current仍有 `OpenAIResponsesCompat.sendSessionIdHeader`；Responses直接写 `headers.session_id`，无 `x-session-id` | **MISSING/CONFLICT** | 执行破坏性类型迁移；兼容读取旧字段只能作为临时 shim并标 deprecation；更新所有 custom model配置 | AI-031、AI-039、本地 prompt cache hardening | upstream compat tests + OpenRouter/OpenCode/OpenAI三格式 captured headers；保证 prompt_cache_key不回归。

AI-033 | version `0.80.7` | official: Bedrock reports unhandled provider stop reasons | commit `f8f75544` | upstream `src/api/bedrock-converse-stream.ts` | 未知 stop reason进入 error message而非固定 unknown | import/current无相应文案传播 | **MISSING** | 移植 exhaustive/fallback mapping并保留 diagnostic redaction | 无 | synthetic unknown stop reason测试。

AI-034 | version `0.80.7` | official: Azure reasoning replay backfills `encrypted_content` from terminal response | commit `1f0dbc00` | upstream `src/api/openai-responses-shared.ts` | `response.completed.output`补齐早期 reasoning block缺少的 encrypted content | import/current `finalizeResponse`只处理 id/usage/status，未回填 | **MISSING** | 合并到 AI-004 block-map状态机；通过 current signature encoder/foreign guard验证 | AI-004、本地 `82e757c4` | upstream Azure replay test + OpenAI/Codex terminal变体。

AI-035 | version `0.80.7` | official: Anthropic-compatible proxies may omit `usage` in `message_delta` | commit `0e6909f0` | upstream `src/api/anthropic-messages.ts` | usage字段为空时不覆盖/不崩溃 | import/current parser未见 upstream optional guard测试 | **MISSING** | 移植 null-safe usage accumulation，保持 current cache diagnostics | AI-003 reasoning usage | 跑 SSE parsing：无 usage、partial usage、最终 usage。

AI-036 | version `0.80.7` | official: dynamic Radius `pi-messages` gateway（v0.80.8 changelog归纳为 provider-owned OAuth/catalog refresh） | commit `961fa6c1` | upstream 新 `api/pi-messages*.ts`、Radius OAuth/provider registration/types/tests | JSON request + SSE serialized assistant events，OAuth，动态 model catalog | import/current无 pi-messages、Radius、env key | **MISSING** | 建议随 AI-038/040整体移植最终 v8 Radius，而非单独复制早期 `utils/oauth/radius.ts` | AI-038/040、schema JSON序列化、compat registration | `pi-messages.test.ts` + Radius auth/catalog cache/abort集成测试。

AI-037 | version `0.80.7` | official未单列；“type Anthropic probes by catalog providers” | commit `92ffae52` | upstream 两个 E2E test类型修正 | 仅测试模型类型来源修复，无运行时语义 | import/current测试布局不同 | **N/A** | 在移植相应 E2E时采用正确 catalog provider类型 | AI-046 | TypeScript check即可。

AI-038 | version `0.80.7` 主体、`0.80.8`最终 contract | official BREAKING: provider-scoped `Models.checkAuth/getAuth/login/logout`；移除 global OAuth registry/low-level flows；`AuthLoginCallbacks` -> `AuthInteraction`；provider-owned auth/availability | commits `9993c969`, merge/facade commits `cd7cad4e`, `5e336cfa` | upstream `models.ts`、`auth/**`、`oauth.ts`、`compat/extension-oauth-types.ts`、providers、CLI、index、README/tests | Auth resolver不再收 model；provider拥有 OAuth/API-key login/check/filter；CredentialStore list；lazy stream和 Cloudflare auth也重构 | import已有较早 Models/provider auth facade，因此不是从零；但 contract仍是 `refresh(provider?)`, `getAuth(model)`，`AuthLoginCallbacks`及 legacy `utils/oauth` | current基本保持 import contract，并有 Magenta external auth整合 | **CONFLICT** | 作为独立破坏性阶段迁移：先列出 Magenta所有 Models/OAuth调用者，提供临时 adapter，迁移 extension compatibility types，最后删 legacy registry；禁止只复制 `models.ts` | AI-027/029/036/040/041/044；跨包 coding-agent/auth UI | 跑 upstream models-runtime/oauth/providers全套 + Magenta external-auth、Bun binary、extension auth回归。

AI-039 | version `0.80.8` | official: “Codex session IDs longer than 64 characters [clamped]” | commit `dcfe36c7` | upstream `src/api/openai-codex-responses.ts` | session-id header稳定截到64字符 | import/current直接 `headers.set("session-id", sessionId)` | **MISSING** | 用 upstream deterministic clamp/hash策略，需与 AI-032 header format区分 | AI-032、本地 session cache | 跑 >64、Unicode、同输入稳定、短ID不变测试。

AI-040 | version `0.80.8` | official BREAKING/Added: `Models.refresh(options)` all providers, errors/cancellation；`ModelsStore`；`Provider.refreshModels(context)` receives credential/store/network/signal；`force` | commit `bd9e09db` | upstream 新 `src/models-store.ts`、`models.ts:RefreshModelsContext/ModelsRefreshResult`、`providers/radius.ts` | 动态 catalog持久化、离线恢复、credential scoped refresh、force/abort | import/current仍 `refresh(provider?: string): Promise<void>`，无 models-store | **MISSING** | 与 AI-038同阶段；实现 store adapter到 Magenta现有存储，明确 refresh error UI语义 | AI-036/038/043 | models-runtime refresh：cache restore、network fail、abort、force、credential change、并发共享。

AI-041 | version `0.80.8` | official: “xAI device-code OAuth login and routed Grok 4.5 through OpenAI Responses” | commit `5220aba6` | upstream `auth/oauth/xai.ts`、`providers/xai.ts/models.ts`、Responses provider识别 | device OAuth；Grok 4.5 Responses + low/medium/high | import无 | current catalog已有 `grok-4.5`，但仍 `api: "openai-completions"`，且无 xAI OAuth loader | **CONFLICT**（catalog存在但协议错误） | 在 AI-038后移植 OAuth；修 generator/route；确认 Responses payload和 headers | AI-038/044/046 | xAI OAuth polling/refresh tests、model route contract、captured Responses reasoning。

AI-042 | version `0.80.8` | official未在 package changelog单列；commit “publish generated model catalogs to R2” | commit `2be9efa1` | upstream `scripts/generate-models.ts`、`package.json:generate-model-catalog` | strict/json-only/json-output生成可发布 catalog；结构化 JSON serialization而非解析 TS | import/current package script无该命令；current有本地 `generation-io.ts`，目标不同 | **MISSING/PARTIAL** | 若 Magenta需要动态 catalog源，复用结构化 generator输出并与本地 atomic IO合并；明确 schema/version/checksum | AI-040/043/046 | deterministic JSON、strict failure、schema roundtrip、R2 artifact smoke；不要仅比较文件存在。

AI-043 | version `0.80.8` | official: `Models.refresh({ force: true })` bypass freshness | commit `97f9978f` | upstream `models.ts`、README、models-runtime tests | 显式用户刷新绕过 TTL | import/current refresh无 options | **MISSING** | 随 AI-040移植；UI flag只调用 contract，不内嵌 provider特例 | AI-040 | force true/false、offline、abort测试。

AI-044 | version `0.80.8` | official修复项体现在 coding-agent binary；commit “bundle OAuth flows in Bun binaries” | commit `6442536b` | upstream `package.json`新增 `./bun-oauth` export、`src/bun-oauth.ts`、`auth/oauth/load.ts` | 静态引用内建 OAuth flow，避免 Bun tree-shake/动态 import漏包 | import/current无 bun-oauth export | **MISSING** | 在 AI-038/041完成后添加静态 bundle入口，并对 Magenta实际 build命令验证 | AI-038/041、Bun compile | 编译单文件 binary，离线枚举并启动各内建 OAuth flow。

AI-045 | versions `0.80.3`-`0.80.8` | official release/changelog/version/test reporter维护 | commits见附录 | upstream `CHANGELOG.md`, `package.json`, `vitest.config.ts` | Unreleased段、审计 wording、版本号、quiet reporter；不改变库运行协议 | import/current package版本仍0.80.2且采用本地发布体系 | **N/A**（但发布元数据需决策） | 不cherry-pick upstream bump；按master D8使用private local `0.80.8-magenta.0`并记录baseline，禁止用相同name/version发布fork；可采用 quiet reporter | 无 | `npm pack`/package exports smoke。

AI-046 | versions `0.80.4`-`0.80.8` | official多次 “refresh generated model catalogs” 及 release-time regeneration | commits `5b4bda30`、release生成提交等见附录 | upstream generated `*.models.ts`、generator | tag间 models.dev漂移及 release生成结果 | import有提前/选择性 catalog；current又有 `e68303b`, `a1cb8ad`本地刷新 | **PARTIAL/CONFLICT** | 协议代码完成后，从一个确定 source/date重生成一次；评审每个特殊 override，记录 catalog provenance；不要串行 cherry-pick生成文件 | AI-020/022/024/026/031/041/042 | generator deterministic、关键模型 allowlist/contract、diff review gate。

## 建议移植顺序

1. 低耦合 correctness：AI-002/006/008/014/015/017/018/019/025/033/035/039。
2. usage/预算/计费同批：AI-003/007/021/023/024；先定 `Usage.reasoning` 与 cost schema，再接 UI/telemetry。
3. Responses 状态机同批：AI-004/030/032/034，并人工合并 Magenta `82e757c4`、`ebe88ca8`。
4. deferred tools跨包切片：AI-028，必须同时有 producer（agent/coding-agent）和 provider consumer，验证 schema serialization与cache prefix。
5. 破坏性 runtime/auth：AI-038/040/043/044，再接 AI-027/029/036/041。
6. 最后重建 catalog：AI-010/013/020/022/024/026/031/041/042/046；一次生成、逐项协议审查。

## Commit coverage appendix

规则：以下列出 `git log v0.80.2..v0.80.8 -- packages/ai` 的全部 92 个 commit；每个 SHA 仅出现一次并有唯一主归属。merge/release/docs/test/generation commit亦保留。

| # | version | commit | subject（缩写） | 唯一归属 |
|---:|---|---|---|---|
| 1 | 0.80.3 | `e3dcb244` | Microsoft Foundry endpoints | AI-001 |
| 2 | 0.80.3 | `8277bd68` | Add Unreleased | AI-045 |
| 3 | 0.80.3 | `a2e3e9d8` | merge Foundry PR | AI-001 |
| 4 | 0.80.3 | `371adcf3` | explicit provider retry | AI-002 |
| 5 | 0.80.3 | `d7868b09` | Usage.reasoning | AI-003 |
| 6 | 0.80.3 | `9cd2c81a` | regenerate catalogs | AI-010 |
| 7 | 0.80.3 | `8c9dbffa` | out-of-order reasoning | AI-004 |
| 8 | 0.80.3 | `b940c52e` | MiniMax clamp | AI-005 |
| 9 | 0.80.3 | `62fad94f` | provider HTTP body | AI-006 |
| 10 | 0.80.3 | `f78b1637` | revert MiniMax clamp | AI-005 |
| 11 | 0.80.3 | `09f10595` | streamSimple max tokens | AI-007 |
| 12 | 0.80.3 | `54113731` | Codex SSE timeout | AI-008 |
| 13 | 0.80.3 | `b91bdd5a` | Z.AI thinking | AI-009 |
| 14 | 0.80.3 | `6fbeba51` | merge error-body PR | AI-006 |
| 15 | 0.80.3 | `3d6acb37` | regenerate catalog | AI-010 |
| 16 | 0.80.3 | `5c1a2977` | update generated catalog | AI-010 |
| 17 | 0.80.3 | `f98a154d` | audit changelog | AI-045 |
| 18 | 0.80.3 | `a23abe4a` | Release 0.80.3 | AI-045 |
| 19 | 0.80.4 | `dd87c02c` | Add Unreleased | AI-045 |
| 20 | 0.80.4 | `a3cc169d` | Codex user-agent race | AI-011 |
| 21 | 0.80.4 | `0ac3cfe0` | Codex zstd | AI-011 |
| 22 | 0.80.4 | `42063764` | Copilot Sonnet 5 | AI-020 |
| 23 | 0.80.4 | `1d061b3f` | remove stale metadata fallback | AI-013 |
| 24 | 0.80.4 | `844d175e` | Fireworks GLM | AI-020 |
| 25 | 0.80.4 | `1da1cdb2` | regenerate models | AI-020 |
| 26 | 0.80.4 | `8c943640` | remove Bedrock fallback | AI-013 |
| 27 | 0.80.4 | `e2ccdc85` | delay first Copilot poll | AI-012 |
| 28 | 0.80.4 | `e285e90f` | remove Sonnet fallback | AI-020 |
| 29 | 0.80.4 | `114bacf3` | Bedrock Claude 5 cache | AI-013 |
| 30 | 0.80.4 | `21cb3807` | DS4 overflow | AI-014 |
| 31 | 0.80.4 | `23d14626` | Codex session rotation | AI-011 |
| 32 | 0.80.4 | `8133c94d` | slow_down interval | AI-012 |
| 33 | 0.80.4 | `d53b5676` | Cloudflare 524 retry | AI-015 |
| 34 | 0.80.4 | `ee24a9ec` | refresh catalogs | AI-020 |
| 35 | 0.80.4 | `035ea9c8` | redundant record guards | AI-016 |
| 36 | 0.80.4 | `47830134` | quiet reporters | AI-045 |
| 37 | 0.80.4 | `2e4ad6a0` | Responses token floor | AI-019 |
| 38 | 0.80.4 | `8c0ccd14` | normalize null content | AI-017 |
| 39 | 0.80.4 | `279f53b0` | empty tool output | AI-018 |
| 40 | 0.80.4 | `cc2db980` | Xiaomi catalogs | AI-020 |
| 41 | 0.80.4 | `9eedaf8c` | Copilot 1M contexts | AI-020 |
| 42 | 0.80.4 | `72d77b53` | update catalogs | AI-020 |
| 43 | 0.80.4 | `4285712b` | Bun socket retry | AI-015 |
| 44 | 0.80.4 | `57d96d72` | ResourceExhausted retry | AI-015 |
| 45 | 0.80.4 | `7df2a94e` | GPT-5.6 metadata | AI-020 |
| 46 | 0.80.4 | `bf75b8aa` | audit changelog | AI-045 |
| 47 | 0.80.4 | `912d0953` | Release 0.80.4 | AI-045 |
| 48 | 0.80.5 | `ef793a98` | Add Unreleased | AI-045 |
| 49 | 0.80.5 | `cc62baa4` | Release 0.80.5 | AI-045 |
| 50 | 0.80.6 | `e3513193` | Add Unreleased | AI-045 |
| 51 | 0.80.6 | `8973ae28` | stale post-compaction usage | AI-021 |
| 52 | 0.80.6 | `fbdd4638` | max thinking | AI-022 |
| 53 | 0.80.6 | `6c735db0` | remove GPT-5.6 alias | AI-024 |
| 54 | 0.80.6 | `a9ecf301` | input pricing tiers | AI-023 |
| 55 | 0.80.6 | `3664806f` | long-context pricing | AI-024 |
| 56 | 0.80.6 | `6731a0ba` | empty thinking + signature | AI-025 |
| 57 | 0.80.6 | `33874659` | isolate pricing test | AI-023 |
| 58 | 0.80.6 | `1775fe4c` | audit changelog | AI-045 |
| 59 | 0.80.6 | `5b4bda30` | refresh generated catalogs | AI-046 |
| 60 | 0.80.6 | `2b3fda99` | Release 0.80.6 | AI-045 |
| 61 | 0.80.7 | `34582ef3` | Add Unreleased | AI-045 |
| 62 | 0.80.7 | `46145bef` | OpenRouter context source | AI-026 |
| 63 | 0.80.7 | `bc469b03` | Fable xhigh/max | AI-026 |
| 64 | 0.80.7 | `3ea064ea` | Bedrock API key | AI-027 |
| 65 | 0.80.7 | `3d8f7435` | message-anchored tools | AI-028 |
| 66 | 0.80.7 | `4c186103` | audit changelog | AI-045 |
| 67 | 0.80.7 | `19fe0e01` | ambient AWS auth | AI-027 |
| 68 | 0.80.7 | `850c210b` | ambient auth marker filter | AI-027 |
| 69 | 0.80.7 | `bdd5c53b` | Cloudflare ambient IDs | AI-029 |
| 70 | 0.80.7 | `eacaa130` | forced Responses tools | AI-030 |
| 71 | 0.80.7 | `f7b78e2a` | MAI Responses route | AI-031 |
| 72 | 0.80.7 | `298665cf` | session affinity format | AI-032 |
| 73 | 0.80.7 | `f8f75544` | Bedrock stop reason | AI-033 |
| 74 | 0.80.7 | `1f0dbc00` | encrypted_content backfill | AI-034 |
| 75 | 0.80.7 | `0e6909f0` | optional Anthropic usage | AI-035 |
| 76 | 0.80.7 | `961fa6c1` | Radius/pi-messages | AI-036 |
| 77 | 0.80.7 | `92ffae52` | Anthropic probe typing | AI-037 |
| 78 | 0.80.7 | `1f9e846c` | OpenCode no session-id | AI-032 |
| 79 | 0.80.7 | `9993c969` | model runtime/auth replacement | AI-038 |
| 80 | 0.80.7 | `53a087fe` | audit changelog | AI-045 |
| 81 | 0.80.7 | `818d6745` | Release 0.80.7 + generated models | AI-046 |
| 82 | 0.80.8 | `9d09075c` | Add Unreleased | AI-045 |
| 83 | 0.80.8 | `dcfe36c7` | Codex session-id clamp | AI-039 |
| 84 | 0.80.8 | `cd7cad4e` | merge runtime facade | AI-038 |
| 85 | 0.80.8 | `bd9e09db` | dynamic provider refresh | AI-040 |
| 86 | 0.80.8 | `5e336cfa` | merge runtime changes | AI-038 |
| 87 | 0.80.8 | `5220aba6` | xAI OAuth/Responses | AI-041 |
| 88 | 0.80.8 | `2be9efa1` | publish catalog R2 | AI-042 |
| 89 | 0.80.8 | `97f9978f` | refresh force flag | AI-043 |
| 90 | 0.80.8 | `eb793510` | audit changelog | AI-045 |
| 91 | 0.80.8 | `6442536b` | bundle OAuth in Bun | AI-044 |
| 92 | 0.80.8 | `fae7176c` | Release 0.80.8 + generated OpenRouter | AI-046 |

## 自查

- commit 集合基准：`git log v0.80.2..v0.80.8 -- packages/ai`，计数 92；附录编号 1..92，无遗漏。
- item 集合：`AI-001..AI-046`，46 项；每项均有 version、wording/未单列说明、SHA、文件/符号、行为、import、current证据、分类、动作、依赖、测试。
- 特别核验：`Usage.reasoning`=MISSING；`thinking/max`=CONFLICT；empty thinking signature=MISSING；pricing tiers=MISSING；`sessionAffinityFormat`=MISSING/CONFLICT；message-anchored/deferred tools=MISSING；provider/auth/Models v8=CONFLICT；schema serialization已在 AI-028/042区分 runtime tool schema 与 generated catalog JSON；catalog refresh不等于协议落地。
- 最大风险：当前 catalog 对 GPT-5.6/Grok 4.5/MAI-Code/Claude effort 暴露出比协议实现更“新”的表象，会分别造成错误 context/计费、错误 endpoint、缺失 forced/deferred tools、以及不受支持的 thinking effort。
