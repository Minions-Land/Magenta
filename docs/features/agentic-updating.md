# Agentic Updating 设计方案

> **Status**: 📝 Design Phase  
> **Priority**: Future Feature (Self-Evolution Capability)  
> **Related**: Magenta Self-Development / Self-Evolution

## 目标

实现 Magenta 的 **自开发/自进化能力**：让 Agent 自己分析上游变化，智能决定如何更新，而不是简单的覆盖式更新。

## 问题分析

当前 Pi 更新机制：
- 调用 `https://pi.dev/api/latest-version` 检查版本
- 提示用户运行 `pi update` 命令
- 简单覆盖式更新（可能丢失 Magenta 的定制）

Magenta 的困境：
- 基于 Pi 0.80.2 fork
- 已做大量定制（harness 重组、brands 系统、assembly 层等）
- 简单更新会覆盖定制内容

## Agentic Updating 设计

### 核心思路

用 Agent 自己分析上游变化，智能合并到 Magenta：

```
1. 获取上游变化
   ↓
2. Agent 分析影响范围
   ↓
3. 对比 Magenta 改动
   ↓
4. 智能合并（避免冲突）
   ↓
5. 测试验证
   ↓
6. 生成报告
```

### 实现方案

#### 方案 A：Git-based 智能合并

```typescript
// scripts/agentic-update.ts

async function agenticUpdate() {
  // 1. 获取上游变化
  const upstream = await fetchUpstreamChanges('pi', '0.80.2', '0.80.3');
  
  // 2. 分析影响的文件
  const affectedFiles = analyzeChangedFiles(upstream.diff);
  
  // 3. 检测与 Magenta 改动的冲突
  const conflicts = detectConflicts(affectedFiles, magentaChanges);
  
  // 4. 生成合并策略
  const strategy = {
    autoMerge: [], // 无冲突，自动合并
    needsReview: [], // 有冲突，需要人工决策
    skip: [], // Magenta 特有，跳过上游更新
  };
  
  // 5. 让 Agent 分析冲突
  const agent = new MagentaAgent();
  for (const conflict of conflicts) {
    const resolution = await agent.analyzeConflict(conflict);
    strategy.needsReview.push({ conflict, resolution });
  }
  
  // 6. 生成报告
  const report = generateUpdateReport(strategy);
  console.log(report);
}
```

#### 方案 B：Changelog-based 增量更新

```typescript
// scripts/changelog-update.ts

async function changelogBasedUpdate() {
  // 1. 获取上游 changelog
  const changelog = await fetchChangelog('0.80.2', '0.80.3');
  
  // 2. 分类变化
  const categories = {
    bugfixes: [], // Bug 修复（优先合并）
    features: [], // 新功能（可选）
    breaking: [], // 破坏性变更（需要适配）
    docs: [], // 文档更新（低优先级）
  };
  
  // 3. 让 Agent 决定每个变化如何处理
  for (const change of changelog.entries) {
    const decision = await agent.decide({
      change,
      magentaState: currentState,
      question: "Should we apply this change to Magenta?"
    });
    
    if (decision.apply) {
      await applyChange(change, decision.strategy);
    }
  }
  
  // 4. 运行测试
  const testResults = await runTests();
  
  // 5. 生成报告
  return {
    applied: appliedChanges,
    skipped: skippedChanges,
    conflicts: unresolvedConflicts,
    tests: testResults,
  };
}
```

### 具体实现步骤

#### Step 1: 禁用自动版本检查

```typescript
// pi/coding-agent/src/modes/interactive/interactive-mode.ts

// 修改版本检查逻辑
async startVersionCheck() {
  // 如果是 Magenta fork，使用自定义更新逻辑
  if (process.env.MAGENTA_FORK === 'true') {
    this.checkMagentaUpdates();
    return;
  }
  
  // 原有的 Pi 版本检查
  checkForNewPiVersion(this.version).then(/* ... */);
}
```

#### Step 2: 创建 Magenta 更新检查器

