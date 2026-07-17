# coding-agent CLI/TUI/RPC/settings/SDK 升级审计

## 1. 范围、基准与判定

- 上游起点 U2: `v0.80.2` / `0201806adfa825ab3d7957a4267d46e5030fd357` / 2026-06-23，路径 `packages/coding-agent`。
- 上游终点 U8: `v0.80.8` / `fae7176cb9f7c4725a40d9d481d8d70b80f18086` / 2026-07-16。
- 上游提交证据库: `/tmp/magenta-pi-upstream-v0.80.8-20260717`，其 HEAD 为 `216e672e7c9fc65682553394b74e483c0c9e47f7`；本文所有 SHA 均可在该库核验。
- 初始导入快照: `/tmp/magenta-import-f1da4c/pi/coding-agent`，`package.json` 仍标记 `0.80.2`。目录本身不是 Git 仓库，`f1da4c` 是快照命名/来源标识，不把它误报成该目录可验证的 HEAD。
- Magenta 当前基准: `/Users/mjm/Magenta3` @ `4a08f6305ed3fa88067d7dbd9a19ced606dcef0f`，实际路径 `pi/coding-agent`；依赖 `pi-ai/pi-agent-core/pi-tui` 仍标记 `0.80.2`，并已大幅引入 HCP、ExecutionProfile、后台事件、工具 renderer registry 等 Magenta 专有结构。
- 上游区间共 107 个非 merge、触及 `packages/coding-agent` 的提交；其中 70 个直接触及 `src/cli/**`、`src/modes/**`、`src/rpc-entry.ts`、docs/examples/tests。附录列出全部 107 个，避免仅凭 changelog 漏项。
- 状态定义: `PRESENT` 等价行为已存在；`PARTIAL` 仅部分覆盖；`SUPERSEDED` 已由 Magenta 更高层设计替代且无需照搬；`MISSING` 不存在；`CONFLICT` 与 Magenta 架构/契约冲突，必须重设计；`N/A` 为 release/changelog/lockfile 或纯其他 package 行为。

## 2. 结论摘要

优先级最高的是三个协议/生命周期缺口：RPC `get_entries/get_tree` 与 `./rpc-entry`、`agent_settled`、以及 ModelRuntime/动态目录刷新。前两个可在保留 Magenta runtime host 的前提下局部实现；ModelRuntime 是跨 `pi-ai`、auth、SDK 和 HCP 的 breaking migration，不能把上游文件直接覆盖到当前树。

用户可见的低耦合改进中，`outputPad`、`externalEditor` setting、Ctrl+X、Ctrl+V text fallback、thinking block coalescing、`shellPath` 展开都适合先移植。需要特别保护 Magenta 的异步 clipboard-image 队列、字符动画、Ultra ExecutionProfile、自动 light/dark theme、组合式 project resource UI 与 tool renderer registry。

当前 `max` thinking 基本可用，但主题 schema 比上游更严格：Magenta 把 `thinkingMax` 设为必填，上游允许旧主题缺省并回退到 `thinkingXhigh`。当前 prompt 仍由 HCP 明确注入日期，和上游为缓存稳定性移除日期的决定直接冲突。

## 3. 逐项行为审计

### CU-001 `outputPad` 全 transcript 输出间距

- **版本/官方说明/SHA**: v0.80.3；“`outputPad` controls horizontal padding for user messages, assistant messages, and thinking blocks”；`6564d9471702727141e20b305d17679e06373e57`、补全 user message 的 `9be55bc773bc1dffad307dd7cd130d949b336a0b`。
- **上游文件/符号/行为**: `src/core/settings-manager.ts` (`Settings`, `getOutputPad`, `setOutputPad`)，`components/settings-selector.ts` (`output-padding`)，`assistant-message.ts` (`outputPad`, `setOutputPadding`)，`user-message.ts` (`outputPad`, `setOutputPadding`)，`interactive-mode.ts` 负责构造与实时更新；测试 `assistant-message.test.ts`、`settings-manager.test.ts`。
- **Magenta 证据**: `assistant-message.ts:240,259` 和 `user-message.ts:16` 仍硬编码 padding `1`；settings、docs、tests 对 `outputPad` 零命中。当前字符动画会复用 `Markdown` 实例，移植时不能退回上游无动画的简单 rebuild。
- **状态**: **MISSING**。
- **移植动作/依赖**: 在现有 SettingsManager 增加全局 setting 和 0/1 归一化；给两 message component 增加可变 padding；`InteractiveMode` 在恢复、reload、settings callback 和新建 component 四条路径传值。不要影响 input 的 `editorPaddingX`。
- **测试**: settings default/merge/persist；assistant text/thinking/error/usage 与 user box 的 0/1 render；streaming animation 中切换设置不丢文字；session resume/reload 后保持值。

### CU-002 `externalEditor` setting 与跨平台 fallback

- **版本/官方说明/SHA**: v0.80.3；setting 优先于 `$VISUAL/$EDITOR`，无配置时 Windows Notepad、其他平台 `nano`；`5a073885b5f23cd6125cda0927cf50acf2bf22fb`。v0.80.6 的 `1a2542b11be9d9c6bb8bcce534bcf8561bc4542e` 同时要求 `shellPath` 的 `~` 展开，见 CU-016。
- **上游文件/符号**: `SettingsManager.getExternalEditor()`；`InteractiveMode.openExternalEditor()`；`ExtensionEditor.openExternalEditor()`；README/settings/keybindings/usage docs。
- **Magenta 证据**: 主编辑器 `interactive-mode.ts:4389-4393` 只读 `$VISUAL/$EDITOR` 且无默认值；extension editor `components/extension-editor.ts:79,114` 同样如此；`docs/keybindings.md:89` 和 `docs/usage.md:28` 只承诺环境变量。`externalEditor` 仅作为旧 keybinding alias 出现，不是 setting。
- **状态**: **PARTIAL**（Ctrl+G 与环境变量已有，新增设置和默认 fallback 缺失）。
- **移植动作/依赖**: SettingsManager 统一解析命令，主编辑器和 extension editor 都注入同一结果；保留 Magenta 在 `openExternalEditor()` 对 stdin/raw mode 的额外修复；command parsing 继续使用现有 cross-spawn/shell 规则。
- **测试**: precedence、空字符串、Windows/Unix 默认、含参数命令、临时文件回填、extension `ctx.ui.editor()` 同步行为。

