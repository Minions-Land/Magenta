# Magenta 发布与自动更新指南（开发者）

本文档面向 **Magenta 维护者**，说明如何发布新版本，以及自动更新的工作原理。用户安装文档见 [USER_INSTALL.md](./USER_INSTALL.md)。

## 分发架构

二进制发布在公开仓库 `Minions-Land/Magenta-CLI`，用户匿名下载。

**关键点：**
- 二进制里**不内嵌任何 GitHub Token**
- 用户下载和 `magenta --update` 都是匿名的（公开仓库 release）

---

## 🚀 发布新版本

### 一键发布脚本

```bash
# 1. 先更新版本号
#    编辑 brands/magenta/magenta.brand.ts，把 version 改成新版本

# 2. 运行发布脚本
./scripts/publish-to-cli-repo.sh 0.0.4 "本次更新说明"
```

脚本会自动完成：
1. 校验 brand 版本与发布版本一致
2. 编译单文件二进制（`npm run build:binary`）
3. **安全检查**：确认二进制里没有内嵌任何 token
4. 验证二进制能正常运行且版本正确
5. 按平台命名（`magenta-macos` / `magenta-linux`）
6. 发布/追加到公开仓库 `Minions-Land/Magenta-CLI` 的 release

### 多平台发布

在对应平台的机器上分别运行发布脚本，asset 会追加到同一个 release：
- macOS 机器上运行 → 上传 `magenta-macos`
- Linux 机器上运行 → 上传 `magenta-linux`

---

## 🔄 自动更新工作原理

核心逻辑在 `pi/coding-agent/src/utils/github-release-update.ts`。

### 配置

```typescript
// 默认指向公开仓库，无需 token
const GITHUB_REPO = process.env.MAGENTA_GITHUB_REPO || "Minions-Land/Magenta-CLI";

// token 默认为空；公开仓库匿名下载即可
// 仅当发布仓库为私有时才需要设置 MAGENTA_GITHUB_TOKEN
const GITHUB_TOKEN = process.env.MAGENTA_GITHUB_TOKEN || "";
```

### 更新流程

1. 启动时后台检查（每天最多一次）GitHub 最新 release
2. 发现新版本时提示用户运行 `magenta --update`
3. `--update` 时：
   - 通过 `browser_download_url` 匿名下载对应平台二进制
   - 验证新二进制能运行（`--version`）
   - 备份当前二进制为 `.backup`
   - 原子替换，失败自动回滚

### 重要安全守卫

自更新**只在编译后的 bun 单文件二进制里生效**（通过 `isBunBinary` 判断）。

原因：当通过 `node dist/cli.js` 运行时，`process.execPath` 指向的是 Node.js 可执行文件本身，若执行自更新会**覆盖宿主的 Node.js 安装**。因此 Node.js 环境下自更新会被拒绝并给出提示。

---

## 🔍 手动检查更新状态

```bash
# 触发一次更新检查并安装
magenta --update
```

如果当前通过 Node.js 运行（开发环境），会提示"自更新仅适用于编译后的二进制"，这是预期行为。

---

## 📋 相关文件

```
pi/coding-agent/src/
├── utils/github-release-update.ts    # 更新核心逻辑（指向公开仓库，无内嵌 token）
├── config.ts                          # isBunBinary 检测
└── main.ts                            # 集成启动检查和 --update

scripts/
└── publish-to-cli-repo.sh            # 发布二进制到公开仓库

docs/
├── USER_INSTALL.md                   # 用户安装文档
├── QUICKEST_INSTALL.md               # 极简安装
└── ZERO_CONFIG_INSTALL.md            # 零配置安装说明
```
