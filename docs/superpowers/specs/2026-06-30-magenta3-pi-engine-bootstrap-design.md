# Magenta3 设计:pi 引擎 + Magenta 配置层 bootstrap

- 状态:Design / 待用户复核
- 日期:2026-06-30
- 仓库:`/Users/mjm/Magenta3`（全新 git 仓）
- 子项目:Magenta 主线第 1 阶段（bootstrap "跑通"）

## 1. 背景与定位

Magenta 此前有两条历史路线:

- **Rust 重构(`/Users/mjm/Magenta`、`/Users/mjm/Magenta2`)**:从 over-engineered 的老
  kernel 提纯出干净的 `magenta-core`(ReAct 循环 + 进程内 `trait Tool` + 事件流),
  HCP/Magnet 作为管理/装配层,不在 core 热路径。
- **本仓 Magenta3(TS)**:用已验证的 TS coding-agent **pi** 作引擎底座重走同一套架构思想。

**决策(已对齐):Magenta3 是新主线,用 TypeScript 重走,取代 Rust 路线。** 长期目标是把
Magenta2 文档里的架构思想(干净 core + HCP/Magnet 装配层 + 散装工具的双属性/Schema 模型)
用 TS 长在 pi 之上。理由:TS 快速开发,pi 已是经过验证的完整 coding-agent,不必在 Rust 里
从零磨。

**本阶段范围**:只做"跑通"——把 pi 引擎和原 LazyPi 配置落进 Magenta3,改名为 Magenta,
能构建、能加载配置、能跑一轮真实对话。HCP/Magnet/散装工具等大架构留到后续子项目。

## 2. 两个参考物的真实关系

- **pi-main**(`Reference_Repo/pi-main`):真正的代码库。TypeScript monorepo(npm
  workspaces + tsgo 构建),四个包 `ai`/`agent`/`coding-agent`/`tui`。CLI 命令 `pi`,
  配置目录约定 `.pi`。这是"引擎"。
- **LazyPi-main**(`Reference_Repo/LazyPi-main`):几乎无代码。`.gitignore` 默认忽略一切,
  只版本化 `agent/{settings.json, APPEND_SYSTEM.md, extensions/, skills/}`。它本质是一份
  可迁移的 pi agent 配置目录(结构 = pi 的 `~/.pi/agent`),设计上 clone 到 `~/.pi` 后
  **跑在 pi 之上**,自身不独立运行。

结论:不是两个平级仓库,而是**引擎 + 配置层**。"两个都跑通"的准确含义是:构建 pi,让它加载
Magenta(原 LazyPi)配置跑起来。

## 3. 关键机制(决定并入方式)

pi 解析配置目录的逻辑(`engine/packages/coding-agent/src/config.ts`):

- `getAgentDir()` 默认 `~/.pi/agent`,**可用环境变量 `PI_CODING_AGENT_DIR` 覆盖**
  (config.ts:514-521)。这是干净并入的钥匙:让 pi 读 Magenta3 仓内配置,完全不碰用户的 `~/.pi`。
- extensions/skills 自动从两处加载:项目级 `.pi/` 与用户级 agent 目录
  (package-manager.ts:2307-2375)。LazyPi README "clone 到 ~/.pi" 即用后者。

pi 读 OpenAI key:环境变量 `OPENAI_API_KEY`(`engine/packages/ai/src/env-api-keys.ts:76`)。
也支持 `auth.json`。Anthropic 支持 `ANTHROPIC_OAUTH_TOKEN`/`ANTHROPIC_API_KEY`(同文件:71)。

pi 无 web UI。modes 只有三种:`interactive`(TUI)、`print-mode`(一次性 CLI)、
`rpc`(JSON-RPC 集成,非 web)。`check:browser-smoke` 只是验证 `ai` 包能被 esbuild 按
browser 平台打包的**库可移植性检查**,不是 web 应用。

## 4. 仓库结构

```
Magenta3/
├── engine/                  # = pi-main 直接拷贝(引擎,内部 "pi" 命名不动)
│   └── packages/{ai,agent,coding-agent,tui}, package.json, scripts/ ...
├── magenta-config/          # = 原 LazyPi 的 agent/,品牌改名 Magenta(配置层)
│   └── agent/{settings.json, APPEND_SYSTEM.md, extensions/, skills/}
├── bin/magenta              # 包装脚本:抓 key + 设 PI_CODING_AGENT_DIR → 调 engine 的 pi
├── docs/superpowers/specs/  # 本 spec 等
├── README.md
└── .gitignore               # 忽略 node_modules / auth.json / sessions / cache
```

预留(本阶段不建,仅说明长期形态):未来 `management/`(TS 实现的 HCP/Magnet 装配层)
产出 pi 的 `AgentTool[]` 注入引擎,对应 Magenta2 文档"装配层产出工具集合"的思想。

### 关键设计决策

- **引擎/配置物理隔离**:`engine/` = pi 主线代码底座(直接拷贝,不保留上游 git 历史,
  后续随意改);Magenta 个性全在 `magenta-config/` 演化。