### CU-003 RPC `get_entries` / `get_tree`

- **版本/官方说明/SHA**: v0.80.3；“RPC clients can inspect session entries and tree snapshots”；`7ba1b6bfeff9aa72dbdbc4d386103e06b2f53803`。
- **上游文件/符号/行为**: `rpc-types.ts` 增加两个 command/response union；`RpcMode.handleCommand` 支持 `since` 且找不到 entry 返回错误；`RpcClient.getEntries/getTree`；`docs/rpc.md#get_entries/#get_tree`；`test/rpc.test.ts`。
- **Magenta 证据**: 当前 RPC union 到 `get_state` 后无这两个 command (`src/modes/rpc/rpc-types.ts:20-75`)；switch 无对应 case。底层已具备 `SessionManager.getEntries()` (`session-manager.ts:1258`)、`getTree()` (`:1267`)、`getLeafId()` (`:1160`) 和导出的 `SessionEntry/SessionTreeNode`，因此 core 数据接口不是阻塞项。
- **状态**: **MISSING**（协议层缺失，core prerequisite PRESENT）。
- **移植动作/依赖**: 在 Magenta 扩展后的 RPC unions/switch/client 中增量加入，不能覆盖 background event、ExecutionProfile、manifest、prompt preflight 协议；明确 defensive-copy/JSON 序列化边界。
- **测试**: 空 session、完整 entries、`since` 成功切片、未知 `since` 错误、branch tree/leafId、RPC id correlation、现有 headless manifest 顺序不变。

### CU-004 package `./rpc-entry`

- **版本/官方说明/SHA**: v0.80.3；`122527b22a957056b26645014f2f205394b2ca11`。
- **上游文件/符号**: 新建 `src/rpc-entry.ts`，package exports `./rpc-entry`；目标是直接启动 RPC，且可用于 Bun bundle。
- **Magenta 证据**: 当前 `package.json` 仅导出 `.`，`src/rpc-entry.ts` 不存在；`runRpcMode` 仅从 `src/index.ts:346` 导出。Magenta 的 runtime 创建需要 HCP services/runtime host，不能照搬旧的单 session entrypoint。
- **状态**: **MISSING**。
- **移植动作/依赖**: 新 entry 必须复用 `createAgentSessionServices` + `createAgentSessionRuntime` + `runRpcMode`，并加载 Magenta brand/HCP assets；增加 package export、build include 和 Bun release smoke test。
- **测试**: Node import subpath、Bun compiled binary、stdout 纯 JSONL、SIGTERM cleanup、无 TTY 启动与一轮 `get_state`。

### CU-005 fully-settled lifecycle: `agent_settled`

- **版本/官方说明/SHA**: v0.80.4；`e9fa5a68a1967f42a90a1c07f512bc8af63517a9`；官方定义是低层 `agent_end` 后，自动 retry、compaction retry、queued continuation 均已耗尽才触发。
- **上游文件/符号**: `AgentSessionEvent`、extension `AgentSettledEvent`/handler、`AgentSession._emitAgentSettled()`，Interactive/Print/RPC，`RpcClient.waitForIdle/collectEvents` 改以 settled 为 barrier；回归测试 `6363-agent-settled-event.test.ts`。
- **Magenta 证据**: `agent-session.ts` 仅有扩展过的 `agent_end` + `willRetry` (`:174-178,970-978`)；RPC shutdown 与 `waitForIdle/collectEvents` 仍在 `agent_end` 结束 (`rpc-mode.ts:360`, `rpc-client.ts:530-558`)；仓库对 `agent_settled` 零命中。Magenta 另有 background events、external activation、peer wakeup，settled 的含义比上游更宽。
- **状态**: **MISSING**。补充风险：settled 的精确定义与 Magenta background/external-activation 语义存在架构冲突，实施前必须先定契约。
- **移植动作/依赖**: 先定义 Magenta settled contract：至少 agent idle、auto retry/compaction/queued prompt 都清空；明确 background jobs/peer mailbox 是否阻止 settled（建议不阻止，但 terminal receipt auto-return continuation 要阻止）。统一在 AgentSession 单点发事件，RPC helper 改用它。
- **测试**: 普通 run 一次；retry 多轮只最终一次；overflow compact+retry；agent_end extension enqueue follow-up；abort；外部 activation race；RPC promptAndWait/shutdown；事件不得重复。

### CU-006 prompt cache miss notices

- **版本/官方说明/SHA**: v0.80.4；`3f9aa5d10b35223abf6146f960ff5cb5c68053ee`；`showCacheMissNotices` 可显示“significant prompt-cache misses”。
- **上游文件/符号**: 新 `core/cache-stats.ts` 的 miss 判定/格式化；SettingsManager getter/setter；settings UI；InteractiveMode transcript notice；footer/session stats 与 tests。
- **Magenta 证据**: 没有 `showCacheMissNotices`、`cache-stats.ts` 或 transcript notice。当前有更丰富的 `core/cache-telemetry.ts`（例如 `cacheMissedInputTokens` `:126,470-477`、`eligibleMiss` `:795`），footer (`components/footer.ts:38-52`) 和 events overlay (`events-overlay.ts:49-62`) 已显示 cache 统计。
- **状态**: **PARTIAL**（观测能力更强，官方用户开关/显式 transcript notice 缺失）。
- **移植动作/依赖**: 不引入第二套 cache estimator；在现有 telemetry record 上实现“significant miss”投影和去重，再加 setting/UI。决定 transcript notice 是否持久化；建议 display-only，避免污染上下文和 session tree。
- **测试**: eligible/ineligible、阈值边界、cache unsupported、连续 miss 去重、setting off、streaming/tool loop、footer/events overlay 不回归。

