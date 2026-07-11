# Magenta 安装指南（私有仓库版）

## 🚀 一键安装

由于 Magenta 是私有仓库，需要使用自包含的安装命令。

### macOS

复制下面**整个代码块**，替换 `YOUR_TOKEN`，然后粘贴到终端运行：

```bash
export MAGENTA_TOKEN="YOUR_TOKEN" && \
bash -c "$(cat <<'EOF'
set -e
ASSET_ID=$(curl -fsSL -H "Authorization: Bearer $MAGENTA_TOKEN" -H "Accept: application/vnd.github+json" "https://api.github.com/repos/Minions-Land/Magenta/releases/latest" | grep -A3 '"name": "magenta-macos"' | grep '"id":' | head -1 | sed -E 's/.*"id": *([0-9]+).*/\1/')
[ -z "$ASSET_ID" ] && echo "❌ 获取失败" && exit 1
mkdir -p ~/.local/bin
echo "📥 下载 Magenta (~73MB)..."
curl -fsSL -H "Authorization: Bearer $MAGENTA_TOKEN" -H "Accept: application/octet-stream" -o ~/.local/bin/magenta "https://api.github.com/repos/Minions-Land/Magenta/releases/assets/$ASSET_ID"
chmod +x ~/.local/bin/magenta
echo "✅ 安装完成！版本: $(~/.local/bin/magenta --version 2>/dev/null)"
echo ""
echo "添加到 PATH:"
echo "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc && source ~/.zshrc"
EOF
)"
```

### Linux

```bash
export MAGENTA_TOKEN="YOUR_TOKEN" && \
bash -c "$(cat <<'EOF'
set -e
ASSET_ID=$(curl -fsSL -H "Authorization: Bearer $MAGENTA_TOKEN" -H "Accept: application/vnd.github+json" "https://api.github.com/repos/Minions-Land/Magenta/releases/latest" | grep -A3 '"name": "magenta-linux"' | grep '"id":' | head -1 | sed -E 's/.*"id": *([0-9]+).*/\1/')
[ -z "$ASSET_ID" ] && echo "❌ 获取失败" && exit 1
mkdir -p ~/.local/bin
echo "📥 下载 Magenta (~73MB)..."
curl -fsSL -H "Authorization: Bearer $MAGENTA_TOKEN" -H "Accept: application/octet-stream" -o ~/.local/bin/magenta "https://api.github.com/repos/Minions-Land/Magenta/releases/assets/$ASSET_ID"
chmod +x ~/.local/bin/magenta
echo "✅ 安装完成！版本: $(~/.local/bin/magenta --version 2>/dev/null)"
echo ""
echo "添加到 PATH:"
echo "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc && source ~/.bashrc"
EOF
)"
```

---

## 📋 安装步骤说明

1. **获取 GitHub Token**
   - 访问：https://github.com/settings/tokens/new
   - 权限勾选：`repo` (访问私有仓库)
   - 生成 token 并复制

2. **运行上面的命令**
   - 替换 `YOUR_TOKEN` 为你的真实 token
   - 粘贴整个代码块到终端
   - 回车运行

3. **添加到 PATH**（如果提示需要）
   ```bash
   # zsh (macOS 默认)
   echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
   source ~/.zshrc
   
   # bash (Linux 常见)
   echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
   source ~/.bashrc
   ```

4. **验证安装**
   ```bash
   magenta --version
   ```

---

## 🎯 这个命令做了什么？

```bash
1. 从 GitHub API 获取最新 release 的 asset ID
2. 下载二进制文件到 ~/.local/bin/magenta
3. 设置可执行权限
4. 验证版本
```

**优点：**
- ✅ 真正的一键安装
- ✅ 不依赖外部脚本文件
- ✅ 支持私有仓库
- ✅ 无需安装任何依赖

---

## 🔄 更新 Magenta

安装后，更新非常简单：

```bash
magenta --update
```

---

## ❓ 常见问题

**Q: 为什么不能用 `curl script.sh | bash`？**

A: 因为私有仓库的脚本文件也无法直接访问，所以需要用自包含的命令。

**Q: Token 会泄露吗？**

A: 不会。Token 只在本地使用，不会发送到除 GitHub 以外的地方。建议使用后：
```bash
unset MAGENTA_TOKEN
```

**Q: 能做成公开仓库吗？**

A: 如果改成公开仓库，就可以用经典的 `curl | bash` 方式了：
```bash
curl -fsSL https://install.magenta.dev/install.sh | bash
```

---

## 🎁 彩蛋：超级简化版

如果你经常安装，可以把命令保存为 alias：

```bash
# 添加到 ~/.zshrc 或 ~/.bashrc
alias install-magenta='export MAGENTA_TOKEN="your_token" && bash -c "$(cat <<EOF
... (完整命令)
EOF
)"'

# 以后只需要运行
install-magenta
```

---

## 📞 需要帮助？

- 查看完整文档：`docs/USER_INSTALL.md`
- 遇到问题：GitHub Issues
