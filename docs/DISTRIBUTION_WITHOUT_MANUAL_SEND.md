# Magenta 用户分发方案 - 无需手动发送二进制

## 🎯 核心思路

用户通过**一条命令**或**一个网页链接**直接安装，无需你手动发送二进制文件。

---

## ⭐ 推荐方案：托管安装脚本

### 步骤 1：准备安装脚本

编辑 `scripts/remote-install.sh`，填入你的配置：

```bash
GITHUB_REPO="your-org/magenta3"  # 你的 GitHub 仓库
GITHUB_TOKEN="ghp_xxxxxxxxxxxx"   # 你的 GitHub Token
```

### 步骤 2：托管脚本（选择一种）

#### 选项 A：使用 GitHub Gist（最简单，免费）

1. 访问 https://gist.github.com/
2. 创建新 Gist
3. 文件名：`magenta-install.sh`
4. 内容：复制 `scripts/remote-install.sh` 的内容
5. 创建后，点击 "Raw" 按钮，复制 URL

得到类似：
```
https://gist.githubusercontent.com/username/abc123/raw/magenta-install.sh
```

#### 选项 B：使用阿里云 OSS / 腾讯云 COS

```bash
# 上传到对象存储（设置为公开读）
aliyun oss cp scripts/remote-install.sh oss://your-bucket/magenta-install.sh
```

得到：
```
https://your-bucket.oss-cn-beijing.aliyuncs.com/magenta-install.sh
```

#### 选项 C：自己的服务器

```bash
# 上传到服务器
scp scripts/remote-install.sh user@your-server.com:/var/www/html/

# 配置 Nginx
# location /magenta-install.sh {
#   alias /var/www/html/magenta-install.sh;
# }
```

得到：
```
https://your-domain.com/magenta-install.sh
```

### 步骤 3：给用户安装命令

告诉用户运行这条命令：

```bash
curl -fsSL https://your-url/magenta-install.sh | bash
```

**就这么简单！** 脚本会自动：
- 检测操作系统
- 从 GitHub Releases 下载最新版本
- 安装到 `~/.local/bin/magenta`
- 提示用户配置 PATH

---

## 🌐 可选：制作下载网页

如果想要更友好的用户界面，可以部署 `scripts/download-page.html`：

### 效果预览

```
┌──────────────────────────────────┐
│       🚀 Magenta                 │
│   AI 驱动的终端编码助手           │
│                                  │
│  ┌──────────────────────────┐   │
│  │ curl ... | bash   [复制] │   │
│  └──────────────────────────┘   │
│                                  │
│  ① 复制安装命令                  │
│  ② 打开终端                      │
│  ③ 粘贴并运行                    │
│                                  │
│  [手动下载]  [使用文档]          │
│                                  │
│  最新版本: v0.80.3              │
└──────────────────────────────────┘
```

### 部署

```bash
# 编辑 download-page.html，修改安装脚本 URL
vim scripts/download-page.html
# 找到: https://your-server.com/magenta-install.sh
# 改成你的实际 URL

# 上传到静态网站托管
# GitHub Pages / Vercel / Netlify / 对象存储
```

用户访问：`https://your-domain.com/magenta.html`

---

## 🔄 完整工作流

### 开发者（你）

**首次配置**：
```bash
# 1. 设置环境变量
export MAGENTA_GITHUB_REPO="your-org/magenta3"
export MAGENTA_GITHUB_TOKEN="ghp_xxxx"

# 2. 编辑并上传安装脚本
vim scripts/remote-install.sh  # 填入 repo 和 token
# 上传到 Gist 或服务器
```

**发布新版本**：
```bash
# 一键发布到 GitHub Releases
./scripts/release-to-github.sh 0.80.4 "修复某个 bug"

# 用户会自动看到更新提示！
```

### 用户

**首次安装**：
```bash
# 运行你给的命令
curl -fsSL https://your-url/magenta-install.sh | bash

# 完成！
magenta --version
```

**日常更新**：
```bash
# 启动时自动提示
magenta
💡 新版本 v0.80.4 可用，运行 'magenta --update' 升级

# 一键更新
magenta --update
```

---

## 📊 方案对比总结

| 操作 | 原方案（手动发二进制） | 新方案（托管安装脚本） |
|------|---------------------|-------------------|
| **首次安装** | 发送文件 → 用户手动复制 | 一条命令 |
| **版本更新** | 重新发送文件 | `magenta --update` |
| **新用户加入** | 再次发送文件 | 发送安装命令 |
| **多平台支持** | 发送多个文件 | 自动检测平台 |
| **用户心智负担** | 需要记住安装位置 | 零心智 |

---

## 🔒 安全性说明

1. **GitHub Token 在脚本中**
   - ✅ 用户看不到源代码
   - ✅ Token 只有 `repo` 读权限
   - ⚠️ 任何人都能下载安装脚本（如果公开托管）
   - 💡 建议：定期轮换 Token

2. **HTTPS 必须**
   - ✅ 使用 `curl -fsSL`（会验证 SSL）
   - ❌ 不要用 HTTP（易被劫持）

3. **脚本审查**
   - 用户可以先下载脚本查看：`curl https://your-url/install.sh`
   - 透明度更高

---

## 🎉 快速测试

1. **创建 Gist**：把 `scripts/remote-install.sh` 上传到 Gist
2. **测试安装**：在另一台机器运行 `curl ... | bash`
3. **验证更新**：运行 `magenta --update`

搞定！🚀

---

## 常见问题

**Q: 用户没有 curl 怎么办？**
A: 现代 macOS 和 Linux 都预装了 curl。如果没有，可以用 `wget`：
```bash
wget -qO- https://your-url/install.sh | bash
```

**Q: Token 泄露怎么办？**
A: 立即在 GitHub 撤销旧 Token，生成新 Token，更新安装脚本。

**Q: 能支持 Windows 吗？**
A: 可以，但需要单独的 PowerShell 安装脚本。目前主要支持 macOS/Linux。

**Q: 私有 Gist 可以用吗？**
A: 不行，私有 Gist 的 raw URL 需要认证。必须用公开 Gist 或自己的服务器。