### CU-007 project-local resource configuration

- **版本/官方说明/SHA**: v0.80.4；`c8ada4e76e123e8f292e4b057f443f874554b5ac`；`pi config -l`，Tab 切 global/project，project 三态 inherit/load/unload。
- **上游文件/符号**: `ScopedResolvedPaths`、`ConfigWriteScope`、`ProjectOverrideState`、`ConfigSelectorHeader.setWriteScope`、`ResourceList.onSwitchMode/setProjectResourceOverride`；CLI/help/package manager/settings tests。
- **Magenta 证据**: 当前 config selector 已同时构造并直接修改 user/project 项 (`config-selector.ts:53,458-570`)；packages docs 明确双 scope (`docs/packages.md:47,224-228`)；但 header 只有 space/esc，`handleInput` 无 Tab，且没有 inherit/load/unload 状态。`package-manager-cli.ts:492` 的 `-l` 只用于 install/remove，不用于 config startup mode。
- **状态**: **PARTIAL**，不是 PRESENT。
- **移植动作/依赖**: 保留 Magenta project trust；把当前“同屏两 scope”迁到上游显式 writeScope，或若保留同屏，仍必须实现 inherited global 的 project override 三态和 `config -l`。不要绕过 `--approve/--no-approve`。
- **测试**: global toggle；project inherited dimming；三态循环；absolute/local source canonicalization；same package 两 scope；untrusted project；`config -l`；Tab；settings merge-on-write。

### CU-008 Ctrl+X copy last/selected message

- **版本/官方说明/SHA**: v0.80.7；`3b686ac224db0eb24cadb6fd0149db94c6aa1854`。
- **上游文件/符号**: keybinding `app.message.copy`; InteractiveMode 调 `handleCopyCommand`; `TreeList.copySelected/getEntryCopyText`; docs/tests。复制 tree 中完整文本，不是 200 字 preview。
- **Magenta 证据**: 全局 `app.message.copy` 不存在；Ctrl+X 当前仅在 scoped model selector 绑定 `app.models.clearAll` (`core/keybindings.ts:163`、`docs/keybindings.md:149`)；`/copy` 和 `copyToClipboard` 已存在 (`interactive-mode.ts:8233`)。不同 UI context 可复用 Ctrl+X，但必须验证 focus routing。
- **状态**: **MISSING**。
- **移植动作/依赖**: 新 app binding 复用现有 `/copy` handler；给 Magenta 已扩展 tree selector 加 callback，支持 custom message/compaction/branch/bash/error。保持 model selector 的 Ctrl+X context-local 行为。
- **测试**: transcript、tree long text、非文本 entry、clipboard error、model selector Ctrl+X 不触发 message copy、custom keybindings migration。

### CU-009 Ctrl+V image-first、text fallback

- **版本/官方说明/SHA**: v0.80.7；`d7a48d30a031f9c26eb304ead89a0dd1fb424b8f`；无图片时读 native clipboard text 并插入 editor。
- **上游文件/符号**: `readClipboardText()`、native module `getText`、`InteractiveMode.handleClipboardPaste`、custom editor/docs/tests。
- **Magenta 证据**: `utils/clipboard.ts` 只导出 copy；`clipboard-native.ts` 类型无 `getText`；`interactive-mode.ts:2831` 使用 Magenta 专有 `clipboardImagePasteQueue`，只处理图片；help 仍写 “Paste image from clipboard” (`:8423`)。
- **状态**: **MISSING**。
- **移植动作/依赖**: 在现有队列任务中按 image -> text 顺序串行化，不能用上游简单 handler 覆盖 pending-image markers/async ordering；extension/custom editor 是否支持 text fallback需一致决定。
- **测试**: image、text、空 clipboard、permission error、连续 Ctrl+V 顺序、输入期间异步返回不覆盖 cursor、custom editor、Bun native module。

### CU-010 从默认 prompt 移除 current date

- **版本/官方说明/SHA**: v0.80.7；`f4e9ca7466b5576090d1093c27fe38d73909f3d2`；官方理由是避免跨日期破坏 prompt cache。
- **上游文件/符号**: `core/system-prompt.ts` 删除两处 `Current date`，不再取 `new Date()`。
- **Magenta 证据**: coding-agent 已变为 HCP facade (`src/core/system-prompt.ts`)；真实实现 `HarnessComponentProtocol/system-prompt/pi/system-prompt.ts:65,137,192-197` 仍注入本地日期；HCP tests `system-prompt.test.ts:105,130` 明确要求日期及位置。
- **状态**: **CONFLICT**。
- **移植动作/依赖**: 产品决定必须先行。若采纳上游缓存目标，应改 HCP capability 与 tests，而不是 coding-agent facade；需要日期的工具/agent可通过 time tool 或 append prompt 提供。若 Magenta 明确要求实时日期，则记录为有意 divergence，并不移植。
- **测试**: frozen-time snapshot、跨午夜 prompt equality、custom system prompt/append prompt、project context ordering、cache telemetry prefix fingerprint。

### CU-011 ModelRuntime / auth / SDK breaking migration

