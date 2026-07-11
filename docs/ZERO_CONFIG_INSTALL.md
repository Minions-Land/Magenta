# ⚡ Magenta 零配置安装

## 🚀 真正的一键安装（无需 GitHub Token）

**Magenta 二进制文件发布在公开仓库，任何人都可以匿名下载。**

### macOS
```bash
curl -fsSL https://github.com/Minions-Land/Magenta-CLI/releases/latest/download/magenta-macos -o magenta && \
chmod +x magenta && \
./magenta --version
```

### Linux
```bash
curl -fsSL https://github.com/Minions-Land/Magenta-CLI/releases/latest/download/magenta-linux -o magenta && \
chmod +x magenta && \
./magenta --version
```

### 安装到系统路径
```bash
# 下载
curl -fsSL https://github.com/Minions-Land/Magenta-CLI/releases/latest/download/magenta-macos -o ~/.local/bin/magenta && \
chmod +x ~/.local/bin/magenta

# 添加到 PATH（如果需要）
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc

# 验证
magenta --version
```

---

## 🎉 就这么简单！

用户只需要：
1. ✅ 复制一行命令
2. ✅ 粘贴到终端
3. ✅ 回车

**完全不需要：**
- ❌ GitHub Token
- ❌ 配置任何环境变量
- ❌ 安装 Node.js / Bun / Rust
- ❌ 下载脚本文件
- ❌ 克隆仓库

---

## 🔄 自动更新

安装后，更新也是一行命令：

```bash
magenta --update
```

更新过程：
1. 🔍 自动检查 GitHub 最新版本
2. 📥 匿名下载新版本（无需 token）
3. 💾 自动备份旧版本
4. ✅ 原子替换，失败自动回滚

---

## 🔒 安全

### 无凭证泄露

- 二进制里**没有内嵌任何 GitHub Token**
- 下载和更新都是匿名的（公开仓库 releases）
- 不需要用户提供或保管任何凭证

---

## 📝 技术说明

### 为什么不需要 Token？

因为二进制发布在**公开仓库** `Minions-Land/Magenta-CLI`。

GitHub 的公开仓库 releases 可以匿名下载：
```bash
# 任何人都可以这样下载，无需认证
curl -L https://github.com/Minions-Land/Magenta-CLI/releases/latest/download/magenta-macos
```

### 安装与更新都很简单

- 安装：一行 `curl` 命令下载二进制
- 更新：`magenta --update` 从同一个公开仓库匿名拉取最新版本
- 无任何需要配置的凭证

---

## ✅ 总结

**现在的方案是：**
- ✅ 用户无需 GitHub Token
- ✅ 用户无需安装任何工具
- ✅ 一行命令完成安装和更新
- ✅ 无任何凭证泄露风险

**这就是你要的理想方案。** 🎉
