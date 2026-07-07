# Magenta Workflow 重构方案：从"填表"到"写脚本"

## 目标

把 multiagent 从"6 个固定模板"升级为"提供原语 + LLM 写 JS 脚本"，学习 Claude Code 的灵活度，保留我们的安全边界。

---

## 三步走路线图

### Phase 1: 扩充原语、保留兼容（1-2 天）

**目标**：把现有的 `spawnWorker` / `parallel` 包装成 Claude Code 风格的原语，六个模板暂时保留不动。

#### 1.1 新增原语函数（在 `worker.ts` 中）

```typescript
// ====== 新增：Claude Code 风格的原语 API ======

/**
 * 跑一个 headless agent（对标 Claude Code 的 agent()）
 * 
 * @param prompt - 任务提示
 * @param options - 可选配置
 * @returns WorkerResult
 */
export async function agent(
  prompt: string, 
  options?: {
    label?: string;         // 日志标签
    schema?: unknown;       // JSON schema 约束输出
    model?: string;
    provider?: string;
    thinking?: ThinkingLevel;
    tools?: string[];
    guard?: string;         // 挂一个 guard（从 GUARDS 里选）
    timeoutMs?: number;
  },
  signal?: AbortSignal
): Promise<WorkerResult> {
  const workerId = options?.label || `agent-${Date.now()}`;
  const systemPrompt = options?.guard 
    ? buildSystemPrompt(options.guard, { task: prompt, schema: options.schema })
    : options?.schema 
      ? `Return your final answer as JSON matching this schema:\n${JSON.stringify(options.schema, null, 2)}`
      : undefined;
  
  return spawnWorker({
    workerId,
    prompt,
    systemPrompt,
    model: options?.model,
    provider: options?.provider,
    thinking: options?.thinking,
    tools: options?.tools,
    schema: options?.schema,
    timeoutMs: options?.timeoutMs,
    cwd: process.cwd(),  // TODO: 从 context 传入
  }, signal);
}

/**
 * 并行跑一批（对标 Claude Code 的 parallel()）
 * 
 * @param tasks - 函数数组，每个返回 Promise<WorkerResult>
 * @param maxConcurrent - 并发上限（默认 8）
 */
export async function parallelAgents<T>(
  tasks: Array<() => Promise<T>>,
  maxConcurrent: number = 8,
  signal?: AbortSignal
): Promise<T[]> {
  const limit = Math.max(1, maxConcurrent);
  const results = new Array<T>(tasks.length);
  let next = 0;

  async function runLane(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= tasks.length) return;
      results[index] = await tasks[index]();
    }
  }

  const lanes = Array.from({ length: Math.min(limit, tasks.length) }, () => runLane());
  await Promise.all(lanes);
  return results;
}

/**
 * 流式处理（对标 Claude Code 的 pipeline()）
 * 
 * 不等全部完成就把完成的喂给下游（区别于 parallel 的 barrier）
 * 
 * @param items - 输入列表
 * @param fn - 对每个 item 的处理函数
 * @param maxConcurrent - 并发上限
 */
export async function pipeline<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  maxConcurrent: number = 8,
  signal?: AbortSignal
): Promise<R[]> {
  const results: R[] = [];
  const limit = Math.max(1, maxConcurrent);
  let next = 0;

  async function runLane(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      const result = await fn(items[index], index);
      results.push(result);  // 不保序，完成就推
    }
  }

  const lanes = Array.from({ length: Math.min(limit, items.length) }, () => runLane());
  await Promise.all(lanes);
  return results;
}

/**
 * 标记阶段（纯日志/可观测）
 */
export function phase(name: string): void {
  console.log(`\n======== ${name} ========\n`);
  // TODO: 写入 workflow 的 iterations.log
}

/**
 * 写日志
 */
export function log(message: string): void {
  console.log(`[workflow] ${message}`);
  // TODO: 写入 workflow 的 log.jsonl
}
```

#### 1.2 导出 GUARDS 常量（让脚本能引用）

在 `contract.ts` 或 `worker.ts` 中：