- **版本/官方说明/SHA**: v0.80.7-v0.80.8；主提交 `9993c96907bb0c97260d2c353c31a3464f211122`。官方 breaking changes: SDK `authStorage/modelRegistry` 改 async `modelRuntime`；auth storage backends 不再导出；request auth 统一由 runtime 组装；extension-facing registry `refresh()` 变 Promise。
- **上游文件/符号**: `core/model-runtime.ts`, `provider-composer.ts`, `runtime-credentials.ts`, `models-store.ts`, `remote-catalog-provider.ts`；CLI list/login/model selector/footer；RPC/SDK/index；大量 auth/model tests 与 docs/examples。
- **Magenta 证据**: 当前仍是同步 `ModelRegistry.refresh()` (`model-selector.ts:142`) 和 `session.modelRegistry.getAvailable()` (`rpc-mode.ts` model cases)；SDK docs 仍教 `ModelRegistry.create` (`docs/sdk.md:434-449`)；package dependencies 全为 `0.80.2`。Magenta 另有 external auth loader、HCP session services 和 provider-specific改造。
- **状态**: **CONFLICT**（不是可单 package cherry-pick 的 MISSING）。
- **移植动作/依赖**: 等 `pi-ai` v0.80.8 provider/credential APIs 可用后，设计 HCP-friendly `ModelRuntime` adapter；先列出 Magenta external auth/Cloudflare/Codex/Ultra callers，再迁 SDK。保留兼容 facade 的期限和 deprecation test；不要一次删除当前 AuthStorage export。
- **测试**: upstream model-runtime auth-options/cloudflare/modifyModels/radius/remote-catalog suites；Magenta external auth、HCP session factory、RPC、CLI first-time `--api-key`、SDK examples、binary OAuth。

### CU-012 live model catalog refresh 与 `update --models`

- **版本/官方说明/SHA**: v0.80.8；picker refresh `fab309e955b28cfc7ab63ae25c3bfdd8b54b9e44`，extension dynamic provider refresh `bd9e09db441f4c4dcad2f8a8446c8818303c7134`，CLI flag `97f9978fa66685f78d2da19ae22e20c46d125f74`。
- **上游文件/符号/行为**: `/model` 立即显示 snapshot，后台 refresh、partial status/timeout；`ModelRuntime.refresh()`；provider `refreshModels(context)`；`pi update --models`；四小时 throttle、pi.dev overlay/store。
- **Magenta 证据**: picker 仅同步重读 `models.json` (`model-selector.ts:142`)；`refreshModels`、remote catalog、`update --models` 均无命中；package-manager CLI 没有该 flag。当前 UI 有自动 light/dark theme 和 overlay体系，selector更新需走现有 TUI invalidate。
- **状态**: **MISSING**，依赖 CU-011。
- **移植动作/依赖**: 先完成 runtime/provider store；picker 必须可取消、超时并在关闭后不更新已卸载 component；package CLI flag与现有 GitHub self-update flags解冲突。
- **测试**: immediate first paint、partial results、timeout/error、close race、scoped model order、throttle/persist、offline、`update --models` option conflicts、动态 extension server。

### CU-013 `max` thinking 与 `thinkingMax` theme

- **版本/官方说明/SHA**: v0.80.6；`fbdd46389c3a0c03b62f5e9eabe31a85044ef8ce`。CLI/SDK/RPC/model selection均支持 `max`；旧主题缺少 `thinkingMax` 时回退 `thinkingXhigh`。
- **上游文件/符号**: args/settings/model registry；thinking/settings selectors；theme json/schema/`withThemeColorFallbacks`; docs/examples；`test/max-thinking.test.ts`。
- **Magenta 证据**: 独立提交 `c97d255` 已覆盖 AI metadata 与 coding-agent；`model-registry.ts:368,395`、`args.test.ts:168-169`、docs RPC/settings均支持 max；Magenta另有 `ultra` ExecutionProfile。主题却把 `thinkingMax` 设为必填 (`theme.ts:94`)，没有上游 optional fallback；built-in颜色存在。
- **状态**: **PARTIAL**。
- **移植动作/依赖**: 保留 Ultra -> native max resolution；只移植主题兼容 fallback/schema/docs/test，不覆盖 ExecutionProfile selector；核对 RPC response 当前 `cycle_thinking_level` data 类型把 `level` 声明为 `ExecutionProfile` 的 Magenta差异。
- **测试**: 旧 custom theme 无 thinkingMax、显式 thinkingMax、light/dark auto theme、max/ultra边框、CLI/RPC/model capability clamp。

### CU-014 相邻 thinking blocks 合并

- **版本/官方说明/SHA**: v0.80.8；`45203abfa0ed6057bdb91e476fdc2730ff24370e`；相邻 thinking block 只渲染一个 section/hidden label。
- **上游文件/符号**: `AssistantMessageComponent` 扫描连续 run、`thinkingBlocks.join("\n\n")`；assistant tests。
- **Magenta 证据**: `assistant-message.ts:246-270` 仍逐 block 建 Markdown/hidden label；此外组件有 `normalizeThinkingTags` 和字符动画，这是上游没有的。
- **状态**: **MISSING**。
- **移植动作/依赖**: 在 `normalizedContent` -> target/displayed block 映射阶段先构造 logical runs，不能只复制上游 render loop，否则 `targetTexts/displayedTexts/displayedBlocks` 索引失配。
- **测试**: adjacent+empty thinking、hidden label一次、thinking/text/thinking分段、streaming追加相邻 block、literal `<thinking>` normalization、animation finish/invalidate。

### CU-015 login/auth UI 与 provider 参数

- **版本/官方说明/SHA**: v0.80.4 `312bc713bb469bcc4f727be7846bc6f0eaf113c4` (`/login <provider>` autocomplete/args)；v0.80.7 `3ea064ea2a0f01965923ce32e1bd17466c502b23` (Bedrock API key)、`adfac437bbe3cd43182624a0f57ad0b244b75be8` (文案)；v0.80.8 `5220aba61970fc9f284a7c71e95669b52b4f47a8` (xAI device OAuth) 与 `6442536b` (Bun OAuth bundle)。
- **上游文件/符号**: InteractiveMode slash parsing/status；OAuth/login dialogs/selectors；providers docs；Bun CLI imports；auth persistence error `f8bec25f...`。
- **Magenta 证据**: `/login` 当前只触发 menu (`interactive-mode.ts:3038,7559`)，无 provider arg parsing；Bedrock/xAI依赖当前 0.80.2 AI/auth栈。API key save error已有显式 UI (`interactive-mode.ts:7749`)，因此该子项 PRESENT。
- **状态**: **PARTIAL**。
- **移植动作/依赖**: 先落 provider arg/autocomplete与文案；Bedrock/xAI等待 CU-011/AI provider能力；binary build显式验证 OAuth adapters被bundle。保留 Magenta的 unified login menu dock。
- **测试**: `/login`, `/login provider`, unknown provider, Bedrock ambient/API key, xAI device cancel/expiry, auth save failure, Bun standalone。

