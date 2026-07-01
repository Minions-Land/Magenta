# 根 check 配置陈旧:重组后 `npm run check` 静默空跑

- 状态:Backlog(待单独 session 实施)
- 日期:2026-07-01
- 仓库:`/Users/mjm/Magenta3`
- 前置:f1da4c9 重组(`packages/*` → `pi/*` + `harness/`)。相关记忆:`root-check-configs-stale-after-reorg`。

## 0. 背景

f1da4c9 把 monorepo 从 `packages/*` 布局重组为 `pi/*` + `harness/`,但根级两个检查配置未同步更新,仍引用已不存在的 `packages/*`:

- `tsconfig.json` — `include` 指向 `packages/*/src/**` 等;`paths` 全部映射到 `packages/*`;还残留已删除的 `agent-old`。
- `biome.json` — `files.includes` 指向 `packages/*/src/**`;残留已删除的 `packages/mom/data`。

## 1. 影响(真实 CI 盲区)

`npm run check` 的两步实际空跑:

- `biome check --write --error-on-warnings .` → 只匹配 **1 个文件**,等于不做 lint。
- `tsgo --noEmit` → 报 `TS18003: No inputs were found`,全仓类型检查从不运行。

即重组以来,根级 lint 与 whole-repo typecheck 一直处于失效状态。子包各自的 build(`tsgo` per-package)仍正常,所以问题被掩盖。

## 2. 修复方案(已在 compaction session 中验证过路径映射)

### 2.1 `tsconfig.json`
- `paths`:`packages/ai` → `pi/ai`,`packages/agent` → `pi/agent`,`packages/coding-agent` → `pi/coding-agent`,`packages/tui` → `pi/tui`。
- 新增 `@magenta/harness` → `harness/index.ts`、`@magenta/harness/*` → `harness/*`。
- 删除 `@earendil-works/pi-agent-old`(目录已不存在)。
- `include`:`["pi/*/src/**/*", "pi/*/test/**/*", "pi/coding-agent/examples/**/*", "harness/**/*"]`。
- `exclude`:`["**/dist/**", "pi/coding-agent/examples/extensions/gondolin/**"]`。

### 2.2 `biome.json`
- `files.includes`:`pi/*/src/**/*.ts`、`pi/*/test/**/*.ts`、`pi/coding-agent/examples/**/*.ts`、`harness/**/*.ts`;排除 `**/dist/**`;删除 `packages/mom/data`。
- 注意:`scripts/**/*.mjs` 旧配置未纳入,保持不纳入以免扩大范围(旧意图是只 lint 包源码)。

## 3. 成本与风险(必须预算)

重新启用后 biome 扫描从 1 个文件跳到 ~790 个,暴露约:
- **104 errors + 13 warnings**(重组前一直隐藏)。
- 其中 `biome check --write` 可自动修复 ~56 个文件,剩余 ~17 errors 需人工修。

⚠️ 教训(来自 compaction session):**不要**为探测范围而在整仓跑 `biome check --write .` —— 它会一次性改写数十个无关文件,极易与其他进行中的改动混淆。应先只改配置、用**只读** `biome check` 统计,再在独立 PR 中分批处理自动修复 + 人工修复。

## 4. 建议落地方式

拆成独立 PR,与任何功能改动隔离:
1. commit A:仅更新 `tsconfig.json` + `biome.json` 路径(此时 CI 会变红,暴露技术债)。
2. commit B:`biome check --write` 的自动修复(纯格式,单独 review)。
3. commit C:剩余 ~17 个人工修复。

这样每一步 diff 都可独立审阅,避免格式噪音淹没逻辑改动。
