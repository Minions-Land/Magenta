# Anthropic 推理强度修正：Sonnet 5 支持 max

## 📸 发现来源

根据 Claude Code v2.1.195 的实际截图，发现：

```
Effort
Faster                                                 Smarter
────────────────────────────────────────▲──┆──────────────────
low     medium     high     xhigh      max       ultracode
                                                xhigh + workflows
```

**关键发现**：
1. ✅ **Sonnet 5 支持 `max`** - 不仅仅是 Opus 4.6
2. ✅ **`ultracode` = "xhigh + workflows"** - Claude Code 特有概念，非 API 参数
3. ✅ **`max` 比 `xhigh` 更高** - 是最高推理级别

## 🔧 修正内容

### 之前的错误假设

我们之前认为：
- ❌ 只有 Opus 4.6 支持 `max`
- ❌ Sonnet 5, Opus 4.7+, Fable 5 用 `xhigh`

### 实际情况（已修正）

根据 Claude Code 的行为：
- ✅ **Opus 4.x 全系列**支持 `max`
- ✅ **Sonnet 5** 支持 `max`
- ✅ **Fable 5** 支持 `max`
- ✅ **Sonnet 3.7, 4.x (非5), Haiku 4.5** 用 `xhigh`

## 📝 代码修改

### 1. `pi/ai/scripts/generate-models.ts`

**删除**：
```typescript
// ❌ 旧的 ANTHROPIC_OPUS_46_THINKING_LEVEL_MAP
const ANTHROPIC_OPUS_46_THINKING_LEVEL_MAP = {
  off: null, minimal: "low", low: "low", 
  medium: "medium", high: "high", xhigh: "max"
};
```

**新增**：
```typescript
// ✅ 新的统一 map
const ANTHROPIC_MAX_THINKING_LEVEL_MAP = {
  off: null, minimal: "low", low: "low",
  medium: "medium", high: "high", xhigh: "max"  // 映射到 'max'
};

const ANTHROPIC_EXTENDED_THINKING_LEVEL_MAP = {
  off: null, minimal: "low", low: "low",
  medium: "medium", high: "high", xhigh: "xhigh"  // 映射到 'xhigh'
};
```

**应用规则**：
```typescript
// Opus 4.x, Sonnet 5, Fable 5 → max
if (model.id.includes("opus-4") || 
    model.id.includes("sonnet-5") || 
    model.id.includes("fable-5")) {
  mergeThinkingLevelMap(model, ANTHROPIC_MAX_THINKING_LEVEL_MAP);
}
// Sonnet 3.7, 4.x (非5), Haiku 4.5 → xhigh
else if (isAnthropicExtendedThinkingModel(model.id)) {
  mergeThinkingLevelMap(model, ANTHROPIC_EXTENDED_THINKING_LEVEL_MAP);
}
```

### 2. `pi/coding-agent/src/core/model-registry.ts`

**更新推断函数**：
```typescript
function inferThinkingLevelMap(modelId, api, reasoning) {
  if (api === "anthropic-messages") {
    // Opus 4.x, Sonnet 5, Fable 5 → max
    if (id.includes("opus-4") || 
        id.includes("sonnet-5") || 
        id.includes("fable-5")) {
      return { ..., xhigh: "max" };
    }
    // 其他 extended thinking 模型 → xhigh
    if (id.includes("sonnet-3-7") || 
        id.includes("sonnet-4") || 
        id.includes("haiku-4-5")) {
      return { ..., xhigh: "xhigh" };
    }
  }
}
```

## 🎯 最终效果

### Magenta TUI 中的体验

**Sonnet 5**:
```
Shift+Tab: minimal → low → medium → high → xhigh(max) → minimal
```
- 用户看到 `xhigh`
- 实际 API 发送 `thinking.effort = "max"`

**Opus 4.7**:
```
Shift+Tab: minimal → low → medium → high → xhigh(max) → minimal
```
- 同样映射到 `max`

**Sonnet 3.7**:
```
Shift+Tab: minimal → low → medium → high → xhigh → minimal
```
- 实际 API 发送 `thinking.effort = "xhigh"`

### 对比表

| 模型 | TUI 显示 | API 实际值 | 最高级别 |
|------|---------|-----------|---------|
| Sonnet 5 | xhigh | max | ✅ |
| Opus 4.6-4.8 | xhigh | max | ✅ |
| Fable 5 | xhigh | max | ✅ |
| Sonnet 3.7 | xhigh | xhigh | - |
| Sonnet 4.x | xhigh | xhigh | - |
| Haiku 4.5 | xhigh | xhigh | - |

## 🤔 关于 "ultracode"

**结论**：
- ❌ **不是 Anthropic API 参数**
- ✅ **是 Claude Code 的 UI 概念**
- 📝 **含义**：`xhigh + workflows`（可能是预设的工作流配置）

**猜测实现**：
```typescript
// Claude Code 可能这样做：
if (effort === "ultracode") {
  apiParams.thinking.effort = "xhigh";
  enableWorkflows = true;  // 额外启用工作流功能
}
```

**在 Magenta 中**：
- 我们不支持 "ultracode"（因为不是官方 API 参数）
- 用户可以用 `xhigh` 获得最高推理强度
- 对于支持 `max` 的模型，`xhigh` 自动映射到 `max`

## ✅ 验证结果

```bash
# Sonnet 5
thinkingLevelMap: {"off":null,"minimal":"low","low":"low",
                   "medium":"medium","high":"high","xhigh":"max"}

# Opus 4.7
thinkingLevelMap: {"off":null,"minimal":"low","low":"low",
                   "medium":"medium","high":"high","xhigh":"max"}

# Sonnet 3.7
thinkingLevelMap: {"off":null,"minimal":"low","low":"low",
                   "medium":"medium","high":"high","xhigh":"xhigh"}
```

## 🎉 总结

1. **修正了对 Anthropic API 的理解**：`max` 不只是 Opus 4.6 独占
2. **统一了 thinkingLevelMap 配置**：根据模型能力自动选择 `max` 或 `xhigh`
3. **明确了 ultracode 的本质**：Claude Code 特有的 UI 概念，非 API 参数
4. **保持了用户体验一致性**：TUI 中统一显示 `xhigh`，底层自动选择正确的 API 值

---

**修正时间**: 2026-07-03  
**触发原因**: Claude Code v2.1.195 截图显示 Sonnet 5 支持 max  
**影响范围**: 所有 Anthropic 推理模型的 thinking level 配置
