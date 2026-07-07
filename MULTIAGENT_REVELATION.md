# Magenta Multiagent Orchestrator 的启示

## 🎯 核心发现

我们已经有了一个 **成熟的多智能体编排系统**，它完美体现了 Karpathy LOOPS.md 的核心哲学！

---

## 对比分析

### Karpathy 的哲学
```
"三个角色，三个上下文窗口，三个系统提示"
- Planner (规划)
- Generator (生成)
- Evaluator (评估)

"混合角色是最常见的失败模式"
```

### Magenta Multiagent 的实现
```
✅ 已经实现了角色分离的工作流模式！

6 个确定性模式：
1. classify_and_act    - 分类器 + 处理器
2. fan_out_synthesize  - 工作者 + 合成器
3. adversarial_verify  - 生成器 + 验证器
4. generate_and_filter - 生成器 + 评估器
5. tournament          - 候选者 + 裁判
6. loop_until_done     - 精炼器 + 停止条件
```

---

## 关键设计原则对比

| 维度 | Karpathy | Magenta Multiagent | 匹配度 |
|------|----------|-------------------|--------|
| **角色分离** | 强制 3 角色 | ✅ 每个模式强制角色分离 | 💯 |
| **契约先行** | Generator ↔ Evaluator 协商 | ⚠️ WorkerSlot 定义任务，但无协商阶段 | 🟡 |
| **确定性流程** | 循环在代码中，不在提示中 | ✅ "plain JavaScript control flow — for, await, if" | 💯 |
| **Guard Prompts** | 未明确提及 | ✅ **GUARDS 硬编码灵魂步骤！** | 💯💯💯 |
| **状态在磁盘** | 4 个标准文件 | ⚠️ WorkerResult 但无标准磁盘格式 | 🟡 |
| **允许重启** | 鼓励扔掉重来 | ⚠️ 未明确支持 | 🟡 |
| **主观评分** | 4 轴 + 校准 | ✅ `evaluator` slot 做评分 | ✅ |
| **循环可见** | 强制显式 | ✅ OrchestrationResult 记录所有 workers | ✅ |

---

## 🔥 最重要的发现：GUARDS

### Karpathy 强调的 "Soul Step"
```
"The model tends to skip the disciplined soul step of a procedure"
```

### Magenta 已经实现了！
```typescript
const GUARDS = {
  classifier: "First determine the type of the input, then handle it 
               according to its type. Do not process the input 
               generically without classifying it first.",
  
  synthesizer: "Merge them into a single consolidated artifact. 
                Do not omit any input.",
  
  verifier: "Re-check each reported candidate on its own evidence. 
             Prefer missing a real issue over confirming a false one. 
             Return a strict boolean verdict per candidate.",
  
  evaluator: "Score the candidate against the stated criteria and 
              return a numeric score. Base the score only on the 
              criteria, not on presentation length.",
  
  judge: "Comparing exactly two candidates. Decide which one is 
          better and return the winner's index (0 or 1).",
  
  refine: "Findings already discovered in previous rounds are listed 
           below; exclude them. Report only NEW findings this round."
}
```

**这正是 Karpathy 说的 "不让模型跳过的关键步骤"！**

---

## research-orchestration 应该如何改进

### 当前问题
`research-orchestration` skill 是一个 **手动的、提示驱动的** 循环指南。它告诉用户"应该这样做循环"，但：
- ❌ 没有强制角色分离
- ❌ 没有确定性的控制流
- ❌ 没有 guard prompts
- ❌ 依赖用户手动执行循环

### 解决方案：research-orchestration 应该 **使用** multiagent orchestrator

#### 方案 A：research-orchestration 成为 multiagent 模式的集合体

```markdown
# Research Orchestration (改进版)

当用户说 "研究这个复杂问题" 时，不要手动循环，而是：

## Step 1: 分解 (Decompose)
使用 `classify_and_act` 模式：
- Classifier: 判断这是什么类型的研究任务
- Handlers: 
  - "data_analysis" → 数据分析工作流
  - "literature_review" → 文献综述工作流
  - "hypothesis_testing" → 假设验证工作流

## Step 2: 并行探索 (Fan Out)
使用 `fan_out_synthesize` 模式：
- Workers: 每个子问题独立研究
- Synthesizer: 合并发现

## Step 3: 验证 (Verify)
使用 `adversarial_verify` 模式：
- Generator: 提出可能的结论
- Verifier: 独立验证每个结论

## Step 4: 精炼 (Refine)
使用 `loop_until_done` 模式：
- Refine worker: 基于反馈改进
- 停止条件: 没有新发现
```

