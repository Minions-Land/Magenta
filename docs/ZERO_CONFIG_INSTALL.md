# ⚡ Magenta 零配置安装

## 🚀 一行命令，复制粘贴即用

```bash
bash << 'INSTALL_SCRIPT'
TOKEN="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"
ASSET_ID=$(curl -fsSL -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" "https://api.github.com/repos/Minions-Land/Magenta/releases/latest" | grep -B5 '"name": "magenta-macos"' | grep '"id":' | head -1 | grep -o '[0-9]\+') && \
mkdir -p ~/.local/bin && \
echo "📥 下载 Magenta (~73MB)..." && \
curl -fsSL -H "Authorization: Bearer $TOKEN" -H "Accept: application/octet-stream" -o ~/.local/bin/magenta "https://api.github.com/repos/Minions-Land/Magenta/releases/assets/$ASSET_ID" && \
chmod +x ~/.local/bin/magenta && \
echo "✅ 安装完成！" && \
echo "" && \
~/.local/bin/magenta --version && \
echo "" && \
echo "运行 'magenta' 开始使用（可能需要添加到 PATH）" && \
echo "添加到 PATH: echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc && source ~/.zshrc"
INSTALL_SCRIPT
```

---

## 🎉 就这么简单！

用户只需要：
1. ✅ 复制上面的命令
2. ✅ 粘贴到终端
3. ✅ 回车

**不需要：**
- ❌ 生成 GitHub Token
- ❌ 配置任何环境变量
- ❌ 安装 Node.js
- ❌ 下载脚本文件

---

## 🔒 安全说明

### Token 权限
这个内嵌的 token 有以下权限：
- ✅ 读取 `Minions-Land/Magenta` 仓库的 releases
- ✅ 下载二进制文件
- ⚠️ 访问该仓库的其他内容

### 风险与权衡

**Token 可见性：**
- 这个 token 明文写在安装命令里
- 任何看到这条命令的人都能拿到 token
- 二进制文件里也包含这个 token（用于自动更新）
- 可以用 `strings magenta | grep ghp_` 提取出来

**适用场景：**
- ✅ **内部团队使用**（信任的用户）
- ✅ **非敏感项目**
- ✅ **快速分发优先于严格权限控制**

**不适合：**
- ❌ 公开分发给不信任的用户
- ❌ 包含高度敏感代码的项目

### 降低风险的建议

1. **使用细粒度 token（GitHub Fine-grained tokens）**
   - 只授予 `Minions-Land/Magenta` 仓库访问权限
   - 只授予 `Contents: Read-only` 权限
   - 设置过期时间

2. **定期轮换 token**
   - 每次发布新版本时更新 token
   - 旧 token 失效后自动更新系统仍然能工作（用户会更新到带新 token 的版本）

3. **改为公开仓库（终极方案）**
   - 如果不需要私有，改成公开仓库
   - 就完全不需要 token 了
   - 安装命令可以简化为：`curl -fsSL https://install.magenta.dev | bash`

---

## 🔄 安装后的更新

安装完成后，更新完全自动化，用户不用管 token：

```bash
magenta --update
```

因为二进制里已经内嵌了 token，会自动：
1. 检查 GitHub 最新版本
2. 下载新版本
3. 替换旧版本
4. 备份和回滚机制

---

## 💡 为什么私有仓库必须有 Token？

**技术限制：**
- GitHub API 要求私有仓库的所有访问都需要认证
- 无法绕过，无法"藏起来不让用户知道"
- 用户手上没有二进制前，必须有某个 token 去下载二进制

**解决方案权衡：**

| 方案 | 用户体验 | 安全性 |
|------|---------|--------|
| 用户自己生成 token | 😕 需要操作 | ✅ 高（token 私有） |
| 内嵌我们的 token | 😊 零配置 | ⚠️ 中（token 可见） |
| 改为公开仓库 | 😍 完美 | ✅ 完美（无 token） |

---

## ✅ 推荐做法

**当前（私有仓库）：**
- 使用上面的零配置安装命令
- 定期轮换 token
- 只分发给信任的用户

**长期（如果可以）：**
- 考虑改为公开仓库
- 或者使用 GitHub App 替代 Personal Access Token（更安全）

---

## 📝 总结

✅ **是的，可以让用户完全不用管 token**
✅ **复制粘贴一行命令即可安装**
⚠️ **但要理解这个权衡：便利性 vs 安全性**

如果你的使用场景是内部团队或信任的用户，这个方案完全没问题。