- **品牌边界**:pi 引擎内部不改名(包名 `@earendil-works/pi-*`、CLI `pi`、配置约定
  `.pi`、extension 内部工具标识符如 `bg_shell_*`/`sub_agent` 保持原样——它们是功能契约)。
  用户看到的 "Magenta" 身份由 `bin/magenta` 命令名 + 提示词 + README + 配置文案承载。
- **不动 cli.ts 入口**:保留 interactive/print/rpc 三模式;仅从 Magenta 的 check 流程
  移除 browser-smoke。
- **一条命令跑起来**:`bin/magenta` 自动抓 key + 设 `PI_CODING_AGENT_DIR` + 调 pi。

## 5. LazyPi → Magenta 改名范围

- **纯文案改名(安全)**:README、`APPEND_SYSTEM.md` 提示词措辞、配置注释里的 "LazyPi" →
  "Magenta"。
- **引擎内部不动**:pi 包名、CLI 命令 `pi`、配置目录约定 `.pi`、extension 内部工具标识符。
- **`pi-web-access` 包**:这是给 agent 联网搜索的扩展(非 web UI),**保留**——为真实对话
  提供上网能力,与"删 Web"无关。

## 6. Web 处理

pi 无 web UI 可删。保留 interactive(TUI)/ print(CLI)/ rpc;仅从 `check` 流程移除
`browser-smoke` 构建检查。不动 `cli.ts`。

## 7. 凭证抓取(从 Codex / Claude Code 本地配置)

`bin/magenta` 启动时按优先级解析 key 并注入子进程环境,**不落盘、不打印 key 值**:

- **OpenAI(主验证路径)**:读 `~/.codex/auth.json` 的 `OPENAI_API_KEY` 字段
  → 注入 `OPENAI_API_KEY`(已确认该文件存在此字段,权限 600,脚本只读不改)。
- **Anthropic(备选)**:环境中的 `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL`
  映射到 pi 认的变量。注意是 `AUTH_TOKEN` 且带自定义 base URL,需额外验证 pi 对自定义
  base URL 的兼容性;第一阶段以 OpenAI 为主,Anthropic 标为"如需再启用"。

已确认当前 shell 环境无 `OPENAI_API_KEY`,但 `~/.codex/auth.json` 有——故由 bin/magenta
自动抓取,无需手工 export。

## 8. 跑通路径与验收

1. `cd engine && npm install --ignore-scripts` → `npm run build`(tsgo 编译四包,
   产出 `dist/cli.js`)。
2. `bin/magenta` 抓 OpenAI key + 设 `PI_CODING_AGENT_DIR=<repo>/magenta-config/agent`,
   调用构建好的 pi。
3. **配置加载验证**:`magenta` 启动后 `/jobs`、`/side` 等原 LazyPi 扩展命令可识别
   → 证明配置并入生效。
4. **真实对话验证(本阶段验收线)**:OpenAI provider + `gpt-5.5`(沿用 settings)。
   `magenta -p "say hello"` 非交互跑一轮,拿到真实回复。

## 9. 验证与测试策略

- 构建:`engine` 的 `npm run build` 通过,生成 `dist/cli.js`。
- 引擎自带测试:`engine` 下 `./test.sh`(无 key 时自动跳过依赖 LLM 的用例)。
- Magenta 层冒烟:`bin/magenta --help` 正常;扩展命令被识别;一轮真实对话成功。
- 清理:验证产生的临时 session 不入库(.gitignore 覆盖)。

## 10. 关键决策记录

- Magenta3 = 新主线,TS 重走取代 Rust;pi 作引擎底座。
- pi 代码直接拷贝进 `engine/`,不保留上游 git 历史(它就是我们的主线代码)。
- LazyPi 配置改名 Magenta 并入,经 `PI_CODING_AGENT_DIR` 加载,不碰 `~/.pi`。
- 引擎内部 "pi" 命名不动;"Magenta" 身份在配置/包装层/文案承载。
- Web:无 UI 可删,保留 rpc,仅去 browser-smoke。
- key 由 `bin/magenta` 启动时从 Codex/Claude Code 本地配置自动抓取,不落盘。
- 验收线 = 能跑真实对话(OpenAI + gpt-5.5)。

## 11. 后续子项目(本 spec 之外)

1. TS 版 HCP/Magnet 装配层(对应 Magenta2 core 设计的管理层思想)。
2. 散装工具管理:双属性模型(`implementation_name` + `source_harness`)+ Magnet 连接配置
   + Schema 注册表(`schema_profile` + `param_mapping`)+ 回退选择器 + Pack
   (草稿见 `Reference_Repo/Magenta-main/DRAFT-tool-pluggable-management.md`)。
3. pi 引擎品牌化彻底改名 magenta(如未来需要)。
4. 引擎与 pi 上游的对照升级策略(当前直接拷贝,暂不考虑上游合并)。