### CU-016 `shellPath` 的 `~` 展开

- **版本/官方说明/SHA**: v0.80.6；`1a2542b11be9d9c6bb8bcce534bcf8561bc4542e`。
- **上游文件/符号**: `SettingsManager.getShellPath()` 用 config-value/path resolver 展开；docs/settings test。
- **Magenta 证据**: 当前 `settings-manager.ts:875-876` 原样返回 `this.settings.shellPath`。
- **状态**: **MISSING**。
- **移植动作/依赖**: 复用当前 path helper，不手写字符串 replace；只展开开头 `~`/`~/`，Windows separators需测。HCP bash wrapper通过 `createLocalBashOperations({shellPath})` 消费该值。
- **测试**: `~`, `~/bin/bash`, 非前缀 tilde、Windows、undefined、project override。

### CU-017 bash timeout 输入验证

- **版本/官方说明/SHA**: v0.80.4；非正数 `85b7c24741096f147747689e21c4bc6892061824`，超过 Node timer 上限 `cbcf4e04c3f2e5822d9349fae9b7ba13a39bdefc`；应报清晰 validation error，不能被当成即时 timeout/无 timeout。
- **上游文件/符号**: `core/tools/bash.ts` 的 `MAX_TIMEOUT_MS=2_147_483_647`、`normalizeTimeoutSeconds`。
- **Magenta 证据**: bash execute 已迁至 `HarnessComponentProtocol/tools/bash/pi/bash.ts`；schema仅 `Type.Number` (`:11-16`)，execute直接传值；coding wrapper `createLocalBashOperations` 只在 `timeout > 0` 时设置 timer，导致 0/负数静默变为无 timeout，超大值交给 `setTimeout`。
- **状态**: **MISSING**。
- **移植动作/依赖**: 在 HCP pure bash execute/schema单点验证，coding wrapper只负责host shell；同时验证 finite。不要破坏 Magenta现有自动后台提升/renderer。
- **测试**: 0、负数、NaN/Infinity（runtime输入）、边界最大秒数、超界、小数、正常 timeout、background promotion。

### CU-018 edit replacement 允许额外字段

- **版本/官方说明/SHA**: v0.80.4；`a1b336d73e13b53949ff629800081185d3e4694e`；模型多生成 replacement 字段时仍接受有效 old/new。
- **上游文件/符号**: edit replacement TypeBox object 从 strict 改宽容；execute只取 oldText/newText。
- **Magenta 证据**: edit pure tool位于 `HarnessComponentProtocol/tools/edit/pi/edit.ts`; `replaceEditSchema` 显式 `{ additionalProperties: false }` (`:18-27`)。当前 legacy normalization不能挽救schema层先拒绝的额外字段。
- **状态**: **CONFLICT**（当前 HCP严格schema是有意设计，但与上游鲁棒性目标相反）。
- **移植动作/依赖**: 产品/安全确认后仅放宽 `edits[]` item，顶层仍 strict；execute投影为 `{oldText,newText}`，避免额外字段流入日志/patch逻辑。coding-agent wrapper无需重复实现。
- **测试**: item额外字段接受；顶层额外字段仍拒绝；缺 old/new拒绝；多 edit原子性；renderer preview不受额外字段影响。

### CU-019 persisted custom entry renderer

- **版本/官方说明/SHA**: v0.80.4；`ba10b60b512fed0c511cc639733611f9ad8d12cf`；display-only `CustomEntry` 可由 extension renderer 在 interactive transcript渲染，但不进模型 context。
- **上游文件/符号**: `EntryRenderer` registry、`components/custom-entry.ts/CustomEntryComponent`、interactive replay/stream ordering、`examples/extensions/entry-renderer.ts`、session/docs/tests。
- **Magenta 证据**: 当前有 `registerMessageRenderer` 和 `CustomMessageComponent` (`interactive-mode.ts:3620`)，这是 context/display custom message；`CustomEntry` 类型/append API也存在，但没有 `CustomEntryComponent`，interactive transcript未查询 entry renderer。两种契约不能混同。
- **状态**: **MISSING**。
- **移植动作/依赖**: 在当前 extension/HCP loader保留独立 `entryRenderers`；session replay按 persisted entry顺序插入；streaming assistant期间追加 custom entry时放到 live assistant前。不要把 CustomEntry转成 AgentMessage。
- **测试**: renderer有/无内容、throw fallback、expanded/theme invalidate、stream append order、resume、模型 context排除、example typecheck。

### CU-020 TUI status indicators、输出顺序与 stop-reason UX

- **版本/官方说明/SHA**: v0.80.3；`5d499272a879398985ad9b1695866ab3d8685053` 统一 `StatusIndicator/IdleStatus` 防 clear-on-shrink 收缩；`c5440162b87b210b498857985765ba42279603a8` 资源通知先于恢复消息；`f14b3594c16de2679709e3b1c7ba06277872ec93` length stop显示 incomplete error；`f2e9d75388fe17325ebe31372e5287b4acdb67a3` 保留 backslash。
- **上游文件/符号**: 新 `components/status-indicator.ts`；InteractiveMode indicator replace/clear；Assistant/User message render/tests。
- **Magenta 证据**: 资源先显示已有代码/测试 (`interactive-mode.ts:885`, regression test `5943...:262`)；status仍为各类 Loader+`statusContainer.clear()` (`interactive-mode.ts:3520-3560`)且无 `status-indicator.ts`；assistant没有 `stopReason === "length"`；user renderer未见上游 escape-mode选项。
- **状态**: **PARTIAL**。
- **移植动作/依赖**: 只采纳稳定高度 abstraction 和 missing stop/escape行为；适配 Magenta background/reminder/peer indicators，不覆盖 central overlay、animated Ultra border。
- **测试**: clearOnShrink working/retry/compact/branch；length response；backslashes；resource-before-resume；background return时status高度。

