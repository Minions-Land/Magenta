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

## 🔒 隐私与安全

### 源码私有，二进制公开

- **源码仓库**：`Minions-Land/Magenta`（私有，只有团队可访问）
- **发布仓库**：`Minions-Land/Magenta-CLI`（公开，只包含编译后的二进制）

**用户只能下载二进制文件，看不到源代码。**

### 无凭证泄露

- 二进制里**没有内嵌任何 GitHub Token**
- 更新下载是匿名的（公开仓库 releases）
- 无法通过二进制逆向获得源码访问权限

---

## 📝 技术说明

### 为什么不需要 Token？

因为二进制发布在**公开仓库** `Minions-Land/Magenta-CLI`。

GitHub 的公开仓库 releases 可以匿名下载：
```bash
# 任何人都可以这样下载，无需认证
curl -L https://github.com/公开仓库/releases/latest/download/文件名
```

### 源码如何保护？

源码在**私有仓库** `Minions-Land/Magenta`，访问需要权限。

发布仓库 `Magenta-CLI` 只有：
- ✅ Release assets（二进制文件）
- ❌ 没有源码
- ❌ 没有 .git 历史
- ❌ 没有任何可以追溯到私有仓库的信息

### 二进制能被逆向吗？

所有编译后的二进制理论上都能被逆向，但：
- 困难度高（没有符号表，代码被混淆）
- 成本远高于从头实现相似功能
- 核心业务逻辑可以用更强的保护措施（代码混淆、关键逻辑服务端化等）

这是业界标准做法：VS Code、Claude CLI、GitHub CLI 等都是这样发布的。

---

## 🎯 与之前方案的对比

| 方案 | 用户体验 | 安全性 | 源码保护 |
|------|---------|--------|---------|
| **旧方案：私有仓库 + 内嵌 token** | 😕 需要 token | ⚠️ token 可提取 | ❌ token 能读源码 |
| **新方案：公开二进制仓库** | 😍 完全匿名 | ✅ 无凭证泄露 | ✅ 完全隔离 |

---

## ✅ 总结

**现在的方案是：**
- ✅ 用户无需 GitHub Token
- ✅ 用户无需安装任何工具
- ✅ 用户看不到源代码
- ✅ 一行命令完成安装和更新
- ✅ 无任何凭证泄露风险

**这就是你要的理想方案。** 🎉
