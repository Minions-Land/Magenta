# PI upstream 版本史：v0.80.2 至 v0.80.10

> 调研日期：2026-07-17（UTC+8）
>
> Upstream：[`earendil-works/pi`](https://github.com/earendil-works/pi)
>
> 基线：[`v0.80.2`](https://github.com/earendil-works/pi/tree/v0.80.2)
>
> 截止版本：[`v0.80.10`](https://github.com/earendil-works/pi/tree/v0.80.10)

## 1. 范围与方法

### 1.1 范围

本报告覆盖 `v0.80.2` **之后**至调研日最新稳定 tag 的每一个稳定版本：

`v0.80.3` → `v0.80.4` → `v0.80.5` → `v0.80.6` → `v0.80.7` → `v0.80.8` → `v0.80.9` → `v0.80.10`

共 8 个版本，无跳号。GitHub tags 在 `v0.80.10` 之后没有更高稳定 tag；GitHub 将 `v0.80.10` 标为非 prerelease，npm 新命名空间的 `latest` 也为 `0.80.10`：

- [GitHub tags](https://github.com/earendil-works/pi/tags)
- [GitHub v0.80.10 Release](https://github.com/earendil-works/pi/releases/tag/v0.80.10)
- [npm `@earendil-works/pi-coding-agent@latest`](https://registry.npmjs.org/@earendil-works/pi-coding-agent/latest)

旧命名空间 `@mariozechner/pi-coding-agent` 已弃用且 `latest` 停留在旧版本，不用于判断本仓库的 upstream 最新版。

### 1.2 证据层级

1. **官方声明**：GitHub Release 正文。
2. **官方 CHANGELOG**：tag 固化的各 workspace `CHANGELOG.md`。
3. **commit/diff 归纳**：相邻 tag 的 Git commit 与文件 diff；凡由此得出的结论均明确标注，不冒充官方声明。
4. **发布元数据核验**：Git tag ref、tag 指向的 commit、npm `latest`/`gitHead`。
5. **Magenta 差异核验**：对 2026-07-17 当前共享 worktree 做静态符号、包版本和源码检查；这反映“当前工作树”，不等同于某个干净 Git tag。

日期优先采用 GitHub Release `published_at` 的 UTC 日期；`v0.80.4` 没有 GitHub Release，采用 tag 所指 commit 的提交日期。SHA 均为 tag 指向的 commit，而非短 SHA 推测。

### 1.3 判定边界

- “Breaking”只在官方 Release/CHANGELOG 明示，或 API/type diff 能直接证明时使用。
- “Security”只记录官方文字或 commit 明示；没有把普通依赖刷新推断成安全修复。
- 文件计数是 `git diff --name-only <prev>..<tag>` 的 workspace 归类，会包括 CHANGELOG、package metadata、测试和生成 catalog，不能直接当作运行时代码量。
- Release 中的 “inherited” 表示变化来自本 monorepo 内较底层 workspace（主要是 `pi-ai`/`agent-core`），不是说 Magenta 自动继承了它。

## 2. 版本总览

| Tag | 日期 | Tag SHA | 相对前版 commits | 官方说明 | 核心影响 |
|---|---:|---|---:|---|---|
| [`v0.80.3`](https://github.com/earendil-works/pi/releases/tag/v0.80.3) | 2026-06-30 | [`a23abe4a695d`](https://github.com/earendil-works/pi/commit/a23abe4a695df8b69b613f73e9fdda2a8af894d4) | 93 | 完整 Release + CHANGELOG | Sonnet 5、RPC tree、UI 设置、reasoning usage、多项 provider/runtime 修复 |
| [`v0.80.4`](https://github.com/earendil-works/pi/tree/v0.80.4) | 2026-07-09 | [`912d0953f678`](https://github.com/earendil-works/pi/commit/912d0953f678bb50b0725e9c0ff65b65d4be97f5) | 82 | 无 GitHub Release；完整 CHANGELOG | GPT-5.6、cache miss 可见性、extension lifecycle/header hooks、项目级资源配置 |
| [`v0.80.5`](https://github.com/earendil-works/pi/releases/tag/v0.80.5) | 2026-07-09 | [`cc62baa442b5`](https://github.com/earendil-works/pi/commit/cc62baa442b5c0333923fdfdcc1d7264f445b5b0) | 3 | Release 仅写 “Release 0.80.5”；CHANGELOG 空节 | 版本重发；唯一非发布机械提交是测试 fixture 修复 |
| [`v0.80.6`](https://github.com/earendil-works/pi/releases/tag/v0.80.6) | 2026-07-09 | [`2b3fda9921b5`](https://github.com/earendil-works/pi/commit/2b3fda9921b5590f285165287bd442a25817f17b) | 14 | 完整 Release + CHANGELOG | `max` thinking、输入定价阶梯、compaction usage 与 Anthropic thinking 修复 |
| [`v0.80.7`](https://github.com/earendil-works/pi/releases/tag/v0.80.7) | 2026-07-14 | [`818d67457cdd`](https://github.com/earendil-works/pi/commit/818d67457cdd6b60bce6b121d16b23141c252dd8) | 31 | 完整 Release + CHANGELOG | session-affinity breaking、cache-friendly 动态工具、provider/auth/TUI 修复 |
| [`v0.80.8`](https://github.com/earendil-works/pi/releases/tag/v0.80.8) | 2026-07-16 | [`fae7176cb9f7`](https://github.com/earendil-works/pi/commit/fae7176cb9f7c4725a40d9d481d8d70b80f18086) | 20 | 完整 Release + CHANGELOG | `ModelRuntime`/provider auth 大迁移、动态 catalog、xAI OAuth、Grok 4.5 |
| [`v0.80.9`](https://github.com/earendil-works/pi/releases/tag/v0.80.9) | 2026-07-16 | [`2d16f9297323`](https://github.com/earendil-works/pi/commit/2d16f92973230a7e095aa984f150ba8702784f50) | 10 | 完整 Release + CHANGELOG | Kimi K3、Kimi deferred tools、xAI catalog 清理 |
| [`v0.80.10`](https://github.com/earendil-works/pi/releases/tag/v0.80.10) | 2026-07-16 | [`8dc78834cde4`](https://github.com/earendil-works/pi/commit/8dc78834cde4e329284cf505f9e3f99763df5529) | 7 | 完整 Release + CHANGELOG | Kimi adaptive thinking、K3 pricing/thinking metadata、xAI catalog 回归修复 |

Tag ref 可由 GitHub API 一手核验，例如 [`v0.80.4`](https://api.github.com/repos/earendil-works/pi/git/ref/tags/v0.80.4) 和 [`v0.80.10`](https://api.github.com/repos/earendil-works/pi/git/ref/tags/v0.80.10)。

## 3. 逐版本详表

### 3.1 v0.80.3

**证据**：[Release](https://github.com/earendil-works/pi/releases/tag/v0.80.3) · [coding-agent CHANGELOG](https://github.com/earendil-works/pi/blob/v0.80.3/packages/coding-agent/CHANGELOG.md) · [compare v0.80.2...v0.80.3](https://github.com/earendil-works/pi/compare/v0.80.2...v0.80.3)

**官方明示更新**：

- Claude Sonnet 5 进入 Anthropic-compatible、Bedrock 等 provider catalog，并启用 adaptive thinking。
- `outputPad` 控制用户、assistant、thinking 的水平留白；`externalEditor` 为 `Ctrl+G` 指定编辑器。
- RPC 增加 `get_entries`、`get_tree`；package 增加 `./rpc-entry` export。
- extension 增加 `session_info_changed`。
- Azure OpenAI Responses 支持现代 Microsoft Foundry endpoint。
- `Usage.reasoning` 记录 provider 报告的 reasoning/thinking token 子集。
- 默认 OpenAI model 改为 `gpt-5.5`。
- provider 错误体、OpenAI Responses reasoning replay、Z.AI preserved thinking、Codex SSE header timeout、stream token cap、显式 retry 等得到修复。
- coding-agent 修复 pre-prompt compaction 继续执行、恢复 session 时资源消息顺序、status indicator 收缩、非法 session 覆盖、BMP 输入、输出截断提示等。

**按 workspace/package 的实质变化（官方 CHANGELOG + diff）**：

- `packages/ai`（49 个变更文件）：Sonnet 5 catalog、Azure Foundry、reasoning usage、HTTP/provider error、reasoning replay、模型 catalog 刷新。
- `packages/agent`（5 个变更文件）：增加 `prepareNextTurnWithContext`，修复 next-turn abort signal 传递。
- `packages/tui`（4 个变更文件）：Markdown renderer 可保留源码 backslash escape。
- `packages/coding-agent`（72 个变更文件）：RPC、session event、UI settings、compaction、session validation、BMP、retry/status 等。
- `packages/orchestrator`（17 个变更文件）：新增实验性 IPC/RPC bridge、supervisor、machine/instance storage、Radius connection 等。该 workspace 的 `0.80.3` CHANGELOG 本身为空；这些是**commit/diff 归纳**，可从 compare 的 `feat: ipc socket`、`feat: supervisor`、`feat: rpc bridge` 等 commits 核验。
- repo/CI：release assets、installer lock、bot gate 等工作流调整。

**影响分类**：

- Breaking：Release 未明示 breaking。
- Behavioral：默认 OpenAI model 变更；pre-prompt compaction 不再自动继续。
- Provider：Sonnet 5、Azure Foundry、Z.AI、Codex/OpenAI 修复。
- Tool/RPC：RPC tree read API；BMP 输入；extension tool refresh 时序修复。
- Runtime：undici mid-stream crash、provider retry、session validation/status lifecycle。
- Security：官方 Release 未标安全公告。compare 中 [`1d486163`](https://github.com/earendil-works/pi/commit/1d48616328f27ff37badc40c6a6b2acf48bfd686) 的提交信息明示 “update to latest undici for vuln fix”，但实际主要是 root lockfile/examples；[`8f64353e`](https://github.com/earendil-works/pi/commit/8f64353e) 明示限制 bot gate bypass。二者属于 **commit/diff 事实**，不能外推为特定 CVE/GHSA 已修复。

### 3.2 v0.80.4

**证据**：[tag](https://github.com/earendil-works/pi/tree/v0.80.4) · [coding-agent CHANGELOG](https://github.com/earendil-works/pi/blob/v0.80.4/packages/coding-agent/CHANGELOG.md) · [ai CHANGELOG](https://github.com/earendil-works/pi/blob/v0.80.4/packages/ai/CHANGELOG.md) · [compare v0.80.3...v0.80.4](https://github.com/earendil-works/pi/compare/v0.80.3...v0.80.4)

GitHub Releases API 对 `v0.80.4` 返回 404，即没有对应 GitHub Release；但 tag 内四个主要 package 的 CHANGELOG 都有正式 `0.80.4` 节，因此以下以官方 CHANGELOG 为主，不把 diff 摘要冒充 Release 正文。

**官方明示更新**：

- `showCacheMissNotices` 将显著 prompt-cache miss 显示到 transcript。
- `pi config -l` 与 Tab scope switching 管理 project-local package resources。
- extension/RPC 增加 `agent_settled` 与 fully-settled wait。
- extension 增加 `before_provider_headers`、`InlineExtension`、persisted display-only entry renderer。
- SDK 导出 model/scoped-model resolution helpers。
- `/login <provider>` 支持参数和 autocomplete。
- agent-core 导出 `InMemorySessionStorage`、`JsonlSessionStorage`，JSONL header 支持 custom metadata。
- 新增 GPT-5.6 metadata、Copilot Sonnet 5、Codex SSE zstd compression。
- 修复 `ResourceExhausted`、Cloudflare 524、Bun socket drop retry；Copilot device polling；Codex WS 60 分钟轮换；null message ingestion；length-truncated tool call；Bedrock cache；max output floor；compaction serialization/budget 等。
- Bash 非正数或超大 timeout 现在明确校验失败；edit schema 容忍模型额外 replacement fields。

**按 workspace/package 的实质变化**：

- `packages/ai`（50 个变更文件）：GPT-5.6/Copilot catalog、zstd transport、OAuth polling、retry/overflow/provider transforms。
- `packages/agent`（17 个变更文件）：storage exports、JSONL metadata、context projector、compaction serialization、timeout validation。
- `packages/tui`（3 个变更文件）：paste marker 删除/terminal clear 后的计数修复。
- `packages/coding-agent`（90 个变更文件）：cache notice、资源 scope、extension lifecycle/header/rendering、SDK/RPC、model resolution 与大量回归测试。
- `packages/orchestrator`：仅 changelog/package metadata；无明示功能更新。
- `.github`/`.pi`：issue-analysis workflow 与导入 repro 等维护性变化，不是 CLI 公共功能。

**影响分类**：

- Breaking：CHANGELOG 未明示 breaking。
- Behavioral：bash timeout 从隐式 clamp/即时失败改为显式 validation error；启动时跳过无认证 saved default。
- Provider：GPT-5.6、Copilot Sonnet 5、OAuth/retry、Bedrock/OpenAI/Fireworks/Xiaomi 修复。
- Tool/Extension：`agent_settled`、header hook、entry renderer、edit/bash schema 行为。
- Runtime：project resource scope、compaction concurrency、Windows context walk、Bun clipboard/socket。
- Security：官方 CHANGELOG 未标安全修复。

### 3.3 v0.80.5

**证据**：[Release](https://github.com/earendil-works/pi/releases/tag/v0.80.5) · [coding-agent CHANGELOG](https://github.com/earendil-works/pi/blob/v0.80.5/packages/coding-agent/CHANGELOG.md) · [compare v0.80.4...v0.80.5](https://github.com/earendil-works/pi/compare/v0.80.4...v0.80.5)

**官方明示更新**：Release 仅写 “Release 0.80.5”，各 package CHANGELOG 的 `0.80.5` 节为空，没有功能或修复条目。

因此逐条列出相对 `v0.80.4` 的 3 个 commits（**commit/diff 归纳**）：

1. [`ef793a98`](https://github.com/earendil-works/pi/commit/ef793a98) `Add [Unreleased] section for next cycle`：CHANGELOG 维护。
2. [`a98778e21c67`](https://github.com/earendil-works/pi/commit/a98778e21c672392ed22a7404639ad55616d6c79) `test(coding-agent): fix interactive mode fixture`：只改 `4167-thinking-toggle-pending-tool-render.test.ts` 测试 fixture，不改运行时代码。
3. [`cc62baa442b5`](https://github.com/earendil-works/pi/commit/cc62baa442b5c0333923fdfdcc1d7264f445b5b0) `Release v0.80.5`：将 workspace 版本及 inter-package dependency 从 `0.80.4` bump 至 `0.80.5`，刷新 lock/shrinkwrap/CHANGELOG。

**按 workspace/package 的实质变化**：

- `coding-agent`：1 个测试 fixture 调整；其余为 version/lock/CHANGELOG。
- `ai`、`agent`、`tui`、`orchestrator`：只有版本/CHANGELOG metadata。
- Runtime/provider/tool：无可证实的生产代码变化。

**影响分类**：无官方 breaking、behavioral、security、provider、tool 或 runtime 变化。它应视为发布/测试修正版，而不是功能版本。

### 3.4 v0.80.6

**证据**：[Release](https://github.com/earendil-works/pi/releases/tag/v0.80.6) · [ai CHANGELOG](https://github.com/earendil-works/pi/blob/v0.80.6/packages/ai/CHANGELOG.md) · [coding-agent CHANGELOG](https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/CHANGELOG.md) · [compare v0.80.5...v0.80.6](https://github.com/earendil-works/pi/compare/v0.80.5...v0.80.6)

**官方明示更新**：

- 新增 opt-in `max` thinking level，贯通 CLI `--thinking max`、SDK、RPC、model selector、theme；theme 可定义 `thinkingMax`，否则 fallback 到 `thinkingXhigh`。
- GPT-5.6 与 adaptive Claude 获得相应 `xhigh`/`max` metadata。
- 新增 request-wide input-token pricing tiers，覆盖内置 model、`models.json`、`modelOverrides`、extension provider。
- `shellPath` 支持 `~` 展开。
- 修复 compaction 后 output-token budget 误用 compaction 前 stale assistant usage。
- 修复 GPT-5.4/5.5 长上下文计费，区分 GPT-5.6 direct OpenAI 272K 与 Codex 372K，并移除不存在的 bare `gpt-5.6` alias。
- Anthropic conversion 不再丢弃“thinking 文本为空但 signature 有效”的 block。

**按 workspace/package 的实质变化**：

- `packages/ai`（42 个变更文件）：thinking level/types/catalog、pricing tier/cost、Anthropic transform、GPT metadata。
- `packages/agent`（4 个变更文件）：thinking type 和 usage budget 相关适配。
- `packages/tui`（2 个变更文件）：版本/CHANGELOG，无独立功能条目。
- `packages/coding-agent`（40 个变更文件）：CLI/SDK/RPC/theme/settings/model registry 与 `shellPath`。
- repo/CI：release 改为完整测试 gate。

**影响分类**：

- Breaking：未明示；但自定义 theme 若希望区分 `max` 应新增 `thinkingMax`，否则有兼容 fallback。
- Behavioral：新增可选 reasoning level；计费和 token budget 更准确。
- Provider：GPT-5.4/5.5/5.6 与 Anthropic adaptive thinking。
- Tool/runtime：shell path 展开；compaction budget 修复。
- Security：无官方安全条目。

### 3.5 v0.80.7

**证据**：[Release](https://github.com/earendil-works/pi/releases/tag/v0.80.7) · [ai CHANGELOG](https://github.com/earendil-works/pi/blob/v0.80.7/packages/ai/CHANGELOG.md) · [coding-agent CHANGELOG](https://github.com/earendil-works/pi/blob/v0.80.7/packages/coding-agent/CHANGELOG.md) · [compare v0.80.6...v0.80.7](https://github.com/earendil-works/pi/compare/v0.80.6...v0.80.7)

**官方明示 Breaking Change**：

- 删除 `openai-responses` 的 `compat.sendSessionIdHeader`；改用 `compat.sessionAffinityFormat: "openai" | "openai-nosession" | "openrouter"`。原 `sendSessionIdHeader: false` 必须迁移为 `sessionAffinityFormat: "openai-nosession"`（[#6496](https://github.com/earendil-works/pi/pull/6496)）。

**官方明示更新**：

- cache-friendly dynamic tool loading：`ToolResultMessage.addedToolNames` 标记工具何时可用；Anthropic/OpenAI Responses 将 late tool definitions 放在对应消息位置，保留 prompt cache prefix。
- `Ctrl+X` 复制最后一条 assistant message 或 `/tree` 选中消息。
- Fable 5 catalog 增加 `xhigh`/`max`；OpenAI/Codex Responses 增加 required/named `toolChoice`。
- 修复 OpenRouter context window 与 `x-session-id` affinity、Bedrock API key/ambient SigV4/error、Cloudflare ambient IDs、Copilot MAI endpoint、Azure encrypted reasoning replay、Anthropic proxy 缺失 usage、OpenCode session header。
- `Ctrl+V` 在 clipboard 无 image 时回退 paste text；legacy terminal Alt+symbol decoding 修复。
- branch summary 支持 ambient auth；npm uninstall 在 peer dependency 冲突时使用 legacy-peer-deps。
- 默认 system prompt 删除当前日期，避免每日 prompt-cache invalidation。

**按 workspace/package 的实质变化**：

- `packages/ai`（47 个变更文件）：message-anchored tools、session affinity breaking、provider auth/session/reasoning/usage 修复。
- `packages/agent`（4 个变更文件）：tool availability marker 与上下文投影适配。
- `packages/tui`（4 个变更文件）：legacy Alt parsing。
- `packages/coding-agent`（47 个变更文件）：dynamic extension tool activation、copy/paste、login、branch summary、prompt、package uninstall。
- `packages/orchestrator`：版本/CHANGELOG metadata。

**影响分类**：

- Breaking：`sendSessionIdHeader` schema/API 迁移。
- Behavioral：默认 prompt 不再含日期；`Ctrl+X`/`Ctrl+V` 行为；tools 可在一次 run 中渐进激活。
- Provider/Auth：OpenRouter、Bedrock、Cloudflare、Copilot、Azure、OpenCode、Anthropic proxy。
- Tool：动态工具加载与 `toolChoice` 是本版最重要的 tool protocol 变化。
- Runtime：branch summary ambient auth、npm uninstall、terminal key decoding。
- Security：无官方安全条目。

### 3.6 v0.80.8

**证据**：[Release](https://github.com/earendil-works/pi/releases/tag/v0.80.8) · [ai CHANGELOG](https://github.com/earendil-works/pi/blob/v0.80.8/packages/ai/CHANGELOG.md) · [coding-agent CHANGELOG](https://github.com/earendil-works/pi/blob/v0.80.8/packages/coding-agent/CHANGELOG.md) · [compare v0.80.7...v0.80.8](https://github.com/earendil-works/pi/compare/v0.80.7...v0.80.8)

这是本区间迁移成本最高的版本。

**官方明示 Breaking Changes（coding-agent SDK）**：

- `CreateAgentSessionOptions.authStorage` 与 `modelRegistry` 改为 async `modelRuntime`。
- `AuthStorage` 及其 storage backend 不再 export；改用 `ModelRuntime`、自定义 pi-ai `CredentialStore`，或一次性 `readStoredCredential()`。
- 删除 `ModelRuntime.getAll()`、`find()`、`getSnapshot()`、`getAuthOptions()`；使用 pi-ai `Models.getModels()`、`getModel()`、`getProviders()`、`checkAuth()`。
- request auth 从 `ModelRegistry.getApiKeyAndHeaders()` 改为 `ModelRuntime.getAuth()`。
- extension-facing `ModelRegistry.refresh()` 从同步 `void` 改为 `Promise<void>`，调用方必须 `await`。
- canonical dynamic refresh 改为 async `ModelRuntime.refresh()`/`Models.refresh()`。

**官方明示 Breaking Changes（pi-ai）**：

- auth 改为 provider-scoped `Models.checkAuth/getAuth/login/logout`；`checkAuth()` 返回 `AuthCheck | undefined`。
- 删除 legacy built-in OAuth objects/global registry/低层 login-refresh exports；使用 `Provider.auth.oauth`。
- `AuthLoginCallbacks` 重命名为 provider-neutral `AuthInteraction`。
- `Models.getAuth(model)` 现在包含 model headers；custom Models 必须按新顺序执行 `transformHeaders`。
- dynamic refresh 签名改为 `Models.refresh(options)` 和带 credential/storage/network/abort context 的 `Provider.refreshModels(context)`。

**官方明示新增/修复**：

- `ModelRuntime` 成为 coding-agent SDK 与内部 model/auth facade，同时保留同步 extension-facing `ModelRegistry` projection。
- provider-owned `/login` discovery、ambient auth status 和 info links。
- `models-store.json` 持久化动态 catalog、pi.dev per-provider overlays、Radius gateway 与 legacy catalog 离线迁移。
- extension provider `refreshModels(context)`；`pi update --models` 强制 refresh；`/model` 先显示 snapshot 后后台刷新。
- xAI device-code OAuth；Grok 4.5 走 OpenAI Responses，支持 low/medium/high thinking。
- 修复 Codex session id >64、terminal tab normalization、Windows title、Bun binary OAuth bundling、thinking blocks 合并。

**按 workspace/package 的实质变化**：

- `packages/ai`（65 个变更文件）：provider-owned auth、CredentialStore、ModelsStore、refresh contract、xAI/Radius、catalog generation。
- `packages/agent`（3 个变更文件）：新 Models/auth contract 适配。
- `packages/tui`（4 个变更文件）：tab normalization。
- `packages/coding-agent`（108 个变更文件）：`ModelRuntime`、SDK/login/model picker/update、storage/migration、binary bundling、docs/tests。
- `packages/orchestrator`（4 个变更文件）：除版本/CHANGELOG 外，package dependency/lock 随新 runtime 更新。

**影响分类**：

- Breaking：auth、SDK session options、refresh async contract、Models request contract。
- Behavioral：model picker 后台 refresh；provider 自主管理登录/availability/catalog。
- Provider/Auth：xAI、Radius、Bedrock/Vertex provider-owned flows。
- Tool/Extension：extension provider refresh 接口变化；header assembly owner 改变。
- Runtime：file-backed catalog、offline migration、Bun OAuth bundling。
- Security：无官方安全条目；但 auth owner 和 credential interfaces 大改，需要单独做 credential regression，而不能仅靠编译通过。

### 3.7 v0.80.9

**证据**：[Release](https://github.com/earendil-works/pi/releases/tag/v0.80.9) · [coding-agent CHANGELOG](https://github.com/earendil-works/pi/blob/v0.80.9/packages/coding-agent/CHANGELOG.md) · [compare v0.80.8...v0.80.9](https://github.com/earendil-works/pi/compare/v0.80.8...v0.80.9)

**官方明示更新**：

- Kimi K3 加入 Kimi Coding、Moonshot AI/China、OpenRouter、Vercel AI Gateway。
- Kimi native deferred tool loading 支持 extension-driven progressive activation，并提供示例。
- 修复 K3 在 Vercel/OpenRouter 的 output limits。
- xAI device login 使用预填 authorization link，文案为 “Sign in with SuperGrok or X Premium”，默认 xAI model 改为 Grok 4.5。
- 从内置 xAI catalog 删除 Grok 3、Grok 3 Fast、Grok 4.20 variants、Grok Code Fast 1。
- session 在首个 assistant response 前 clone/fork 时，明确提示必须先保存。

**按 workspace/package 的实质变化**：

- `packages/ai`（25 个变更文件）：K3 provider catalog、OpenAI Completions deferred protocol、gateway limits、xAI catalog。
- `packages/coding-agent`（22 个变更文件）：Kimi deferred tool extension/example/docs、xAI login、unsaved clone message。
- `agent`/`tui`/`orchestrator`：版本/CHANGELOG metadata。

**影响分类**：

- Breaking：未明示；但依赖被删除 xAI model ID 的配置会在 model resolution 时行为变化。
- Behavioral：xAI 默认 model 改为 Grok 4.5；旧 xAI built-ins 移除。
- Provider：Kimi K3 与 xAI。
- Tool：Kimi native deferred tool protocol。
- Runtime：unsaved session clone/fork 失败信息更准确。
- Security：无官方安全条目。

### 3.8 v0.80.10

**证据**：[Release](https://github.com/earendil-works/pi/releases/tag/v0.80.10) · [coding-agent CHANGELOG](https://github.com/earendil-works/pi/blob/v0.80.10/packages/coding-agent/CHANGELOG.md) · [compare v0.80.9...v0.80.10](https://github.com/earendil-works/pi/compare/v0.80.9...v0.80.10)

**官方明示更新**：

- Kimi Coding request 改用 Anthropic adaptive thinking effort，不再使用 token budget。
- K3 与 `kimi-for-coding` 支持 replay empty-signature thinking block。
- 修复 Moonshot AI/China K3 pricing metadata。
- Kimi Coding K3 只暴露其支持的 `max` thinking level（[#6737](https://github.com/earendil-works/pi/issues/6737)）。
- 修复 `0.80.9` catalog generation 将已删除 xAI models 又生成回来的回归（[#6736](https://github.com/earendil-works/pi/issues/6736)）。

**按 workspace/package 的实质变化**：

- `packages/ai`（20 个变更文件）：Kimi adaptive thinking、empty signature、pricing/thinking metadata、xAI generation exclusion 与生成 catalog。
- `packages/coding-agent`（14 个变更文件）：provider/model docs、生成依赖与 release metadata。
- `agent`/`tui`/`orchestrator`：版本/CHANGELOG metadata。

**影响分类**：

- Breaking：未明示。
- Behavioral/Provider：Kimi reasoning payload、可选 thinking level 与 cost metadata 改变。
- Tool：延续 `0.80.9` Kimi deferred tool，未再改变 extension API。
- Runtime：修复 catalog regeneration 回归。
- Security：无官方安全条目。

## 4. 跨版本主题

### 4.1 Model/provider runtime 从静态 registry 走向 provider-owned runtime

`0.80.3-0.80.7` 先持续增加 model metadata、auth edge-case、session affinity 和动态工具；`0.80.8` 将这些能力集中到 `Models` + `ModelRuntime` + provider-owned auth/catalog。`0.80.9-0.80.10` 的 Kimi/xAI 变化建立在新 runtime 上。对 fork 来说，不能只复制 generated `*.models.ts`：否则 catalog 可能存在，但 login、header transform、refresh、storage 或 request payload 仍走旧路径。

### 4.2 Prompt cache 与动态工具成为协议层问题

- `0.80.4`：cache miss 可见性。
- `0.80.6`：compaction stale usage 修复影响 token budget。
- `0.80.7`：message-anchored tool availability 保留 cache prefix；默认 prompt 删除日期。
- `0.80.9`：Kimi native deferred tools。

这说明动态工具并非仅是 `registerTool()` UI/API；需要 agent context、tool result marker 和 provider serializer 同步迁移。

### 4.3 Thinking/reasoning metadata 连续演进

- `0.80.3`：`Usage.reasoning`、Sonnet 5 adaptive thinking、reasoning replay。
- `0.80.4`：GPT-5.6 metadata。
- `0.80.6`：公共 `max` thinking 与空文本/有效 signature 保留。
- `0.80.7`：Fable 5 `xhigh/max`。
- `0.80.9-0.80.10`：Kimi K3 与 adaptive/empty-signature compatibility。

只更新 model catalog 而不更新 types、payload conversion、replay 和 UI selector 会造成“模型可见但请求不兼容”。

### 4.4 Auth 与 session affinity 是高回归面

`0.80.7` 先把 OpenAI Responses session affinity 显式格式化；`0.80.8` 又重写 auth owner、credential storage、header assembly 与 login flow。Bedrock、Cloudflare、OpenRouter、OpenCode、xAI 都在这两版有 provider-specific 修复，表明手工移植必须有 provider matrix 测试。

### 4.5 Security 结论

8 个 Release/CHANGELOG 中没有官方 “Security” 章节或 CVE/GHSA 声明。唯一直接含安全措辞的证据是 `0.80.3` compare 内的 undici “vuln fix” commit 和 bot gate bypass restriction；报告不对未明示的漏洞编号、可利用性或受影响版本作推断。

## 5. Magenta3 当前 fork 差异与建议

### 5.1 核验基准

当前 worktree 的 Pi packages 均仍声明 `0.80.2`：

- [`pi/coding-agent/package.json`](../../pi/coding-agent/package.json)
- [`pi/ai/package.json`](../../pi/ai/package.json)
- [`pi/agent/package.json`](../../pi/agent/package.json)
- [`pi/tui/package.json`](../../pi/tui/package.json)

`coding-agent` 依赖也固定为 `@earendil-works/pi-{ai,agent-core,tui}@0.80.2`。与此同时，本地 history 和源码显示大量 Magenta/HCP/teammate/background-shell/prompt-cache 自有演进，所以“package version = 0.80.2”只能证明发布基线，不能证明某个 upstream fix 一定缺失。

以下状态来自当前 worktree 静态核验：

- **已有**：能在本地源码找到对应公共 type/行为及实现证据。
- **部分已有**：结果或相邻能力存在，但 upstream 协议/API 主体不存在。
- **缺失**：关键 upstream 标识和实现路径均不存在，或本地仍明确使用被替代的旧 API。
- **需手工移植**：即使功能缺失，也不能直接整体覆盖，因为相同文件已承载 Magenta 自有改动。

### 5.2 已有或部分已有

| Upstream 能力 | 当前状态 | 本地证据与边界 |
|---|---|---|
| Sonnet 5 / GPT-5.6 catalog | 已有或后续独立刷新 | [`anthropic.models.ts`](../../pi/ai/src/providers/anthropic.models.ts)、[`generate-models.ts`](../../pi/ai/scripts/generate-models.ts) 已含 Sonnet 5/GPT-5.6；本地 commit history 有独立 catalog refresh。不能据此认定 `0.80.3/0.80.4` 的所有 provider 修复已吸收。 |
| `max` thinking 公共类型与 theme | 已有 | [`pi/ai/src/types.ts`](../../pi/ai/src/types.ts)、[`pi/agent/src/types.ts`](../../pi/agent/src/types.ts) 已含 `max`；dark/light theme 和 theme schema 已含 `thinkingMax`。 |
| post-compaction stale usage 防护 | 已有，属于本地独立实现/加固 | [`agent-session.ts`](../../pi/coding-agent/src/core/agent-session.ts) 明确检查 compaction boundary 后的 assistant usage。仍应与 upstream `0.80.6` 测试语义对照。 |
| `session_info_changed` | 已有 | [`agent-session.ts`](../../pi/coding-agent/src/core/agent-session.ts) 已定义并 emit；interactive mode 与 regression tests 也消费该事件。 |
| 动态 extension tool registration | 部分已有 | 本地有 `dynamic-tools.ts` 示例和 `agent-session-dynamic-tools` 测试；但没有 upstream `0.80.7` 的 `ToolResultMessage.addedToolNames`/message-anchored protocol，因此不等于 cache-friendly deferred loading。 |
| pi-ai `Models.refresh/refreshModels` 底层能力 | 部分已有 | [`models.ts`](../../pi/ai/src/models.ts) 有 dynamic provider refresh；coding-agent 仍没有 `ModelRuntime`、`models-store.json`、`pi update --models` 集成。 |
| Grok 4.5 catalog | 部分已有 | 本地 [`xai.models.ts`](../../pi/ai/src/providers/xai.models.ts) 有 `grok-4.5`，但旧 Grok 3/4.20/Code Fast IDs 仍存在，且无 xAI device OAuth。 |
| undici 版本结果 | 已有 | 本地 coding-agent dependency 已为 `undici 8.5.0`，与 upstream `0.80.3-0.80.10` 一致；这只核验版本，不声称对应 CVE 状态。 |
| prompt-cache telemetry | 部分已有且本地更深分叉 | 本地有自有 telemetry/diagnostics 加固，但没有 upstream `showCacheMissNotices` setting；迁移应比较语义而非按文件覆盖。 |

### 5.3 明确缺失或仍在旧接口

| Upstream 能力 | 当前静态结论 | 直接证据 |
|---|---|---|
| `Usage.reasoning` token 子集 | 缺失 | 本地 [`Usage`](../../pi/ai/src/types.ts) 没有 `reasoning?: number`。 |
| RPC `get_entries` / `get_tree` 与 `./rpc-entry` export | 缺失或未暴露 | 本地 `SessionManager.getEntries/getTree` 是内部 API，但 RPC mode 无对应 snake_case command；coding-agent package exports 也无 `./rpc-entry`。 |
| `outputPad` / configurable `externalEditor` settings | 缺失 | 本地无 `outputPad` setting；`externalEditor` 仅是 keybinding/action 名称，没有 upstream 的 settings override。 |
| `agent_settled`、`before_provider_headers`、`InlineExtension`、custom entry renderer | 缺失 | extension core/types 中无这些 upstream 标识；本地 events overlay 的 `renderEntry` 是另一套 UI，不等同 extension entry renderer。 |
| request-wide input pricing tiers | 缺失 | 本地 model/cost types 无 upstream pricing tier 字段。 |
| `sessionAffinityFormat` | 明确缺失，仍用旧接口 | [`openai-responses.ts`](../../pi/ai/src/api/openai-responses.ts) 与 [`types.ts`](../../pi/ai/src/types.ts) 仍使用 `sendSessionIdHeader`；[`model-registry.ts`](../../pi/coding-agent/src/core/model-registry.ts) schema 也仍接受该字段。 |
| Anthropic tool schema 根级约束保真 | upstream `v0.80.10` 仍未修复，Magenta 同样受影响 | [`v0.80.10 convertTools()`](https://github.com/earendil-works/pi/blob/v0.80.10/packages/ai/src/api/anthropic-messages.ts#L1260-L1284) 仍把 `tool.parameters` 重建为仅含 `type`、`properties`、`required` 的对象；本地 [`anthropic-messages.ts`](../../pi/ai/src/api/anthropic-messages.ts) 也沿用该逻辑。升级到 `v0.80.10` 本身不能解决根级 `anyOf`、`additionalProperties` 等约束丢失。 |
| cache-friendly message-anchored dynamic tools | 缺失 | 本地无 `addedToolNames`/deferred tool serialization marker。 |
| coding-agent `ModelRuntime` 与 async SDK migration | 明确缺失 | 本地仍以 [`model-registry.ts`](../../pi/coding-agent/src/core/model-registry.ts) 和自有 external-auth loader 为中心，无 `model-runtime.ts`。 |
| provider-owned login / `models-store.json` / `pi update --models` | 缺失 | 无对应 runtime/storage/CLI 标识；现有 `--models` 是 model cycling 参数，不是 update flag。 |
| xAI device-code OAuth | 缺失 | 有 Grok catalog，无 xAI device auth flow。 |
| Kimi K3 与 Kimi deferred tools | 缺失 | 有旧 Kimi provider/K2.x catalog，但无 `kimi-k3` model/protocol。 |
| xAI catalog removal/regeneration guard | 缺失 | 本地仍含 `grok-3`、`grok-3-fast`、Grok 4.20 variants、`grok-code-fast-1`。 |

### 5.4 为什么必须手工移植

下列 upstream 热点也是 Magenta 的核心分叉点，直接 merge/覆盖风险高：

- `coding-agent/src/core/agent-session.ts`：Magenta 加入 peer messaging、sub-agent/teammate、background-shell、prompt withdrawal 等行为；upstream 同期修改 compaction、dynamic tools、model runtime、events。
- `coding-agent/src/core/extensions/*`：Magenta HCP 与 extension runner 已扩展，upstream 增加 lifecycle/header/provider refresh。
- `coding-agent/src/core/model-registry.ts`、`external-auth-loader.ts`、SDK/main：本地 external auth 与 upstream `ModelRuntime` ownership 冲突。
- `ai/src/types.ts` 与 provider serializers：本地已有 GPT-5.6/prompt-cache/diagnostics 演进，upstream 增加 usage、pricing、affinity、deferred tools、Kimi。
- `interactive-mode.ts`、RPC mode、session manager：本地协作/UI 行为与 upstream copy/RPC/model refresh 改动重叠。

### 5.5 建议移植顺序

1. **先建 upstream patch inventory，不先 bump package version。** 以 `v0.80.2..v0.80.10` 按 `ai → agent → coding-agent → tui` 分组，每个 upstream commit 标记 `present / superseded / missing / conflict`。
2. **先移植低耦合 correctness fixes。** `Usage.reasoning`、Anthropic empty-signature preservation、provider retry/overflow、Azure reasoning terminal event、Anthropic proxy missing usage、OpenRouter context 等可逐项带测试移植。
3. **单独完成 `0.80.7` protocol migration。** 同时迁移 `sessionAffinityFormat` schema/serializer/tests；再迁移 `addedToolNames` 与 provider deferred serialization。不要只改 coding-agent extension registry。
4. **将 `0.80.8` 作为架构项目。** 先决定 Magenta external-auth/HCP 与 provider-owned `CredentialStore`、`ModelRuntime` 的 owner boundary；形成 adapter 后再迁移 SDK/login/model refresh。直接替换 `model-registry.ts` 会破坏本地 auth 与 harness 集成。
5. **最后接入 `0.80.9-0.80.10` provider catalog。** Kimi K3 依赖前述 deferred tool 和 adaptive thinking contract；xAI catalog 删除依赖新 OAuth/default model 行为。先迁 catalog 会产生半兼容状态。
6. **版本号只在行为矩阵通过后更新。** 至少覆盖 Node/Bun、interactive/print/RPC、session resume/compaction、extension tool refresh、OpenAI Responses/Anthropic/Kimi/xAI、ambient auth 与 stored credential。

### 5.6 建议的最小验证矩阵

- Types/API：SDK compile fixture 覆盖 `ModelRuntime`、`CredentialStore`、async `refresh()`、`sessionAffinityFormat`。
- Provider payload：Anthropic empty/valid signature、OpenAI/OpenRouter/OpenCode affinity、Azure terminal encrypted reasoning、Kimi adaptive/deferred tools。
- Tool/cache：同一 agent run 中 tool 激活位置、cache prefix、required/named `toolChoice`。
- Auth：API key、ambient Bedrock/Cloudflare、OAuth refresh、xAI device flow、Bun binary bundled flows。
- Session/runtime：compaction stale usage、unsaved clone、branch summary ambient auth、RPC `get_entries/get_tree`。
- Magenta-specific：peer mailbox、managed teammate、sub-agent renderer、background-shell auto-promote、prompt withdrawal 与 HCP extension lifecycle。

## 6. 来源

### 6.1 一手发布与元数据

- [GitHub Releases](https://github.com/earendil-works/pi/releases)
- [GitHub Tags](https://github.com/earendil-works/pi/tags)
- [`v0.80.3` Release](https://github.com/earendil-works/pi/releases/tag/v0.80.3)
- [`v0.80.5` Release](https://github.com/earendil-works/pi/releases/tag/v0.80.5)
- [`v0.80.6` Release](https://github.com/earendil-works/pi/releases/tag/v0.80.6)
- [`v0.80.7` Release](https://github.com/earendil-works/pi/releases/tag/v0.80.7)
- [`v0.80.8` Release](https://github.com/earendil-works/pi/releases/tag/v0.80.8)
- [`v0.80.9` Release](https://github.com/earendil-works/pi/releases/tag/v0.80.9)
- [`v0.80.10` Release](https://github.com/earendil-works/pi/releases/tag/v0.80.10)
- [npm latest metadata](https://registry.npmjs.org/@earendil-works/pi-coding-agent/latest)

### 6.2 相邻版本 compare

- [`v0.80.2...v0.80.3`](https://github.com/earendil-works/pi/compare/v0.80.2...v0.80.3)
- [`v0.80.3...v0.80.4`](https://github.com/earendil-works/pi/compare/v0.80.3...v0.80.4)
- [`v0.80.4...v0.80.5`](https://github.com/earendil-works/pi/compare/v0.80.4...v0.80.5)
- [`v0.80.5...v0.80.6`](https://github.com/earendil-works/pi/compare/v0.80.5...v0.80.6)
- [`v0.80.6...v0.80.7`](https://github.com/earendil-works/pi/compare/v0.80.6...v0.80.7)
- [`v0.80.7...v0.80.8`](https://github.com/earendil-works/pi/compare/v0.80.7...v0.80.8)
- [`v0.80.8...v0.80.9`](https://github.com/earendil-works/pi/compare/v0.80.8...v0.80.9)
- [`v0.80.9...v0.80.10`](https://github.com/earendil-works/pi/compare/v0.80.9...v0.80.10)

### 6.3 Tag 固化 CHANGELOG

每版的综合说明以 `packages/coding-agent/CHANGELOG.md` 为主，并用 `packages/ai/CHANGELOG.md`、`packages/agent/CHANGELOG.md`、`packages/tui/CHANGELOG.md` 补齐底层 workspace 语义：

- [`v0.80.3`](https://github.com/earendil-works/pi/blob/v0.80.3/packages/coding-agent/CHANGELOG.md)
- [`v0.80.4`](https://github.com/earendil-works/pi/blob/v0.80.4/packages/coding-agent/CHANGELOG.md)
- [`v0.80.5`](https://github.com/earendil-works/pi/blob/v0.80.5/packages/coding-agent/CHANGELOG.md)
- [`v0.80.6`](https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/CHANGELOG.md)
- [`v0.80.7`](https://github.com/earendil-works/pi/blob/v0.80.7/packages/coding-agent/CHANGELOG.md)
- [`v0.80.8`](https://github.com/earendil-works/pi/blob/v0.80.8/packages/coding-agent/CHANGELOG.md)
- [`v0.80.9`](https://github.com/earendil-works/pi/blob/v0.80.9/packages/coding-agent/CHANGELOG.md)
- [`v0.80.10`](https://github.com/earendil-works/pi/blob/v0.80.10/packages/coding-agent/CHANGELOG.md)

## 7. 未决问题

1. `v0.80.4` 没有 GitHub Release，原因未在 tag/CHANGELOG 中说明；不能推断为发布失败或撤回。其正式更新只能以 tag CHANGELOG 与 compare 为准。
2. `v0.80.5` 官方说明为空，diff 表明是版本重发加一个测试 fixture 修复；为何需要重发没有一手说明。
3. 当前 Magenta worktree 有未提交改动，本地差异结论是调研时快照。正式移植前应在确定的 commit/tag 上重新生成 present/missing inventory。
4. 本报告没有运行外部 provider 的真实凭证测试，因此“本地已有”只代表静态实现证据，不代表线上 provider 已验证。
5. Upstream Release 中部分旧 PR/issue 链接仍指向历史 `pi-mono` 路径；本报告优先链接当前 `earendil-works/pi` 的 tag、commit、compare 和 Release，一手内容本身可能保留旧链接。