### CU-021 session/CLI 安全与自动化修复

- **版本/官方说明/SHA**: v0.80.3；invalid session拒绝/短错误 `543710f643f5f413eeb40276f1231a71b83585ae`, `0d145e895c261d19c1f94549f64088c5ed7f0de4`; `--no-session --session-id` `e454f50b48d7ca0ac984bccc166c3bfe96f5ad58`; v0.80.4 warning `c4281a7dd1a36e39e34d0c7f4cda174700d6f4e9`。
- **上游文件/符号**: main/session manager validation；startup warning；session-file/custom-id tests。
- **Magenta 证据**: deterministic custom session id和validation已有大量 tests (`session-id-readonly.test.ts:133`, `custom-session-id.test.ts:68-188`)；但上游 `test/session-file-invalid.test.ts` 不存在，代码中没有 non-empty invalid session拒绝文案；warning覆盖不明确。
- **状态**: **PARTIAL**。
- **移植动作/依赖**: 先把上游 invalid-file tests移植到 Magenta SessionManager storage层；确保不会覆盖用户文件。再补 startup warning，兼容 teammate session id创建流程。
- **测试**: invalid JSONL、空文件、readonly commands无副作用、no-session id、existing/missing id warning、teammate CLI。

### CU-022 prompt/tool refresh 与 settled queue正确性

- **版本/官方说明/SHA**: v0.80.3 `fd6659dd5d32d67feaa7ce2ba5eeb87c5705149c`, `e547bb9f4180599629c45871c8311a51e1ec4f2f`; v0.80.4 message-anchored dynamic loading docs/test `3d8f74357c169d24f996a1611ecc4be72b7744bd`，custom-message compaction budget `a6f720e6caf1cf429e382011156c015fa204c512`。
- **上游行为**: extension在同一 run更新工具后，下次 provider request立即使用，保留 before-agent prompt；session state下一turn刷新；cache prefix保持。
- **Magenta 证据**: 当前工具注册/执行已转 HCP动态 capability，原 upstream regression files `6162...` 不存在；AgentSession又加入外部activation与background return，不能从文件名推定等价。
- **状态**: **CONFLICT**（目标仍适用，但实现路径已由 HCP capability 替换；是否已部分满足必须用改写后的回归测试证明）。
- **移植动作/依赖**: 把 upstream regression场景改写为 HCP capability reload测试；验证工具定义 anchor和prompt cache telemetry。依赖 CU-005 settled定义。
- **测试**: session_start动态工具、tool result激活工具、before_agent prompt保留、queued slash follow-up、single-concurrency compaction、cache anchor。

### CU-023 extension/SDK 新接口

- **版本/官方说明/SHA**: v0.80.4 `before_provider_headers` `244f1deaf1ae0fc1a242d9df5cddf457cf3d36a7`; `InlineExtension` `b3dff19a04d422ca4a7e0c1c2eccda36769614d9`; model resolution helpers `040f0a5197a4bf00ca3b55b44a424563cc5ae067`; session name event `726a9c526c8da1fcc3218dbc5e5cba02665dfbc9`。
- **Magenta 证据**: `before_provider_headers`、`InlineExtension`、`resolveModelScopeWithDiagnostics`均零命中；`resolveCliModel`内部存在但未从 `src/index.ts` export；`session_info_changed`只存在于internal `AgentSessionEvent`及其regression test (`agent-session.ts:194,3959-3961`)，extension event type/runner dispatch/export仍缺。
- **状态**: **PARTIAL**。
- **移植动作/依赖**: 保留internal session event并补extension-facing contract；公开纯model resolver helper风险低；InlineExtension需适配已重构的HCP extension retirement/loader；provider headers等待CU-011，避免与external auth header assembly双重执行。
- **测试**: public exports typecheck、named inline factory cache、header hook大小写/顺序、internal+extension session event各一次。

### CU-024 model overrides/default selection/刷新辅助修复

- **版本/官方说明/SHA**: v0.80.4 `c6251a866b1d7d7900c443e4cf615ec148dbe415` (modelOverrides用于extension provider), `ca09b2b1a8317f1daa5ed3f339ebcc00add84f67` (跳过未认证默认模型), `312bc713...` (login provider args)；v0.80.3 `774288587fc0acf383f610767256ec663af74dfe` (OpenAI default)。
- **Magenta 证据**: current model registry只在 `loadBuiltInModels` 应用 overrides (`model-registry.ts:487-509`)；extension provider覆盖缺失。Magenta已将GPT-5.6/max作为独立默认能力，不能照搬上游某个静态OpenAI default。
- **状态**: **PARTIAL**。其中静态 default ID 已由 Magenta 自有选择策略替代，无需照搬；缺口仍是 extension override/auth selection。
- **移植动作/依赖**: cherry-pick behavior tests而不是默认ID；CU-011完成后由 ModelRuntime composer统一实现override/auth selection。
- **测试**: extension provider override、unauth saved default+local model、fuzzy CLI resolution、Magenta当前默认不变化。

### CU-025 BMP disk images

- **版本/官方说明/SHA**: v0.80.3；`4cc339f58d10958040fcc948e340121de90cb3e5`；磁盘BMP检测、转PNG，经 `read` 和 CLI `@file` 附件发送。
- **上游文件/符号**: `cli/file-processor.ts`, `utils/mime/image-process`, read tool；block/image/tools tests。
- **Magenta 证据**: clipboard BMP已有专门测试，但磁盘 sniffer `src/utils/mime.ts:5-18` 仅支持 JPEG/PNG/GIF/WebP，不识别BMP；CLI/read都依赖该函数 (`file-processor.ts:48`, `tools/read.ts:24,44`)。
- **状态**: **MISSING**。
- **移植动作/依赖**: 在共享 mime/process层加入BMP signature与PNG conversion，确保 HCP read tool adapter也走同一处理；不要把 clipboard-only fix误当已覆盖。
- **测试**: disk BMP CLI/read、malformed BMP、blockImages、conversion failure、clipboard suite保持。

