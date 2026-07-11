# Magenta 安装指南

Magenta 的二进制文件发布在公开仓库 `Minions-Land/Magenta-CLI`，任何人都可以**匿名下载**，无需 GitHub Token。

## 📦 方式一：一键安装（推荐）

### macOS
```bash
curl -fsSL https://github.com/Minions-Land/Magenta-CLI/releases/latest/download/magenta-macos -o ~/.local/bin/magenta && \
chmod +x ~/.local/bin/magenta && \
~/.local/bin/magenta --version
```

### Linux
```bash
curl -fsSL https://github.com/Minions-Land/Magenta-CLI/releases/latest/download/magenta-linux -o ~/.local/bin/magenta && \
chmod +x ~/.local/bin/magenta && \
~/.local/bin/magenta --version
```

安装完成后，添加到 PATH（如果提示需要）：
```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc   # macOS
source ~/.zshrc

# 验证
magenta --version
```

> 提示：如果 `~/.local/bin` 不存在，先运行 `mkdir -p ~/.local/bin`。

---

## 📥 方式二：手动下载

直接从浏览器或命令行下载对应平台的二进制：

**macOS:**
```bash
curl -fsSL https://github.com/Minions-Land/Magenta-CLI/releases/latest/download/magenta-macos -o magenta
chmod +x magenta
sudo mv magenta /usr/local/bin/
```

**Linux:**
```bash
curl -fsSL https://github.com/Minions-Land/Magenta-CLI/releases/latest/download/magenta-linux -o magenta
chmod +x magenta
sudo mv magenta /usr/local/bin/
```

**验证安装：**
```bash
magenta --version
# 应该显示: 0.0.3（或更高版本）
```

也可以在页面手动下载：https://github.com/Minions-Land/Magenta-CLI/releases/latest

---

## 🔄 更新 Magenta

```bash
magenta --update
```

更新过程：
1. 🔍 检查公开仓库最新版本（匿名，无需 token）
2. 📥 自动下载新版本（显示进度）
3. 💾 备份旧版本（.backup）
4. ✅ 原子替换，失败自动回滚

---

## ❓ 常见问题

### 问：需要 GitHub Token 吗？

答：**不需要。** 二进制发布在公开仓库，下载和更新都是匿名的。

### 问：安装需要 Node.js 吗？

答：**不需要。** Magenta 是单文件二进制，无任何依赖。

### 问：文件多大？

答：约 73MB，包含了完整的运行时环境。

### 问：支持哪些平台？

答：
- ✅ macOS (Apple Silicon)
- 🚧 Linux（构建中）
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

## 📞 获取帮助

- 文档：[README.md](../README.md)
- 更新日志：[CHANGELOG.md](../pi/coding-agent/CHANGELOG.md)