#### 方案 B：新增 "research_loop" 模式到 multiagent

在 `orchestrator.ts` 中新增第 7 个模式：

```typescript
export interface ResearchLoopRequest extends CommonOptions {
  pattern: "research_loop";
  
  // Karpathy 的三角色
  planner: WorkerSlot;    // 分解任务，制定计划
  generator: WorkerSlot;  // 执行工作，生成输出
  evaluator: WorkerSlot;  // 评估输出，给出反馈
  
  // 契约协商
  contractNegotiation?: boolean;  // 是否强制契约协商
  
  // 状态管理
  stateFiles: {
    plan: string;         // plan.md
    contract: string;     // contract.md
    progress: string;     // progress.md
    iterations: string;   // iterations.log
  };
  
  maxIterations?: number;
  convergenceThreshold?: number;
}

const GUARDS = {
  // ... 现有的 guards
  
  planner: "Decompose the task into concrete subproblems with clear " +
           "success criteria. Do not start implementation.",
  
  contract_negotiator: "Propose 15-30 testable assertions that define " +
                       "what 'done' looks like. Be specific and verifiable.",
  
  contract_critic: "Challenge the proposed contract. Identify gaps, " +
                   "ambiguities, and untestable assertions. Push back.",
  
  research_evaluator: "Read the contract.md line by line. For each " +
                      "assertion: PASS / FAIL / UNCLEAR + evidence. " +
                      "Score on 4 axes (0-1): correctness, coverage, " +
                      "rigor, format-compliance."
};

async function researchLoop(
  req: ResearchLoopRequest,
  runner: WorkerRunner,
  signal?: AbortSignal
): Promise<OrchestrationResult> {
  const workers: WorkerResult[] = [];
  let iteration = 0;
  
  // Phase 1: Contract Negotiation (Karpathy 的契约先行)
  if (req.contractNegotiation) {
    const contractProposal = await runner.spawn({
      ...req.generator,
      systemPromptPrefix: GUARDS.contract_negotiator,
      task: "Propose completion criteria for: " + req.generator.task
    }, signal);
    workers.push(contractProposal);
    
    const contractCritique = await runner.spawn({
      ...req.evaluator,
      systemPromptPrefix: GUARDS.contract_critic,
      task: "Critique this contract: " + contractProposal.text
    }, signal);
    workers.push(contractCritique);
    
    // 写入 contract.md
    // await fs.writeFile(req.stateFiles.contract, finalContract);
  }
  
  // Phase 2: Iterative Loop
  while (iteration < (req.maxIterations || 10)) {
    iteration++;
    
    // 2.1 Plan (or Replan)
    const plan = await runner.spawn({
      ...req.planner,
      systemPromptPrefix: GUARDS.planner,
      task: iteration === 1 
        ? req.planner.task 
        : `Revise plan based on: ${workers[workers.length - 1].text}`
    }, signal);
    workers.push(plan);
    
    // 2.2 Implement
    const implementation = await runner.spawn({
      ...req.generator,
      systemPromptPrefix: GUARDS.generator,
      task: `Execute this plan: ${plan.text}`
    }, signal);
    workers.push(implementation);
    
    // 2.3 Evaluate
    const evaluation = await runner.spawn({
      ...req.evaluator,
      systemPromptPrefix: GUARDS.research_evaluator,
      task: `Evaluate against contract: ${implementation.text}`
    }, signal);
    workers.push(evaluation);
    
    // 2.4 Check convergence
    const score = extractScore(evaluation.structured);
    if (score > (req.convergenceThreshold || 0.9)) {
      return {
        pattern: "research_loop",
        workers,
        outcome: implementation,
        iterations: iteration,
        terminatedBy: "completed"
      };
    }
    
    // 2.5 No progress check
    if (iteration > 2 && !hasNewFindings(evaluation, workers)) {
      return {
        pattern: "research_loop",
        workers,
        outcome: implementation,
        iterations: iteration,
        terminatedBy: "threshold"
      };
    }
  }
  
  return {
    pattern: "research_loop",
    workers,
    iterations: iteration,
    terminatedBy: "max_iterations"
  };
}
```