```typescript
/**
 * 可复用的 guard 原子（Karpathy 的 "soul step"）
 * 
 * 用法：agent("分类这个输入", { guard: GUARDS.classifier })
 */
export const GUARDS = {
  classifier: "First determine the type of the input...",
  synthesizer: "Merge them into a single consolidated artifact...",
  verifier: "Re-check each reported candidate...",
  evaluator: "Score the candidate against the stated criteria...",
  judge: "Comparing exactly two candidates...",
  refine: "Findings already discovered are listed below; exclude them...",
  // Karpathy 的三角色
  planner: "Decompose the task into concrete subproblems with clear success criteria. Do not start implementation.",
  generator: "Execute the work and generate outputs. You are forbidden from grading your own work.",
  contract_negotiator: "Propose 15-30 testable assertions that define what 'done' looks like. Be specific and verifiable.",
  contract_critic: "Challenge the proposed contract. Identify gaps, ambiguities, and untestable assertions. Push back.",
  research_evaluator: "Read the contract line by line. For each assertion: PASS / FAIL / UNCLEAR + evidence. Score on 4 axes (0-1): correctness, coverage, rigor, format-compliance.",
} as const;
```

#### 1.3 六个模板暂时保留

`orchestrator.ts` 的 `orchestrate()` 方法不动，还是识别 6 个 pattern。现在只是**加了一套新 API**，两条路并行。

---

### Phase 2: 支持可执行 workflow 脚本（3-4 天）

**目标**：让用户（或 LLM）能写一个 `.ts` 文件来定义 workflow，不再填 JSON。

#### 2.1 Workflow 脚本的标准格式

```typescript
// ~/.magenta/workflows/my-research.ts

import { agent, parallelAgents, phase, log, GUARDS } from "@magenta/multiagent";

/**
 * 元信息（可选，用于 /events 展示）
 */
export const meta = {
  name: "my-research",
  description: "深度调研某个主题",
  phases: [
    { title: "分解", detail: "拆成 5 个子问题" },
    { title: "并行搜索", detail: "每个子问题独立调研" },
    { title: "验证", detail: "3 票对抗验证" },
    { title: "综合", detail: "合并为报告" }
  ]
};

/**
 * 主函数：workflow 的执行入口
 * 
 * @param args - 从外部传入的参数（如用户的问题）
 * @param context - 运行时上下文（cwd, workflowId, signal）
 * @returns 任意结构的结果
 */
export default async function run(
  args: { question: string },
  context: { cwd: string; workflowId: string; signal?: AbortSignal }
): Promise<unknown> {
  const { question } = args;
  
  // Phase 1: 分解
  phase("分解");
  const scope = await agent(
    `将这个问题分解为 5 个子问题：${question}`,
    { 
      label: "scope",
      schema: { type: "object", properties: { angles: { type: "array" } } }
    },
    context.signal
  );
  
  if (!scope.success || !scope.structured) {
    return { error: "分解失败", details: scope.error };
  }
  
  const angles = scope.structured.angles as string[];
  log(`分解为 ${angles.length} 个角度`);
  
  // Phase 2: 并行搜索
  phase("并行搜索");
  const searchResults = await parallelAgents(
    angles.map((angle, i) => () => 
      agent(`搜索：${angle}`, { label: `search-${i}` }, context.signal)
    ),
    5,  // 最多 5 个并发
    context.signal
  );
  
  // Phase 3: 验证（带重试示例）
  phase("验证");
  const claims = searchResults.flatMap(r => extractClaims(r.text));
  
  const verified = [];
  for (const claim of claims) {
    let votes = { pass: 0, fail: 0 };
    let attempts = 0;
    
    // "坏了重试" 的例子
    while (attempts < 3) {
      const voteResults = await parallelAgents(
        [0, 1, 2].map(v => () => 
          agent(
            `验证这个断言：${claim}`,
            { label: `vote-${v}`, guard: GUARDS.verifier },
            context.signal
          )
        ),
        3,
        context.signal
      );
      
      votes = { 
        pass: voteResults.filter(v => v.text.includes("PASS")).length,
        fail: voteResults.filter(v => v.text.includes("FAIL")).length
      };
      
      // 检查是否有效（避免模型糊弄）
      if (votes.pass + votes.fail >= 2) break;  // 至少 2 票有效
      
      attempts++;
      log(`投票无效，重试 ${attempts}/3`);
    }
    
    if (votes.pass >= 2) verified.push(claim);
  }
  
  // Phase 4: 综合
  phase("综合");
  const report = await agent(
    `合并这些已验证的事实为报告：${verified.join("\\n")}`,
    { label: "synthesize", guard: GUARDS.synthesizer },
    context.signal
  );
  
  return {
    question,
    verified: verified.length,
    report: report.text
  };
}

// 辅助函数
function extractClaims(text: string): string[] {
  // 简化示例
  return text.split(".").filter(s => s.length > 20);
}
```

