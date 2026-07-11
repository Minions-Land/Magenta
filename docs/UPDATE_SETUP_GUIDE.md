# Magenta 自动更新功能完整指南

## ✅ 已完成的工作

### 1. 核心功能实现
- ✅ GitHub Releases API 集成
- ✅ 版本比较和检查逻辑
- ✅ 二进制自动下载和替换
- ✅ 启动时后台更新检查
- ✅ `--update` 命令行参数

### 2. 相关文件
```
pi/coding-agent/src/
├── utils/github-release-update.ts    # 更新核心逻辑
├── main.ts                            # 集成更新检查和安装
└── cli/args.ts                        # 添加 --update 参数

scripts/
├── release-to-github.sh              # 发布到 GitHub Releases
├── create-dist-package.sh            # 创建用户分发包
├── user-install.sh                   # 用户安装脚本
└── INSTALL_README.md                 # 用户安装说明

docs/
└── github-release-auto-update.md     # 完整文档
```

---

## 🚀 使用流程

### 作为开发者（你）

#### 首次配置

1. **创建 GitHub Token**
   ```bash
   # 访问 https://github.com/settings/tokens
   # 创建 token，勾选 repo 权限
   ```

2. **设置环境变量**
   ```bash
   export MAGENTA_GITHUB_REPO="your-org/magenta3"
   export MAGENTA_GITHUB_TOKEN="ghp_xxxxxxxxxxxx"
   
   # 持久化（添加到 ~/.zshrc）
   echo 'export MAGENTA_GITHUB_REPO="your-org/magenta3"' >> ~/.zshrc
   echo 'export MAGENTA_GITHUB_TOKEN="ghp_xxxx"' >> ~/.zshrc
   ```

#### 发布新版本

**方式 1：使用自动化脚本**
```bash
# 一键发布到 GitHub Releases
./scripts/release-to-github.sh 0.80.3 "修复某个 bug"
```

**方式 2：手动步骤**
```bash
# 1. 构建二进制
npm run build:binary

# 2. 发布到 GitHub
gh release create v0.80.3 \
  pi/coding-agent/dist/magenta \
  --title "Magenta v0.80.3" \
  --notes "更新内容..."
```

#### 创建用户分发包（可选）

如果不想让用户直接从 GitHub 下载：

```bash
# 创建包含安装脚本的压缩包
./scripts/create-dist-package.sh 0.80.3

# 生成文件：dist-packages/magenta-dist-0.80.3.tar.gz
# 发送给用户即可
```

---

### 作为用户（团队成员）

#### 首次安装

**从分发包安装**
```bash
tar xzf magenta-dist-0.80.3.tar.gz
cd magenta-dist-0.80.3
./install.sh
```

**或手动安装**
```bash
mkdir -p ~/.local/bin
cp magenta ~/.local/bin/
chmod +x ~/.local/bin/magenta
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

#### 日常使用

```bash
# 正常启动（会自动检查更新，每24小时一次）
magenta

# 如果看到更新提示：
💡 新版本 v0.80.3 可用，运行 'magenta --update' 升级

# 执行更新
magenta --update
```

---

## 🔧 技术细节

### 更新检查机制

1. **触发时机**
   - 用户启动 `magenta` 时后台检查（非阻塞）
   - 用户运行 `magenta --update` 时强制检查

2. **检查间隔**
   - 每 24 小时检查一次（避免频繁请求 GitHub API）
   - 记录文件：`~/.magenta/last-update-check`

3. **版本比较**
   - 比较本地 `VERSION` 和 GitHub Release 的 `tag_name`
   - 使用语义化版本号（`0.80.3` → `[0, 80, 3]`）

### 更新安装流程

```
magenta --update
    ↓
检查 GitHub Releases API
    ↓
下载新二进制到 .new
    ↓
验证新二进制可执行
    ↓
备份当前版本到 .backup
    ↓
替换为新版本
    ↓
完成（提示用户重启）
```

### 安全性

- ✅ **GitHub Token 权限**：只有 `repo` 或 `public_repo`（只读）
- ✅ **自动备份**：更新前备份旧版本到 `.backup`
- ✅ **版本验证**：下载后测试新二进制是否可运行
- ⚠️ **Token 泄露风险**：编译在二进制中，可能被逆向提取

---

## 📋 常见场景

### 场景 1：紧急 bug 修复

```bash
# 1. 修复代码
git add .
git commit -m "fix: 紧急修复某个问题"

# 2. 发布新版本
./scripts/release-to-github.sh 0.80.4 "紧急修复某个问题"

# 3. 通知用户
# 在团队群发消息：
#   "Magenta v0.80.4 已发布，修复了某个问题
#    请运行 'magenta --update' 更新"
```

### 场景 2：新用户加入

```bash
# 1. 创建分发包
./scripts/create-dist-package.sh

# 2. 发送给新用户
# 发送文件：dist-packages/magenta-dist-xxx.tar.gz

# 3. 指导用户安装
#    tar xzf magenta-dist-xxx.tar.gz
#    cd magenta-dist-xxx
#    ./install.sh
```

### 场景 3：多平台支持

```bash
# macOS 上构建
npm run build:binary
gh release create v0.80.3 \
  pi/coding-agent/dist/magenta#magenta-macos \
  --title "Magenta v0.80.3"

# Linux 上构建（需要 Linux 机器）
npm run build:binary
gh release upload v0.80.3 \
  pi/coding-agent/dist/magenta#magenta-linux
```

---

## 🐛 故障排查

### 用户看不到更新提示

```bash
# 检查 GitHub Token 是否有效
curl -H "Authorization: Bearer $MAGENTA_GITHUB_TOKEN" \
  https://api.github.com/repos/$MAGENTA_GITHUB_REPO/releases/latest

# 强制检查
magenta --update
```

### 更新失败

```bash
# 手动恢复旧版本
mv ~/.local/bin/magenta.backup ~/.local/bin/magenta

# 查看错误日志
magenta --update --verbose  # （如果实现了 verbose）
```

### Token 泄露

```bash
# 1. 立即撤销旧 token（GitHub Settings → Tokens）
# 2. 生成新 token
# 3. 重新设置环境变量
export MAGENTA_GITHUB_TOKEN="ghp_new_token"

# 4. 重新构建并发布
./scripts/release-to-github.sh 0.80.5 "安全更新：重新签名"
```

---

## 📚 参考文档

- 完整文档：`docs/github-release-auto-update.md`
- GitHub Releases API：https://docs.github.com/en/rest/releases
- 语义化版本：https://semver.org/

---

## 🎯 下一步建议

1. **测试完整流程**
   ```bash
   # 构建并发布一个测试版本
   ./scripts/release-to-github.sh 0.80.3-test "测试更新功能"
   
   # 在另一台机器验证更新流程
   ```

2. **优化用户体验**
   - 添加更新进度条
   - 支持静默更新（`--update --silent`）
   - 自动更新检查频率可配置

3. **增强安全性**
   - 对二进制签名（code signing）
   - 使用更安全的 token 管理方式
   - 定期轮换 GitHub Token
