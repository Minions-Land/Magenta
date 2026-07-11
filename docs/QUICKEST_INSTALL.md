# ⚡ Magenta 极简安装

## 🎯 一行命令安装（无需 Token）

二进制发布在公开仓库，直接匿名下载即可。

### macOS
```bash
curl -fsSL https://github.com/Minions-Land/Magenta-CLI/releases/latest/download/magenta-macos -o ~/.local/bin/magenta && chmod +x ~/.local/bin/magenta && ~/.local/bin/magenta --version
```

### Linux
```bash
curl -fsSL https://github.com/Minions-Land/Magenta-CLI/releases/latest/download/magenta-linux -o ~/.local/bin/magenta && chmod +x ~/.local/bin/magenta && ~/.local/bin/magenta --version
```

> 提示：如果 `~/.local/bin` 目录不存在，先运行 `mkdir -p ~/.local/bin`。

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

✅ **不需要 GitHub Token**
✅ **不需要下载脚本文件**
✅ **不需要克隆仓库**
✅ **不需要安装 Node.js**
✅ **不需要安装任何依赖**

只需要：
1. 复制命令
2. 粘贴运行

搞定！🚀

---

## 📝 技术说明

这个命令直接从公开仓库 `Minions-Land/Magenta-CLI` 的最新 release 下载对应平台的二进制。

GitHub 公开仓库的 release assets 可以匿名下载（`releases/latest/download/<文件名>`），所以整条命令不需要任何认证。

---

## 🔄 更新

安装后，更新只需一行：
```bash
magenta --update
```

（自更新会从同一个公开仓库匿名拉取最新版本，同样无需 token。）
