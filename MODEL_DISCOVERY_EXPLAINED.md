# Magenta 模型发现和推理强度机制详解

## 问题 1: 我们的 Provider 如何发现模型？

### 答案：**预先抓取 + 静态生成**

**不是**实时根据 Key 和 URL 自动发现，而是：

1. **构建时从外部 API 抓取模型列表**
   - `scripts/generate-models.ts` 在 `npm run build` 时运行
   - 从以下来源抓取模型信息：
     - **models.dev API** (https://models.dev/api.json) - 主要来源
     - **OpenRouter API** (https://openrouter.ai/api/v1/models)
     - **NVIDIA NIM API**
     - **Vercel AI Gateway API**

2. **生成静态模型文件**
   ```
   pi/ai/src/providers/anthropic.models.ts    ← Anthropic 官方模型
   pi/ai/src/providers/openai.models.ts        ← OpenAI 官方模型
   pi/ai/src/providers/openrouter.models.ts    ← OpenRouter 聚合模型
   ... (35 个 provider 的 catalog)
   ```

3. **用户看到新模型的时机**
   - models.dev 更新了 Sonnet 5 信息
   - Magenta 项目重新构建（`npm run build`）
   - 用户更新 Magenta 版本
   - → 用户就能看到 Sonnet 5 了

### 为什么这样设计？

**优点**：
- ✅ 快速：无需每次启动时调用 API
- ✅ 离线可用：没有网络也能看到模型列表
- ✅ 类型安全：TypeScript 编译时就知道所有模型
- ✅ 成本低：不会频繁调用 provider API

**缺点**：
- ❌ 需要重新构建才能看到新模型
- ❌ 自定义 URL 的模型无法自动发现

### 自定义模型的处理

对于用户在 `~/.pi/agent/models.json` 中配置的自定义 provider：

```json
{
  "providers": [{
    "id": "my-openai",
    "baseUrl": "https://my-custom-api.com/v1",
    "apiKey": "${MY_KEY}",
    "models": [
      {"id": "my-model", "reasoning": true}  // 用户手动定义
    ]
  }]
}
```

- **不会**自动调用 `https://my-custom-api.com/v1/models` 发现模型
- 用户需要**手动列出**所有想用的模型
- 但 `thinkingLevelMap` 会**智能推断**（这是我们今天加的功能！）

---

## 问题 2: Claude Code 中的 "Max" 和 "Ultracode" 模式

### 调查结果

在我们的代码中搜索后：
- ✅ **找到了 "max"**: Opus 4.6 专用的最高推理级别
- ❌ **没有找到 "ultracode"**: 这不是 Anthropic 官方 API 的参数

### Anthropic 官方推理强度级别

根据 `src/api/anthropic-messages.ts` 中的定义：

```typescript
export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";
```

**官方说明**：
- **"max"**: 无限制地思考（**仅 Opus 4.6 支持**）
- **"xhigh"**: 最高推理级别（Opus 4.7+、Fable 5）
- **"high"**: 总是思考，深度推理
- **"medium"**: 适度思考，简单查询可能跳过
- **"low"**: 最少思考，简单任务跳过

### "Ultracode" 的可能来源

**猜测 1**: Claude Code 的 UI 包装
- Claude Code 可能在 UI 层把 "max" 或 "xhigh" 显示为 "Ultracode"
- 底层仍然使用标准 API 参数

**猜测 2**: Claude Code 特有的预设配置
- 可能是 "xhigh" + 特定 system prompt 的组合
- 针对编程任务优化

**猜测 3**: Beta 功能或误报
- 可能是实验性功能
- 或者是 UI bug 显示了内部开发代码

### 如何验证？

1. **抓包查看实际 API 请求**：
   ```bash
   # 在使用 Claude Code 时查看网络请求
   # 看 thinking.type 或 thinking.effort 字段的实际值
   ```

2. **查看 Claude Code 的更新日志**：
   - 是否提到 "Ultracode" 模式
   - 是否为某个特定版本的功能

3. **对比 Sonnet 3.5 和 Sonnet 5**：
   - Sonnet 3.5 是否真的有 "max"？（理论上只有 Opus 4.6 有）
   - 可能是 Claude Code 的 UI 命名不规范

---

## 问题 3: Sonnet 5 自身的推理强度分几档？

### 官方答案：**5 档**（不包括 "off"）

根据我们的配置和 Anthropic API 文档：

```typescript
// Sonnet 5 的 thinkingLevelMap
{
  off: null,           // 不支持完全关闭 extended thinking
  minimal: "low",      // 最低强度
  low: "low",          // 低强度
  medium: "medium",    // 中等强度
  high: "high",        // 高强度
  xhigh: "xhigh"       // 超高强度（不是 "max"！）
}
```

### 详细说明

**Sonnet 5 支持的级别**：
1. **low** (minimal/low 都映射到这里)
2. **medium**
3. **high**
4. **xhigh** ← 最高级别

**Sonnet 5 不支持**：
- ❌ **"max"** - 这是 Opus 4.6 独占的
- ❌ **"off"** - Sonnet 5 的 extended thinking 无法完全关闭

### 各模型的推理强度对比

| 模型 | off | low | medium | high | xhigh | max |
|------|-----|-----|--------|------|-------|-----|
| Sonnet 5 | ❌ | ✅ | ✅ | ✅ | ✅ | ❌ |
| Opus 4.6 | ❌ | ✅ | ✅ | ✅ | ❌ | ✅ |
| Opus 4.7+ | ❌ | ✅ | ✅ | ✅ | ✅ | ❌ |
| Sonnet 3.7 | ❌ | ✅ | ✅ | ✅ | ✅ | ❌ |
| Haiku 4.5 | ❌ | ✅ | ✅ | ✅ | ✅ | ❌ |
| OpenAI o1/o3 | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ |
| GPT-5.2+ | ❌ | ✅ | ✅ | ✅ | ✅ | ❌ |

### 在 Magenta 中的体验

当你在 TUI 中按 `Shift+Tab` 循环时：

**Sonnet 5**:
```
minimal → low → medium → high → xhigh → minimal → ...
```

**Opus 4.6**:
```
minimal → low → medium → high → max → minimal → ...
```

**OpenAI o1**:
```
minimal → low → medium → high → minimal → ...
```

---

## 总结

### 模型发现机制
- **构建时静态生成**，不是运行时动态发现
- 来源：models.dev、OpenRouter 等公开 API
- 自定义模型：需要手动配置，但 thinkingLevelMap 智能推断

### Claude Code 的 "Ultracode" 模式
- **不是 Anthropic 官方 API 参数**
- 可能是 Claude Code 的 UI 包装或特殊预设
- 需要抓包验证实际 API 调用

### Sonnet 5 的推理强度
- **4 个有效级别**：low, medium, high, xhigh
- **不支持 "max"** (Opus 4.6 独占)
- **不支持 "off"** (extended thinking 无法完全关闭)

---

**创建时间**: 2026-07-03  
**适用版本**: Magenta v0.80.2+
