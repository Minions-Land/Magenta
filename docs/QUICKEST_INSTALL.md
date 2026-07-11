# ⚡ Magenta 极简安装

## 🎯 一行命令安装

**步骤 1：获取你的 GitHub Token**
- 访问：https://github.com/settings/tokens/new
- 勾选 `repo` 权限
- 生成并复制 token

**步骤 2：复制下面的命令，替换 `YOUR_TOKEN_HERE`，粘贴到终端运行**

### macOS
```bash
TOKEN="YOUR_TOKEN_HERE" bash << 'INSTALL_SCRIPT'
ASSET_ID=$(curl -fsSL -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" "https://api.github.com/repos/Minions-Land/Magenta/releases/latest" | grep -B5 '"name": "magenta-macos"' | grep '"id":' | head -1 | grep -o '[0-9]\+') && \
mkdir -p ~/.local/bin && \
echo "📥 下载中 (~73MB)..." && \
curl -fsSL -H "Authorization: Bearer $TOKEN" -H "Accept: application/octet-stream" -o ~/.local/bin/magenta "https://api.github.com/repos/Minions-Land/Magenta/releases/assets/$ASSET_ID" && \
chmod +x ~/.local/bin/magenta && \
echo "✅ 安装完成！版本: $(~/.local/bin/magenta --version)" && \
echo "" && \
echo "运行: ~/.local/bin/magenta 或添加到 PATH:" && \
echo "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc && source ~/.zshrc"
INSTALL_SCRIPT
```

### Linux
```bash
TOKEN="YOUR_TOKEN_HERE" bash << 'INSTALL_SCRIPT'
ASSET_ID=$(curl -fsSL -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" "https://api.github.com/repos/Minions-Land/Magenta/releases/latest" | grep -B5 '"name": "magenta-linux"' | grep '"id":' | head -1 | grep -o '[0-9]\+') && \
mkdir -p ~/.local/bin && \
echo "📥 下载中 (~73MB)..." && \
curl -fsSL -H "Authorization: Bearer $TOKEN" -H "Accept: application/octet-stream" -o ~/.local/bin/magenta "https://api.github.com/repos/Minions-Land/Magenta/releases/assets/$ASSET_ID" && \
chmod +x ~/.local/bin/magenta && \
echo "✅ 安装完成！版本: $(~/.local/bin/magenta --version)" && \
echo "" && \
echo "运行: ~/.local/bin/magenta 或添加到 PATH:" && \
echo "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc && source ~/.bashrc"
INSTALL_SCRIPT
```

---

## 🎉 安装完成后

```bash
# 方式 1：直接运行（无需配置 PATH）
~/.local/bin/magenta --version

# 方式 2：添加到 PATH（推荐）
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc  # macOS
source ~/.zshrc

# 然后就可以直接用
magenta --version
magenta --help
magenta --update
```

---

## 💡 这就是你要的"一键安装"

✅ **不需要下载脚本文件**
✅ **不需要克隆仓库**
✅ **不需要安装 Node.js**
✅ **不需要安装任何依赖**

只需要：
1. 复制命令
2. 替换 token
3. 粘贴运行

搞定！🚀

---

## 📝 技术说明

这个单行命令做了：
1. 调用 GitHub API 获取最新 release
2. 提取 `magenta-macos` 的 asset ID
3. 下载二进制到 `~/.local/bin/magenta`
4. 设置可执行权限
5. 显示版本

**为什么不能更简单（比如 curl script.sh | bash）？**

因为 Magenta 是私有仓库：
- `raw.githubusercontent.com` 无法直接访问私有仓库文件（返回 404）
- 必须通过 GitHub API + Token 认证才能下载任何内容
- 所以命令本身要包含认证逻辑，不能只是"下载并运行一个脚本"

如果未来仓库改成公开，就能简化成：
```bash
curl -fsSL https://install.magenta.dev | bash
```

但现在这已经是私有仓库能做到的**最简方案**——一段命令，复制粘贴，完成。

---

## 🔄 更新

安装后，更新只需一行：
```bash
magenta --update
```
