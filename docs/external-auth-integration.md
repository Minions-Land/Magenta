# Magenta 外部认证集成指南

## 概述

Magenta 自动从本地工具读取 API 认证信息，无需手动配置 `/login`。支持的来源（按优先级）：

1. **环境变量** (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.)
2. **Claude Code** (`~/.claude/settings.json`)
3. **OpenAI Codex** (`~/.codex/auth.json` + `~/.codex/config.toml`)

外部工具配置只用于发现凭据和路由信息。Magenta 不会写入、迁移、删除或修改
`~/.codex/auth.json`、`~/.codex/config.toml` 或 Claude Code 配置。通过 Magenta
`/login` 保存的凭据只写入 `~/.magenta/agent/auth.json`。

---

## OpenAI Codex 集成

### 认证模式

Codex 支持 OAuth 和 API Key 两种认证方式，但 Magenta 的外部发现只导入明确配置的
OpenAI API key。两者不能互换。

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
- Magenta 不导入 `access_token`、`refresh_token` 或 `id_token`
- ChatGPT OAuth access token 不是 OpenAI API key，不能发送到公共 OpenAI API
- OAuth 登录继续由 Codex 自己使用；若要在 Magenta 使用订阅登录，请通过 Magenta `/login` 选择其提供的登录方式

仅有 Codex OAuth 登录、没有明确 `OPENAI_API_KEY` 时，Codex 外部发现不会为 Magenta
提供 OpenAI 凭据。

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

[model_providers.custom]
name = "custom"
wire_api = "responses"
base_url = "https://your-proxy.com/v1"
```

**行为**:
- 只读方式读取 `OPENAI_API_KEY`
- 使用活动 `model_provider` 段的 `base_url` 和顶层 `model`
- 未显式选择 `model_provider` 时使用 OpenAI 默认 endpoint，不会从未激活或遗留的 provider 段猜测路由
- 支持兼容的第三方服务，而不改写 Codex 配置

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

**选项 A: 为 Codex 自身使用 OAuth**

```bash
# 登录（会打开浏览器）
codex login

# 检查状态
codex login status
# 应显示: Logged in using ChatGPT
```

该 OAuth 凭据不会被 Magenta 当作 OpenAI API key 导入。

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

[model_providers.custom]
name = "custom"
wire_api = "responses"
base_url = "https://your-service.com/v1"
```

### 3. 验证 Magenta 集成

```bash
node -e "
const { loadExternalAuth } = require('./pi/coding-agent/dist/core/external-auth-loader.js');
console.log('已加载的认证:');
loadExternalAuth().forEach(({ provider, source, baseUrl, model }) => {
  console.log(\`- \${provider} (来源: \${source})\`);
  console.log(\`  路由: \${baseUrl ? '自定义 endpoint' : 'provider 默认 endpoint'}\`);
  console.log(\`  模型元数据: \${model ? '已配置' : '未配置'}\`);
});
"
```

诊断时不要打印 `apiKey` 或整个 credential 对象。

---

## 灵活性设计

### 多来源支持

Magenta 可以同时从多个来源读取认证：

```
优先级: env > claude-code > codex

示例:
  - Anthropic (claude-code) → 使用 tok.fan
  - OpenAI (codex API key) → 使用活动 Codex provider 的 endpoint
  - Google (env)           → 使用环境变量
```

### 自动路由

- **Codex OAuth token** → 不导入
- **API key** → 尊重 `config.toml` 中的自定义配置
- **Magenta `/login` 凭据** → 优先于外部只读来源

### 无感切换

用户或 Codex 修改 `~/.codex/config.toml` 或 `~/.codex/auth.json` 后，Magenta 会在下次
启动或外部凭据缓存刷新后只读加载新配置。Magenta 不会反向保存任何内容到这两个文件。

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

# 仅修复 Codex 自身的 OAuth 登录
codex logout
codex login
```

Codex OAuth 不会修复 Magenta 的 OpenAI API-key 认证；请配置明确的 API key 或通过
Magenta `/login` 登录受支持的订阅 provider。

### Magenta 未读取 Codex

```bash
# 检查文件权限
ls -la ~/.codex/auth.json ~/.codex/config.toml

# 手动测试加载
node -e "
const { loadCodexAuth } = require('./pi/coding-agent/dist/core/external-auth-loader.js');
const loaded = loadCodexAuth();
console.log(loaded.map(({ provider, source, baseUrl, model }) => ({
  provider,
  source,
  customEndpoint: Boolean(baseUrl),
  configuredModel: Boolean(model)
})));
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
  // ChatGPT OAuth access token 不是 OpenAI API key，明确忽略。

  const explicitApiKey = auth.OPENAI_API_KEY || auth.openai?.key;
  if (explicitApiKey) {
    return [{
      provider: "openai",
      apiKey: explicitApiKey,
      baseUrl: parseCodexBaseUrl(toml),
      model: parseCodexModel(toml),
      source: "codex"
    }];
  }

  return [];
}
```

加载器仅导入 `node:fs` 的 `existsSync` 和 `readFileSync` 访问这些外部文件。保存、刷新和
注销操作只作用于 Magenta 自己的 `~/.magenta/agent/auth.json`。

---

## 未来改进

- [ ] 支持从 codex 读取多个 provider（当前只支持 openai）
- [ ] 评估原生 `openai-codex` OAuth provider 集成（不得把 token 降级为 API key）
- [ ] 增加 `MAGENTA_CODEX_DISABLE` 环境变量来禁用集成
- [ ] 记录外部认证来源到日志

---

**最后更新**: 2026-07-22

**作者**: Magenta Team
