# 推理模型 Thinking Level 支持完整修复

## 修复内容

### 1. 修复内置模型的 thinkingLevelMap 配置 ✅

**文件**: `pi/ai/scripts/generate-models.ts`

**添加的常量**:
- `ANTHROPIC_EXTENDED_THINKING_LEVEL_MAP`: 标准 Anthropic extended thinking 模型
- `ANTHROPIC_OPUS_46_THINKING_LEVEL_MAP`: Opus 4.6 专用（使用 `max` 而非 `xhigh`）
- `OPENAI_STANDARD_THINKING_LEVEL_MAP`: 标准 OpenAI 推理模型（o1, o3, o4 等）
- `OPENAI_XHIGH_THINKING_LEVEL_MAP`: 支持 xhigh 的 OpenAI 模型（GPT-5.2+）

**更新的函数**:
- `isAnthropicAdaptiveThinkingModel()`: 增加 `sonnet-5` 支持
- `isAnthropicExtendedThinkingModel()`: 新增，覆盖所有 extended thinking 模型
  - 修复了 ID 格式匹配问题（如 `3-7-sonnet`, `4-5-haiku` 等）
- `applyThinkingLevelMetadata()`: 系统化应用 thinkingLevelMap

**覆盖的模型**:
- **Anthropic**: Sonnet 3.7, 4.0-4.6, 5 / Opus 4.0-4.8 / Haiku 4.5 / Fable 5
- **OpenAI**: o1, o3, o4, gpt-5.x 系列

### 2. 修复 agent-session.ts 的 fallback 数组 ✅

**文件**: `pi/coding-agent/src/core/agent-session.ts`

**问题**: `THINKING_LEVELS` 常量缺少 `xhigh`，导致即使模型支持也无法选择

**修复**: 
```typescript
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
```

### 3. 智能推断自定义模型的 thinkingLevelMap ✅

**文件**: `pi/coding-agent/src/core/model-registry.ts`

**新增功能**: `inferThinkingLevelMap()` 函数

当用户在 `models.json` 中配置自定义模型但未显式指定 `thinkingLevelMap` 时，系统会根据模型 ID 和 API 类型自动推断：

#### Anthropic 模型推断规则:
```typescript
// Opus 4.6 特殊处理
"opus-4-6" | "opus-4.6" 
  → { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "max" }

// 所有其他 extended thinking 模型
"sonnet-3.7" | "sonnet-4.x" | "sonnet-5" | "opus-4.x" | "haiku-4.5" | "fable-5"
  → { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh" }
```

#### OpenAI 模型推断规则:
```typescript
// GPT-5.2+ 支持 xhigh
"gpt-5.2" | "gpt-5.3" | "gpt-5.4" | "gpt-5.5"
  → { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh" }

// 标准推理模型
"o1" | "o3" | "o4" | "gpt-5.x"
  → { off: null, minimal: "low", low: "low", medium: "medium", high: "high" }
```

## 用户使用示例

### 场景 1: 使用内置模型
```bash
# 直接使用，thinking levels 自动配置正确
pi -m anthropic:claude-sonnet-5
# Shift+Tab: off → minimal → low → medium → high → xhigh → off ✅
```

### 场景 2: 自定义 OpenAI 兼容 API
**~/.pi/agent/models.json**:
```json
{
  "providers": [{
    "id": "my-api",
    "baseUrl": "https://api.mycompany.com/v1",
    "apiKey": "${MY_API_KEY}",
    "models": [{
      "id": "o1-custom",
      "name": "My O1 Model",
      "reasoning": true
      // thinkingLevelMap 自动推断为标准 OpenAI (low/medium/high)
    }, {
      "id": "gpt-5.3-enterprise",
      "name": "GPT-5.3 Enterprise",
      "reasoning": true
      // thinkingLevelMap 自动推断为 xhigh 支持版本
    }]
  }]
}
```

### 场景 3: 自定义 Anthropic 兼容 API
```json
{
  "providers": [{
    "id": "my-claude",
    "api": "anthropic-messages",
    "baseUrl": "https://api.mycompany.com",
    "apiKey": "${CLAUDE_KEY}",
    "models": [{
      "id": "claude-sonnet-5-custom",
      "name": "Custom Sonnet 5",
      "reasoning": true
      // thinkingLevelMap 自动推断为完整 extended thinking 支持
    }]
  }]
}
```

### 场景 4: 手动覆盖推断结果
```json
{
  "providers": [{
    "id": "my-api",
    "baseUrl": "https://api.example.com/v1",
    "apiKey": "test",
    "models": [{
      "id": "custom-model",
      "reasoning": true,
      "thinkingLevelMap": {
        "off": null,
        "low": "low",
        "high": "high"
      }
      // 显式配置优先级高于自动推断
    }]
  }]
}
```

## 技术实现细节

### 推断触发时机
在两个位置应用推断逻辑：

1. **`parseModels()`**: 解析 `models.json` 中的自定义 provider 配置
2. **`applyProviderConfig()`**: 应用 `providerOverrides` 配置

```typescript
const reasoning = modelDef.reasoning ?? false;
const thinkingLevelMap = 
  modelDef.thinkingLevelMap ?? inferThinkingLevelMap(modelDef.id, api, reasoning);
```

### 优先级规则
1. **显式配置**: `models.json` 中显式指定 `thinkingLevelMap`
2. **自动推断**: 根据模型 ID 和 API 类型推断
3. **无配置**: `undefined`（模型不支持 thinking levels）

## 测试验证

### 验证命令
```bash
# 1. 重新生成模型
cd pi/ai && npm run generate-models

# 2. 重新构建
cd pi/ai && npm run build
cd pi/coding-agent && npm run build

# 3. 重启 Magenta
# 4. 测试 Shift+Tab 循环 thinking levels
```

### 预期结果
- ✅ Claude Sonnet 5: 6 个级别（off/minimal/low/medium/high/xhigh）
- ✅ Claude Opus 4.6: xhigh 映射到 "max"
- ✅ OpenAI o1: 5 个级别（off/minimal/low/medium/high）
- ✅ GPT-5.2+: 6 个级别（包含 xhigh）
- ✅ 自定义模型: 根据 ID 自动推断正确的 thinkingLevelMap

## 相关文件清单

### 修改的文件
1. `pi/ai/scripts/generate-models.ts` - 模型生成脚本
2. `pi/ai/src/providers/*.models.ts` - 生成的模型定义（自动生成）
3. `pi/coding-agent/src/core/agent-session.ts` - Agent 会话管理
4. `pi/coding-agent/src/core/model-registry.ts` - 模型注册表

### 构建产物
1. `pi/ai/dist/**/*.js` - 编译后的 AI 模块
2. `pi/coding-agent/dist/**/*.js` - 编译后的 Agent 模块

## 后续优化建议

1. **API 自动发现**: 调用 OpenAI `/v1/models` 或 Anthropic API 动态获取模型能力
2. **配置验证**: 在 TUI 中显示推断结果，帮助用户验证配置
3. **文档更新**: 在用户文档中说明自动推断机制
4. **更多模型**: 扩展推断逻辑支持更多 provider（DeepSeek, Gemini 等）

---

**修复完成时间**: 2026-07-03
**修复范围**: 完整的 thinking level 支持（内置模型 + 自定义模型）
**用户体验**: 无需手动配置，智能推断正确的推理强度级别