#### 2.2 Workflow 加载器（新增 `workflow-loader.ts`）

```typescript
import * as path from "node:path";
import type { WorkerResult } from "./contract.ts";

export interface WorkflowMeta {
  name: string;
  description: string;
  phases?: Array<{ title: string; detail: string }>;
}

export interface WorkflowModule {
  meta?: WorkflowMeta;
  default: (args: unknown, context: WorkflowContext) => Promise<unknown>;
}

export interface WorkflowContext {
  cwd: string;
  workflowId: string;
  signal?: AbortSignal;
}

/**
 * 加载一个 workflow 脚本
 */
export async function loadWorkflow(filePath: string): Promise<WorkflowModule> {
  const resolved = path.resolve(filePath);
  const module = await import(resolved);
  
  if (typeof module.default !== "function") {
    throw new Error(`Workflow ${filePath} must export a default async function`);
  }
  
  return module as WorkflowModule;
}
```

#### 2.3 在 orchestrator 中支持"脚本模式"

在 `contract.ts` 中新增请求类型：

```typescript
export interface ScriptWorkflowRequest extends CommonOptions {
  pattern: "script";
  scriptPath: string;    // workflow 脚本路径
  args: unknown;         // 传给脚本的参数
}

export type OrchestrationRequest =
  | ClassifyAndActRequest
  | FanOutSynthesizeRequest
  | AdversarialVerifyRequest
  | GenerateAndFilterRequest
  | TournamentRequest
  | LoopUntilDoneRequest
  | ScriptWorkflowRequest;  // 新增
```

在 `orchestrator.ts` 中处理：

```typescript
async orchestrate(request: OrchestrationRequest, signal?: AbortSignal): Promise<OrchestrationResult> {
  switch (request.pattern) {
    case "script": {
      const workflowId = `wf-${Date.now()}`;
      const workflow = await loadWorkflow(request.scriptPath);
      
      const context: WorkflowContext = {
        cwd: this.cwd,
        workflowId,
        signal
      };
      
      const result = await workflow.default(request.args, context);
      
      return {
        pattern: "script",
        workers: [],  // TODO: 收集脚本里 spawn 的所有 workers
        outcome: result,
        terminatedBy: "completed"
      };
    }
    // ... 其他 case 不变
  }
}
```

---

### Phase 3: 状态落盘 + 六个模板降级为预设（2-3 天）

#### 3.1 状态落盘（实现追问 2 的方案）

在 `agent()` / `spawnWorker()` 中加入：

```typescript
export async function agent(...) {
  // 获取当前 workflow-id（从环境变量或 context）
  const workflowId = process.env.MAGENTA_WORKFLOW_ID;
  
  if (workflowId) {
    const stateDir = path.join(os.homedir(), ".magenta", "tmp", workflowId);
    fs.mkdirSync(stateDir, { recursive: true });
    
    // 写入 input
    fs.writeFileSync(
      path.join(stateDir, `${workerId}-input.json`),
      JSON.stringify({ prompt, options }, null, 2)
    );
  }
  
  const result = await spawnWorker(...);
  
  if (workflowId) {
    // 写入 output
    fs.writeFileSync(
      path.join(stateDir, `${workerId}-output.json`),
      JSON.stringify(result, null, 2)
    );
  }
  
  return result;
}
```