```typescript
// pi/coding-agent/src/utils/magenta-version-check.ts

export async function checkMagentaUpdates() {
  // 1. 检查上游 Pi 版本
  const upstreamVersion = await getLatestPiVersion();
  
  // 2. 获取 Magenta 当前基于的 Pi 版本
  const baseVersion = await getMagentaBaseVersion(); // from brands/magenta/magenta.brand.ts
  
  // 3. 如果有新版本，返回变化摘要
  if (isNewer(upstreamVersion, baseVersion)) {
    return {
      upstreamVersion,
      baseVersion,
      changelog: await fetchChangelog(baseVersion, upstreamVersion),
      suggestAgenticUpdate: true,
    };
  }
  
  return null;
}
```

#### Step 3: 创建 Agentic Update 命令

```typescript
// pi/coding-agent/src/commands/agentic-update.ts

export async function agenticUpdateCommand(agent: Agent) {
  agent.say("🔍 Checking for upstream Pi updates...");
  
  const updateInfo = await checkMagentaUpdates();
  
  if (!updateInfo) {
    agent.say("✅ Magenta is up to date with Pi " + baseVersion);
    return;
  }
  
  agent.say(`📦 Pi ${updateInfo.upstreamVersion} is available (current: ${updateInfo.baseVersion})`);
  
  // 显示 changelog
  agent.say("📋 Upstream changes:");
  agent.say(updateInfo.changelog);
  
  // 询问是否继续
  const shouldContinue = await agent.confirm("Analyze and apply updates intelligently?");
  
  if (!shouldContinue) return;
  
  // 让 Agent 分析变化
  agent.say("🤖 Analyzing changes and Magenta customizations...");
  
  const analysis = await analyzeUpdates(updateInfo, agent);
  
  // 显示分析结果
  agent.say("📊 Analysis complete:");
  agent.say(`  - Auto-mergeable: ${analysis.autoMerge.length} files`);
  agent.say(`  - Need review: ${analysis.needsReview.length} files`);
  agent.say(`  - Skip (Magenta-specific): ${analysis.skip.length} files`);
  
  // 应用更新
  const shouldApply = await agent.confirm("Apply auto-mergeable changes?");
  
  if (shouldApply) {
    await applyUpdates(analysis.autoMerge);
    agent.say("✅ Updates applied. Running tests...");
    
    const testResults = await runTests();
    agent.say(testResults.summary);
  }
}
```

#### Step 4: 集成到 TUI

修改更新提示：

```typescript
// interactive-mode.ts

showNewVersionNotification(release: LatestPiRelease): void {
  const isMagentaFork = process.env.MAGENTA_FORK === 'true';
  
  if (isMagentaFork) {
    // Magenta 定制提示
    const updateInstruction = theme.fg("muted", 
      `Upstream Pi ${release.version} is available. Run `) + 
      theme.fg("accent", `/agentic-update`) + 
      theme.fg("muted", ` to intelligently merge changes.`);
    
    this.chatContainer.addChild(new Text(
      `${theme.bold(theme.fg("info", "Upstream Update Available"))}\n${updateInstruction}`,
      1, 0
    ));
  } else {
    // 原有的 Pi 提示
    // ...
  }
}
```

### 优势

1. **智能合并**：Agent 分析冲突并提出解决方案
2. **保留定制**：不会丢失 Magenta 特有的改动
3. **可控更新**：用户可以选择应用哪些变化
4. **自动测试**：更新后自动运行测试验证
5. **变更记录**：生成详细的更新报告

### 挑战

1. **复杂度**：需要解析 Git diff、分析代码依赖
2. **准确性**：Agent 可能误判冲突
3. **维护成本**：需要维护 Magenta → Pi 的映射关系

## 下一步

你觉得这个方案如何？我可以：

1. **快速实现**：先禁用 Pi 版本检查，添加 Magenta 定制提示
2. **完整实现**：实现 `/agentic-update` 命令和智能合并逻辑
3. **混合方案**：保留简单更新，添加 `/agentic-update` 作为高级选项

或者你有其他想法？
