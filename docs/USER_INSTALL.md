# Magenta 安装指南

## 📦 方式一：一键安装（推荐）

### macOS / Linux

```bash
# 设置你的 GitHub Token（必需，因为是私有仓库）
export MAGENTA_GITHUB_TOKEN="your_github_token_here"

# 一键安装
curl -fsSL https://raw.githubusercontent.com/Minions-Land/Magenta/main/scripts/remote-install.sh | bash
```

安装完成后：
```bash
# 添加到 PATH（如果提示需要）
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc

# 验证安装
magenta --version
```

---

## 📥 方式二：手动下载

### 1. 获取 GitHub Token

访问：https://github.com/settings/tokens

创建一个 Personal Access Token，权限选择：
- ✅ `repo` (Full control of private repositories)

### 2. 下载二进制文件

**macOS:**
```bash
export GITHUB_TOKEN="your_token_here"

# 获取最新版本信息
RELEASE_INFO=$(curl -fsSL \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  "https://api.github.com/repos/Minions-Land/Magenta/releases/latest")

# 获取 asset ID
ASSET_ID=$(echo "$RELEASE_INFO" | grep -A3 '"name": "magenta-macos"' | grep '"id":' | head -1 | sed -E 's/.*"id": *([0-9]+).*/\1/')

# 下载
curl -fsSL \
  -H "Accept: application/octet-stream" \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -o magenta \
  "https://api.github.com/repos/Minions-Land/Magenta/releases/assets/$ASSET_ID"

# 设置可执行权限
chmod +x magenta

# 移动到系统路径
sudo mv magenta /usr/local/bin/
```

**Linux:**
```bash
# 同上，但下载 magenta-linux
# （将 "magenta-macos" 替换为 "magenta-linux"）
```

### 3. 验证安装

```bash
magenta --version
# 应该显示: 0.0.3（或更高版本）
```

---

## 🔄 更新 Magenta

安装后，更新非常简单：

```bash
# 自动检查并更新到最新版本
magenta --update
```

更新过程：
1. 🔍 检查 GitHub 最新版本
2. 📥 自动下载新版本（显示进度）
3. 💾 备份旧版本（.backup）
4. ✅ 原子替换，失败自动回滚

---

## ❓ 常见问题

### 问：为什么需要 GitHub Token？

答：Magenta 仓库是私有的，需要 token 才能访问 releases。

### 问：安装需要 Node.js 吗？

答：**不需要！** Magenta 是单文件二进制，无任何依赖。

### 问：文件多大？

答：约 73MB，包含了完整的运行时环境。

### 问：支持哪些平台？

答：
- ✅ macOS (Intel & Apple Silicon)
- 🚧 Linux（即将支持）
- ❌ Windows（暂不支持）

### 问：更新失败怎么办？

答：
1. 旧版本会自动备份为 `.backup`
2. 重试 `magenta --update`
3. 如果仍然失败，手动恢复：`mv magenta.backup magenta`

### 问：如何卸载？

答：
```bash
rm ~/.local/bin/magenta
# 或者
sudo rm /usr/local/bin/magenta
```

---

## 🚀 快速开始

安装完成后：

```bash
# 查看版本
magenta --version

# 查看帮助
magenta --help

# 启动交互式对话
magenta

# 非交互式命令
magenta "帮我分析这个项目"

# 检查更新
magenta --update
```

---

## 🔒 安全提示

1. **保护你的 GitHub Token**
   - 不要提交到代码仓库
   - 使用环境变量或密钥管理工具
   - 定期轮换

2. **验证下载**
   - 安装脚本会验证文件大小
   - 更新时会验证新版本能正常运行

3. **备份机制**
   - 每次更新自动备份旧版本
   - 失败自动回滚

---

## 📞 获取帮助

- 文档：[README.md](../README.md)
- 问题：[GitHub Issues](https://github.com/Minions-Land/Magenta/issues)
- 更新日志：[CHANGELOG.md](../pi/coding-agent/CHANGELOG.md)