目录结构：
```
~/.magenta/tmp/<workflow-id>/
  meta.json             # { name, description, startTime, args }
  agent-<id>-input.json
  agent-<id>-output.json
  iterations.log        # phase() 写入
  log.jsonl             # log() 写入
```

#### 3.2 六个模板降级为预设库

新建 `presets.ts`：

```typescript
import { agent, parallelAgents, GUARDS } from "./worker.ts";

/**
 * 预设：扇出+综合
 */
export async function fanOutSynthesize(
  workers: Array<{ task: string; label?: string }>,
  synthesizer: { task: string },
  signal?: AbortSignal
): Promise<unknown> {
  const results = await parallelAgents(
    workers.map(w => () => agent(w.task, { label: w.label }, signal)),
    8,
    signal
  );
  
  const merged = results.map(r => r.text).join("\n\n");
  
  return agent(
    synthesizer.task + "\n\n" + merged,
    { guard: GUARDS.synthesizer },
    signal
  );
}

/**
 * 预设：对抗验证
 */
export async function adversarialVerify(
  generator: { task: string },
  verifyCount: number,
  threshold: number,
  signal?: AbortSignal
): Promise<unknown> {
  const generated = await agent(generator.task, { guard: GUARDS.generator }, signal);
  
  const votes = await parallelAgents(
    Array.from({ length: verifyCount }, (_, i) => () =>
      agent(
        `验证：${generated.text}`,
        { label: `verifier-${i}`, guard: GUARDS.verifier },
        signal
      )
    ),
    verifyCount,
    signal
  );
  
  const passCount = votes.filter(v => v.text.includes("PASS")).length;
  
  return {
    generated: generated.text,
    votes: votes.length,
    passed: passCount,
    threshold,
    confirmed: passCount >= threshold
  };
}

// ... 其他 4 个预设
```

用户可以直接 `import { fanOutSynthesize } from "presets"`，一行搞定常见场景。

---

## 安全边界保证

虽然 LLM 可以写任意 JS 控制流，但**安全边界在原语里硬编码**：

| 边界 | 实现位置 | LLM 能否绕过 |
|------|----------|-------------|
| 禁止 fork bomb | `DEPTH_ENV` + `MAX_DEPTH` | ❌ 引擎检查，spawn 时拒绝 |
| 禁止 sub_agent/bg_shell | `FORBIDDEN_WORKER_TOOLS` | ❌ 工具白名单硬过滤 |
| 并发上限 | `parallelAgents(tasks, maxConcurrent)` | ❌ 调用者必须传，引擎强制 |
| 超时 | `spawnWorker({ timeoutMs })` | ❌ 进程级 kill |
| Guard 优先级 | `buildSystemPrompt` 里 guard 在前 | ❌ 字符串拼接顺序硬编码 |

**LLM 写的是控制流（if/while/await），碰不到这些边界**。

---

## 迁移路径

- **Phase 1 完成**：新老 API 并存，六个模板用户零感知
- **Phase 2 完成**：可以写脚本，也可以继续用模板
- **Phase 3 完成**：模板变成预设库，推荐但不强制

向后兼容，平滑过渡。

---

## 对标 Claude Code

| 维度 | Claude Code | 我们 Phase 3 后 |
|------|-------------|----------------|
| 原语 | agent/parallel/pipeline/phase/log | ✅ 完全对齐 |
| 灵活度 | 任意 JS | ✅ 任意 TS |
| 预设 | 无（用户自己写） | ✅ 6 个预设 + 用户可扩展 |
| Guard | 写在 prompt 里 | ✅ GUARDS 常量 + 硬编码优先级（更强） |
| 安全边界 | 依赖 pi 的限制 | ✅ 多层防护（depth/tools/timeout/concurrency） |
| 落盘 | `~/.claude/projects/<id>/` | ✅ `~/.magenta/tmp/<workflow-id>/` |

我们不仅学到了 Claude 的灵活，还保留了安全优势和预设库的便利性。

---

现在开工？从 Phase 1 开始，我先写 `agent()` / `parallelAgents()` / `pipeline()` 三个原语函数。
