# Magenta 外部认证集成指南

## 概述

Magenta 自动从本地工具读取 API 认证信息，无需手动配置 `/login`。支持的来源（按优先级）：

1. **环境变量** (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.)
2. **Claude Code** (`~/.claude/settings.json`)
3. **OpenAI Codex** (`~/.codex/auth.json` + `~/.codex/config.toml`)

---

## OpenAI Codex 集成

### 认证模式

Codex 支持两种认证方式，Magenta 会自动识别：

#### 1. OAuth 模式（ChatGPT Plus/Pro）

**位置**: `~/.codex/auth.json`

```json
{
  "auth_mode": "chatgpt",
  "tokens": {
    "access_token": "eyJhbGc...",
    "refresh_token": "...",
    "id_token": "..."
  }
}
```

**行为**:
- ✅ Magenta 读取 `access_token` 作为 OpenAI API key
- ✅ **自动忽略** `config.toml` 中的自定义 `base_url`（OAuth token 只能用于官方 API）
- ✅ 使用 Magenta 的默认模型配置

**适用场景**:
- 使用师兄/朋友共享的 ChatGPT Pro 账号
- 不需要第三方中转服务

#### 2. API Key 模式（标准 OpenAI API Key）

**位置**: `~/.codex/auth.json`

```json
{
  "OPENAI_API_KEY": "sk-proj-xxx..."
}
```

**配置**: `~/.codex/config.toml`

```toml
model_provider = "custom"
model = "gpt-4"
base_url = "https://your-proxy.com/v1"
```

**行为**:
- ✅ 读取 `OPENAI_API_KEY`
- ✅ **使用** `config.toml` 中的自定义 `base_url` 和 `model`
- ✅ 支持第三方中转服务（如 tok.fan）

**适用场景**:
- 使用标准 OpenAI API key
- 需要通过代理/中转服务访问

---

## 安装和配置

### 1. 安装 Codex

```bash
npm install -g @openai/codex@latest --registry=https://registry.npmmirror.com
```

或使用代理：

```bash
npm install -g @openai/codex@latest --proxy http://127.0.0.1:7897
```

### 2. 配置认证

**选项 A: 使用 OAuth（推荐，如果有 ChatGPT Plus/Pro）**

```bash
# 登录（会打开浏览器）
codex login

# 检查状态
codex login status
# 应显示: Logged in using ChatGPT
```

**选项 B: 使用 API Key + 自定义服务**

创建 `~/.codex/auth.json`:
```json
{
  "OPENAI_API_KEY": "sk-xxx..."
}
```

创建 `~/.codex/config.toml`:
```toml
model_provider = "custom"
model = "gpt-4"
base_url = "https://your-service.com/v1"
```

### 3. 验证 Magenta 集成

```bash
node -e "
const { loadExternalAuth } = require('./pi/coding-agent/dist/core/external-auth-loader.js');
console.log('已加载的认证:');
loadExternalAuth().forEach(c => {
  console.log(\`- \${c.provider} (来源: \${c.source})\`);
  console.log(\`  Base URL: \${c.baseUrl || '官方默认'}\`);
});
"
```

---

## 灵活性设计

### 多来源支持

Magenta 可以同时从多个来源读取认证：

```
优先级: env > claude-code > codex

示例:
  - Anthropic (claude-code) → 使用 tok.fan
  - OpenAI (codex OAuth)   → 使用官方 API
  - Google (env)           → 使用环境变量
```

### 自动路由

- **OAuth token** → 强制使用官方 OpenAI API
- **API key** → 尊重 `config.toml` 中的自定义配置
- **无配置冲突** → OAuth 和自定义服务可以共存（不同 provider）

### 无感切换

修改 `~/.codex/config.toml` 或 `~/.codex/auth.json` 后，Magenta 会在下次启动时自动加载新配置。

---

## 故障排查

### Codex 启动失败

```bash
# 检查安装
codex --version
npm ls -g @openai/codex @openai/codex-darwin-arm64

# 运行诊断
codex doctor
```

### 认证失败

```bash
# 检查登录状态
codex login status

# OAuth token 过期？重新登录
codex logout
codex login

# 检查 token 有效期
node -e "
const fs = require('fs');
const auth = JSON.parse(fs.readFileSync(process.env.HOME + '/.codex/auth.json', 'utf-8'));
if (auth.tokens?.access_token) {
  const payload = JSON.parse(Buffer.from(auth.tokens.access_token.split('.')[1], 'base64'));
  console.log('Token expires:', new Date(payload.exp * 1000));
  console.log('Is expired:', Date.now() > payload.exp * 1000);
}
"
```

### Magenta 未读取 Codex

```bash
# 检查文件权限
ls -la ~/.codex/auth.json ~/.codex/config.toml

# 手动测试加载
node -e "
const { loadCodexAuth } = require('./pi/coding-agent/dist/core/external-auth-loader.js');
console.log(JSON.stringify(loadCodexAuth(), null, 2));
"
```

---

## 实现细节

### 代码位置

- **外部认证加载器**: `pi/coding-agent/src/core/external-auth-loader.ts`
- **模型注册器集成**: `pi/coding-agent/src/core/model-registry.ts:481`

### 关键逻辑

```typescript
export function loadCodexAuth(): ExternalCredential[] {
  // 1. 检测 OAuth token
  if (auth.auth_mode === "chatgpt" && auth.tokens?.access_token) {
    return [{
      provider: "openai",
      apiKey: auth.tokens.access_token,
      baseUrl: undefined,  // 强制官方 API
      source: "codex"
    }];
  }

  // 2. 检测 API key
  if (auth.OPENAI_API_KEY) {
    return [{
      provider: "openai",
      apiKey: auth.OPENAI_API_KEY,
      baseUrl: parseCodexBaseUrl(config.toml),  // 使用自定义
      model: parseCodexModel(config.toml),
      source: "codex"
    }];
  }
}
```

---

## 未来改进

- [ ] 支持从 codex 读取多个 provider（当前只支持 openai）
- [ ] 支持 token 自动刷新
- [ ] 增加 `MAGENTA_CODEX_DISABLE` 环境变量来禁用集成
- [ ] 记录外部认证来源到日志

---

**最后更新**: 2026-07-16

**作者**: Magenta Team