### CU-026 bash/edit 当前 Magenta UX 保护项

- **版本/官方说明/SHA**: 本项是移植约束；上游本区间实质行为是 CU-017/018，未提供Magenta现有的renderer能力。
- **Magenta 证据**: bash renderer已有折叠命令、隐藏输出计数、truncation/full path、动态 elapsed (`core/tools/bash.ts:147-258`)；edit由HCP负责multi-edit且coding renderer registry负责预览 (`core/tools/edit.ts:75-94,203-228`)。
- **状态**: **SUPERSEDED**（UX层），但 validation/schema见 CU-017/018。
- **移植动作/依赖**: 不用U8 `core/tools/bash.ts/edit.ts`覆盖当前 wrapper/HCP分层；只把纯validation/schema行为下沉HCP。保留后台shell、tool grouping、renderer registry。
- **测试**: bash partial/settled elapsed、collapsed width、truncation、background promotion；edit multi-region preview/final、error不重复、large gap collapse、extra field。

## 4. 建议落地顺序

1. **低耦合 UI/settings 批次**: CU-001、002、008、009、014、016、020、025。依赖少，能先获得用户可见收益。
2. **RPC/lifecycle 批次**: CU-003、004、005，并同时定义 background/external activation 的 settled语义。
3. **HCP tool 合规批次**: CU-017、018、026；修改所有权应在 `HarnessComponentProtocol/tools/**`，coding-agent仅验证assembly。
4. **资源/extension 批次**: CU-006、007、019、022、023；保留project trust和HCP动态能力。
5. **model/auth breaking批次**: CU-011、012、015、024；必须与 `pi-ai/pi-agent-core/pi-tui` 0.80.8升级统一实施。
6. **显式产品决定**: CU-010 日期；CU-013 custom theme兼容是否接受上游fallback。

## 5. 全量提交附录（107/107）

说明：版本栏表示首次进入的 release。`N/A` 不代表提交无价值，只表示本审计不把 release/changelog/lockfile 或纯依赖包行为重复当作 coding UI 移植单元。短 SHA 在固定证据库内唯一。

### v0.80.3（35 commits）

| SHA | 摘要 | 状态/映射 |
|---|---|---|
| `e3dcb244` | modern Microsoft Foundry Responses endpoints | PARTIAL / CU-015，依赖AI provider |
| `8277bd68` | Add Unreleased | N/A |
| `63386614` | benchmark timings after TUI stop | PRESENT / CU-020 |
| `c5440162` | resources before resumed messages | PRESENT / CU-020 |
| `371adcf3` | retry explicit provider retry errors | PARTIAL / CU-022 |
| `0bdbe7c5` | preserve extension timing measurements | PRESENT / CU-020 |
| `d8a2cab3` | drain startup benchmark replies | PRESENT / CU-020 |
| `7e6e59b6` | stale version | N/A |
| `b940c52e` | MiniMax shared budget clamp | N/A（AI继承） |
| `4cc339f5` | process BMP images from disk | MISSING / CU-025 |
| `f78b1637` | revert MiniMax clamp | N/A（AI继承） |
| `e454f50b` | session id for no-session runs | PRESENT/PARTIAL / CU-021 |
| `f14b3594` | show length stop errors | MISSING / CU-020 |
| `543710f6` | reject invalid session files | MISSING / CU-021 |
| `77428858` | update OpenAI default | SUPERSEDED / CU-024 |
| `0d145e89` | shorten invalid session error | MISSING / CU-021 |
| `73581ea9` | avoid pre-prompt compaction continue | PARTIAL / CU-022 |
| `1d486163` | examples + undici vuln update | PARTIAL / docs/examples batch |
| `7ba1b6bf` | RPC get_entries/get_tree | MISSING / CU-003 |
| `122527b2` | rpc-entry and Bun support | MISSING / CU-004 |
| `988990f1` | lockfile drift | N/A |
| `0760bbae` | lockfile drift | N/A |
| `622eca76` | installer lock generation | N/A（package install artifact） |
| `f2e9d753` | preserve backslash escapes | MISSING / CU-020 |
| `5a073885` | external editor setting | PARTIAL / CU-002 |
| `5d499272` | stabilize status indicators | PARTIAL / CU-020 |
| `927e9806` | compaction event regression test | PRESENT |
| `726a9c52` | session name change events | PARTIAL / CU-023（internal event present；extension-facing contract missing） |
| `2117b61c` | undici mid-stream errors | PARTIAL（依赖transport） |
| `6564d947` | assistant output padding | MISSING / CU-001 |
| `9be55bc7` | user output padding | MISSING / CU-001 |
| `e547bb9f` | refresh state before next turn | PARTIAL / CU-022 |
| `fd6659dd` | preserve run prompt during tool refresh | PARTIAL / CU-022 |
| `f98a154d` | audit changelog | N/A |
| `a23abe4a` | Release v0.80.3 | N/A |

### v0.80.4（38 commits）

