# Magenta GitHub Releases 自动更新指南

## 概述

Magenta 现在支持基于 GitHub Releases 的自动更新机制。这允许你：
- 将源代码保持私有（只有你能访问）
- 通过 GitHub Releases 分发二进制文件
- 用户可以轻松检查和安装更新，无需访问源代码

## 配置步骤

### 1. 创建 GitHub Personal Access Token

1. 访问 https://github.com/settings/tokens
2. 点击 "Generate new token (classic)"
3. 设置名称：`Magenta Auto-Update`
4. 勾选权限：
   - ✅ `repo` (如果是私有仓库)
   - 或 ✅ `public_repo` (如果是公开仓库)
5. 生成并复制 token（形如 `ghp_xxxxxxxxxxxxxxxxxxxx`）

### 2. 配置环境变量

在构建二进制**之前**，设置以下环境变量：

```bash
# GitHub 仓库（格式：owner/repo）
export MAGENTA_GITHUB_REPO="your-org/magenta3"

# GitHub Token（用于访问 releases）
export MAGENTA_GITHUB_TOKEN="ghp_your_token_here"
```

**重要**：这些值会被编译进二进制文件中，用户无需配置。

### 3. 构建二进制

```bash
cd /Users/mjm/Magenta3
npm run build:binary
```

生成的二进制文件位于：`pi/coding-agent/dist/magenta`

### 4. 发布 Release

使用 GitHub CLI 发布：

```bash
# 创建 release 并上传二进制
gh release create v0.80.3 \
  pi/coding-agent/dist/magenta \
  --title "Magenta v0.80.3" \
  --notes "## 更新内容

- 新增自动更新功能
- 修复若干 bug
- 性能优化" \
  --repo your-org/magenta3
```

**多平台支持**：

如果需要支持多个平台，构建并上传不同名称的二进制：

```bash
# macOS
gh release create v0.80.3 \
  pi/coding-agent/dist/magenta#magenta-macos \
  --title "Magenta v0.80.3" \
  --notes "更新内容..."

# Linux (在 Linux 机器上构建)
gh release create v0.80.3 \
  pi/coding-agent/dist/magenta#magenta-linux \
  --title "Magenta v0.80.3" \
  --notes "更新内容..."
```

## 用户使用方式

### 安装

将二进制文件发送给用户，用户执行：

```bash
# 复制到用户本地 bin 目录
mkdir -p ~/.local/bin
cp magenta ~/.local/bin/
chmod +x ~/.local/bin/magenta

# 添加到 PATH（如果还没有）
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

### 检查更新

用户每次启动 Magenta 时，会自动在后台检查更新（每 24 小时一次）：

```bash
magenta

# 如果有新版本，会显示：
💡 发现新版本 v0.80.3，运行 'magenta --update' 升级
```

### 手动更新

```bash
magenta --update

# 输出：
🔍 检查更新...

📦 发现新版本: 0.80.3

更新内容:
- 新增自动更新功能
- 修复若干 bug

开始下载并安装...
✓ 已更新到 v0.80.3
请重新启动 magenta 使用新版本
```

## 工作原理

1. **启动检查**：用户每次运行 `magenta` 时，后台静默检查 GitHub Releases API
2. **版本比较**：比较本地版本和最新 release 的 tag（语义化版本）
3. **下载安装**：运行 `magenta --update` 时：
   - 从 GitHub 下载对应平台的二进制
   - 备份当前版本（`.backup` 后缀）
   - 替换为新版本
4. **权限控制**：使用编译进二进制的 GitHub Token，用户无需 GitHub 账号

## 安全性说明

- ✅ **源代码私有**：用户只能下载二进制，看不到源代码
- ✅ **Token 安全**：Token 编译在二进制中，只有 `public_repo` 权限，无法修改代码
- ✅ **自动备份**：更新前自动备份旧版本，出问题可以手动恢复
- ⚠️ **Token 泄露风险**：如果二进制被逆向工程，Token 可能泄露（建议定期轮换）

## 更新流程示例

### 场景：修复 bug 并发布 v0.80.4

```bash
# 1. 修改代码并提交
git add .
git commit -m "fix: 修复某个 bug"

# 2. 设置环境变量（如果还没设置）
export MAGENTA_GITHUB_REPO="your-org/magenta3"
export MAGENTA_GITHUB_TOKEN="ghp_your_token"

# 3. 构建新版本
npm run build:binary

# 4. 发布到 GitHub
gh release create v0.80.4 \
  pi/coding-agent/dist/magenta \
  --title "Magenta v0.80.4" \
  --notes "修复某个 bug"

# 5. 通知用户
# （用户下次启动 magenta 时会自动看到更新提示）
```

## 常见问题

### Q1: 用户看不到更新提示？

检查：
- GitHub Token 是否有效（`curl -H "Authorization: Bearer $TOKEN" https://api.github.com/user`）
- 用户网络是否能访问 GitHub API
- Release 是否正确发布（`gh release list`）

### Q2: 更新失败怎么办？

用户可以手动恢复：
```bash
# 如果更新失败，旧版本会备份为 .backup
mv ~/.local/bin/magenta.backup ~/.local/bin/magenta
```

### Q3: 如何禁用自动检查？

用户可以设置环境变量：
```bash
export PI_OFFLINE=1  # 禁用所有网络请求（包括更新检查）
```

### Q4: Token 泄露了怎么办？

1. 在 GitHub 立即撤销旧 Token
2. 生成新 Token
3. 重新构建并发布新版本

## 代码位置

- **更新逻辑**：`pi/coding-agent/src/utils/github-release-update.ts`
- **CLI 集成**：`pi/coding-agent/src/main.ts`
- **参数解析**：`pi/coding-agent/src/cli/args.ts`

## 后续优化建议

1. **增量更新**：下载差量补丁而非完整二进制
2. **签名验证**：对二进制进行签名，防止中间人攻击
3. **更新通知渠道**：集成企业内部通知系统（钉钉/飞书）
4. **灰度发布**：先发布给部分用户测试