---

## 立即可行的改进

### 1. 最小改动：更新 research-orchestration skill

```markdown
# Research Orchestration (Updated)

## Quick Start

For complex research tasks, use Magenta's multiagent orchestrator instead 
of manual looping:

### Pattern Selection Guide

**classify_and_act** - 当任务类型需要先判断
```
sub_agent action=start workflow={
  "pattern": "classify_and_act",
  "classifier": {"task": "Determine if this is data-driven, theory-driven, or exploratory"},
  "handlers": {
    "data_driven": {"task": "Run statistical analysis..."},
    "theory_driven": {"task": "Review literature and test hypothesis..."},
    "exploratory": {"task": "Survey the landscape..."}
  }
}
```

**fan_out_synthesize** - 当有多个独立子问题
```
sub_agent action=start workflow={
  "pattern": "fan_out_synthesize",
  "workers": [
    {"task": "Research aspect A"},
    {"task": "Research aspect B"},
    {"task": "Research aspect C"}
  ],
  "synthesizer": {"task": "Merge findings into coherent narrative"}
}
```

**adversarial_verify** - 当结论需要严格验证
```
sub_agent action=start workflow={
  "pattern": "adversarial_verify",
  "generator": {"task": "Propose conclusions from data"},
  "verifier": {"task": "Re-check each conclusion independently"},
  "verifyCount": 3,
  "confidenceThreshold": 0.8
}
```

**loop_until_done** - 当需要迭代精炼
```
sub_agent action=start workflow={
  "pattern": "loop_until_done",
  "initial": "Starting hypothesis: ...",
  "refine": {"task": "Find gaps in current understanding"},
  "maxIterations": 5
}
```

## Manual Loop (Fallback)

If workflows don't fit, use the manual research loop...
[保留现有的 PLAN → IMPLEMENT → OBSERVE → REFLECT → REFINE]
```

### 2. 中等改动：在 multiagent 中新增 research_loop 模式

实现上面方案 B 的代码。

### 3. 最大改动：让 research-orchestration 完全基于 workflow

删除手动循环指导，完全用 workflow 组合来实现。

---

## 关键启示总结

### 🎉 我们已经有的宝藏

1. **确定性控制流** - 完美实现了 Karpathy 的 "write the loop, not the prompt"
2. **角色分离** - 每个模式强制不同角色
3. **Guard Prompts** - 硬编码灵魂步骤，防止模型跳过
4. **6 个成熟模式** - 覆盖大部分编排场景

### 🔧 需要补充的

1. **契约协商** - 在 generator 和 evaluator 之间加入协商阶段
2. **标准化状态文件** - plan.md, contract.md, progress.md, iterations.log
3. **research_loop 模式** - 专门为 Karpathy 式的研究循环设计
4. **重启机制** - 允许扔掉当前尝试，重新开始

### 📋 行动项

#### 立即（1 小时）
- 更新 `research-orchestration` skill，加入 multiagent workflow 使用指南

#### 短期（1 天）
- 在 multiagent 中实现 `research_loop` 模式
- 加入契约协商阶段
- 标准化状态文件格式

#### 中期（1 周）
- 实现重启机制（restart_budget）
- 加入 trace 驱动的调试支持
- 完善评分和校准

---

## 结论

**Magenta 的 multiagent orchestrator 已经是 Karpathy LOOPS.md 的优秀实现！**

现在的任务不是重新发明轮子，而是：
1. 让 `research-orchestration` skill 成为 multiagent 模式的 **使用指南**
2. 在 multiagent 中新增 `research_loop` 模式，专门实现 Karpathy 的完整循环
3. 补充契约协商、标准状态文件、重启机制等细节

我们比想象中更接近完美！🚀