| SHA | 摘要 | 状态/映射 |
|---|---|---|
| `dd87c02c` | Add Unreleased | N/A |
| `cbcf4e04` | reject oversized bash timeout | MISSING / CU-017 |
| `85b7c247` | reject non-positive bash timeout | MISSING / CU-017 |
| `040f0a51` | expose model resolution helpers | PARTIAL / CU-023 |
| `ba10b60b` | session entry renderers | MISSING / CU-019 |
| `f58c1156` | serialize split-turn compaction summaries | PARTIAL / CU-022 |
| `f8bec25f` | surface auth save failures | PRESENT / CU-015 |
| `ec857fec` | question example sequential mode | PARTIAL（example缺该变更） |
| `67575615` | abort stuck context hooks | N/A/CONFLICT（后续revert且HCP路径不同） |
| `ca09b2b1` | skip unauthenticated default | PARTIAL / CU-024 |
| `4a9c962b` | pnpm self-update prune hint | MISSING（package CLI） |
| `83cbfc65` | remove Vercel AI Gateway attribution | PARTIAL（provider assembly） |
| `a1b336d7` | allow extra edit fields | CONFLICT / CU-018 |
| `035ea9c8` | remove redundant record guards | N/A |
| `604ac652` | fix CI example | N/A |
| `75ac0cb0` | stabilize compaction threshold test | N/A（test-only） |
| `47830134` | quiet dot test reporters | N/A |
| `6efc09b7` | clear label timestamp cache | PARTIAL |
| `8c0ccd14` | normalize null message content | PARTIAL（ingestion/HCP） |
| `c8ada4e7` | project-local config | PARTIAL / CU-007 |
| `b3dff19a` | InlineExtension | MISSING / CU-023 |
| `244f1dea` | before_provider_headers | MISSING / CU-023 |
| `2b00dade` | revert abort stuck context hooks | N/A |
| `cc2db980` | Xiaomi catalog refresh | N/A（AI/model data） |
| `62f45bad` | native clipboard in Bun | PARTIAL / CU-009/015 binary |
| `312bc713` | provider args for login | MISSING / CU-015 |
| `86afffe0` | fork double select guard | MISSING/PARTIAL（需移植guard test） |
| `4285712b` | retry Bun socket drops | N/A（AI继承） |
| `c6251a86` | modelOverrides extension providers | MISSING / CU-024 |
| `2170363a` | Windows context walk hang | PARTIAL（resource/HCP） |
| `c4281a7d` | session-id create warning | PARTIAL / CU-021 |
| `1ffca0f2` | align reload descriptions | PARTIAL（Magenta区分reload/refresh） |
| `e9fa5a68` | settled lifecycle | MISSING/CONFLICT / CU-005 |
| `a6f720e6` | custom messages compaction budget | PARTIAL / CU-022 |
| `3f9aa5d1` | cache miss tracking | PARTIAL / CU-006 |
| `7df2a94e` | GPT-5.6 metadata | SUPERSEDED（Magenta c97d255） |
| `bf75b8aa` | audit changelogs | N/A |
| `912d0953` | Release v0.80.4 | N/A |

### v0.80.5（3 commits）

| SHA | 摘要 | 状态/映射 |
|---|---|---|
| `ef793a98` | Add Unreleased | N/A |
| `a98778e2` | fix interactive fixture | N/A（test-only） |
| `cc62baa4` | Release v0.80.5 | N/A |

### v0.80.6（6 commits）

| SHA | 摘要 | 状态/映射 |
|---|---|---|
| `e3513193` | Add Unreleased | N/A |
| `fbdd4638` | max thinking | PARTIAL / CU-013 |
| `a9ecf301` | input pricing tiers | PARTIAL（AI/model config依赖） |
| `1a2542b1` | expand `~` in shellPath | MISSING / CU-016 |
| `1775fe4c` | audit changelogs | N/A |
| `2b3fda99` | Release v0.80.6 | N/A |

### v0.80.7（15 commits）

| SHA | 摘要 | 状态/映射 |
|---|---|---|
| `34582ef3` | Add Unreleased | N/A |
| `3ea064ea` | Bedrock API key login | MISSING / CU-015 |
| `3b686ac2` | message copy shortcut | MISSING / CU-008 |
| `d7a48d30` | clipboard text fallback | MISSING / CU-009 |
| `3d8f7435` | message-anchored tool loading | PARTIAL/CONFLICT / CU-022 |
| `4c186103` | audit changelogs | N/A |
| `298665cf` | OpenRouter session affinity | N/A（AI继承；docs需同步） |
| `7303cbac` | branch summary ambient auth | PARTIAL（auth migration依赖） |
| `b084d2fb` | npm uninstall legacy-peer-deps | MISSING（package CLI） |
| `961fa6c1` | Radius gateway | MISSING（CU-011依赖） |
| `adfac437` | clarify login options | MISSING / CU-015 |
| `f4e9ca74` | remove prompt date | CONFLICT / CU-010 |
| `9993c969` | ModelRuntime | CONFLICT / CU-011 |
| `53a087fe` | audit changelogs | N/A |
| `818d6745` | Release v0.80.7 | N/A |

### v0.80.8（10 commits）

| SHA | 摘要 | 状态/映射 |
|---|---|---|
| `9d09075c` | Add Unreleased | N/A |
| `fab309e9` | refresh model catalogs in picker | MISSING / CU-012 |
| `45203abf` | coalesce thinking blocks | MISSING / CU-014 |
| `bd9e09db` | dynamic provider refresh | MISSING / CU-012 |
| `12545274` | reset Windows terminal title | MISSING/PARTIAL（interactive update UX） |
| `5220aba6` | xAI OAuth/Grok 4.5 | MISSING / CU-015（AI依赖） |
| `97f9978f` | model catalog refresh flag | MISSING / CU-012 |
| `eb793510` | audit changelogs | N/A |
| `6442536b` | bundle OAuth in Bun | MISSING / CU-015 |
| `fae7176c` | Release v0.80.8 | N/A |

## 6. 验证说明

本任务为只读静态审计，没有修改主仓库，也没有运行会写缓存/快照的 test suite。证据来自四个固定快照的 `git log/show/diff`、符号搜索和源文件逐段读取。实施阶段应按每个 CU 的测试列表运行目标 Vitest；ModelRuntime/HCP/lifecycle 三组必须再跑 coding-agent 全套、根 TypeScript build、Bun binary smoke 和现有 Magenta orchestration/headless tests。
