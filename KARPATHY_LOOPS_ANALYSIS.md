# Karpathy LOOPS.md 对 Magenta research-orchestration 的启示

## 核心共鸣点

### ✅ 已经做对的

1. **循环作为一级对象** (I. WRITE THE LOOP, NOT THE PROMPT)
   - ✅ 我们的 skill 明确了 PLAN → IMPLEMENT → OBSERVE → REFLECT → REFINE 循环
   - ✅ 循环是可见的、显式的结构
   - ✅ 每次迭代都标记 "Iteration N"

2. **角色分离** (II. SEPARATE THE ROLES)
   - ✅ 我们有 sub-agents 和 workflows 支持独立角色
   - ✅ 明确了 main agent 作为 orchestrator/synthesizer
   - ⚠️ 但没有强制 planner/generator/evaluator 三角色分离

3. **状态在磁盘上** (IV. WRITE TO DISK, NOT TO CONTEXT)
   - ✅ 我们强调 "named artifacts, traceable tool calls"
   - ✅ "explicit plans and interfaces"
   - ⚠️ 但没有明确要求特定的状态文件格式

4. **循环重启** (V. LET THE LOOP RESTART)
   - ✅ REFINE 步骤允许 "revise the plan and return to PLAN"
   - ✅ "If a blocker exists: state it clearly"
   - ✅ 没有阻止扔掉重来

---

## 关键差异与改进空间

### ❌ 我们缺少的

#### 1. **契约先行** (III. NEGOTIATE THE CONTRACT FIRST)
**Karpathy:**
```
Before generator writes a single line:
1. Generator proposes "what done looks like"
2. Evaluator pushes back
3. Argue via markdown on disk until agree on testable assertions
4. 27 criteria for small app, 10 too few
```

**我们当前:**
- ❌ 没有明确的 contract negotiation 步骤
- ❌ 没有 generator/evaluator 分离并协商
- ❌ 没有强制性的可测试断言清单

**改进建议:**
```
PLAN 阶段应该包括：
1. Draft contract (generator 提出完成标准)
2. Contract review (evaluator 质疑和推回)
3. Finalize contract (双方同意的断言清单)
4. 写入 contract.md 到磁盘

OBSERVE/REFLECT 阶段：
- 严格对照 contract.md 中的断言检查
```

#### 2. **标准化的磁盘状态** (IV. WRITE TO DISK, NOT TO CONTEXT)
**Karpathy 的具体文件：**
```
feature_list.json
progress.md
contract.md
log.md (append-only, ## [YYYY-MM-DD] op | title)
```

**我们当前:**
- ✅ 提到 "named artifacts"
- ❌ 但没有标准化的文件名和格式

**改进建议:**
```
在 research-orchestration skill 中明确要求：

workspace/
├── plan.md          (当前计划)
├── contract.md      (generator ↔ evaluator 协商的断言)
├── progress.md      (已完成 / 进行中 / 待办)
├── iterations.log   (append-only: ## [YYYY-MM-DD HH:MM] Iteration N | title)
└── artifacts/       (outputs, traces, test results)
```

#### 3. **主观评分标准** (VI. SCORE THE SUBJECTIVE)
**Karpathy:**
```
Four axes: design, originality, craft, functionality
Calibrate on 3 good examples + 3 slop examples
Output: score 0-1 + paragraph explaining gap
```

**我们当前:**
- ❌ REFLECT 阶段提到多个 lens，但没有具体的评分框架
- ❌ 没有校准样本

**改进建议:**
```
REFLECT 步骤应该包括：
- 4-5 个明确的评价维度（correctness, coverage, rigor, format-compliance, etc.）
- 每个维度 0-1 分 + 简短理由
- 总分和主要差距
- 写入 reflection.md
```

#### 4. **Trace 驱动调试** (VII. READ THE TRACES)
**Karpathy:**
```
Every debugging insight from reading raw transcript
Grep for divergence moment
Edit prompt for that exact moment
```

**我们当前:**
- ✅ "Inspect outputs, traces, intermediate artifacts"
- ❌ 但没有明确如何读 trace 和调试循环

**改进建议:**
```
OBSERVE 阶段增加：
- 将所有 sub-agent / workflow 输出保存为 traces/
- 在 REFLECT 时明确要求：
  "Read traces/ directory, grep for unexpected behavior,
   identify exact divergence point"
```

#### 5. **删除脚手架** (VIII. DELETE THE HARNESS)
**Karpathy:**
```
Re-read harness against each new model release
Delete anything model now does for free
```

**这是元级别的建议** — 适用于整个 Magenta harness，不仅是这个 skill。

---

## 具体改进建议：重写 research-orchestration

### 新增的关键步骤

#### PLAN 阶段新增
```markdown
1. PLAN
   a. Decompose task into concrete subproblems
   b. **Draft contract:** Generator proposes completion criteria
   c. **Contract review:** Spawn evaluator sub-agent to critique
   d. **Finalize contract:** Write agreed assertions to contract.md
   e. State hypotheses, risks, unknowns
   f. Write plan.md and progress.md
```

#### IMPLEMENT 阶段改进
```markdown
2. IMPLEMENT
   - **Role: Generator** (forbidden from grading own work)
   - Use real tools, not memory
   - Write all outputs to artifacts/
   - Update progress.md as work completes
```

#### OBSERVE 阶段改进
```markdown
3. OBSERVE
   - Collect all outputs, traces, errors
   - Save to artifacts/ and traces/
   - **Do NOT evaluate yet** — only observe facts
```

#### REFLECT 阶段改进
```markdown
4. REFLECT
   - **Role: Evaluator** (told code is broken, must prove it)
   - Read contract.md assertions one by one
   - For each assertion: PASS / FAIL / UNCLEAR + evidence
   - Score on 4 axes (0-1 each):
     * Correctness
     * Coverage (of contract)
     * Rigor (reproducibility, provenance)
     * Format compliance
   - Write reflection.md with scores + gap analysis
   - **Decision: continue or done?**
```

#### REFINE 阶段改进
```markdown
5. REFINE
   - If gaps exist: revise plan.md, back to PLAN
   - If contract was wrong: renegotiate contract, back to PLAN
   - If stuck after 3 iterations on same issue:
     * Consider full restart (delete artifacts/, keep contract.md)
   - Mark iteration in iterations.log:
     ## [2026-07-07 10:15] Iteration 3 | Refined error handling
   - If done: finalize output per user's format
```

---

## 改进后的文件结构

```
task-workspace/
├── plan.md              (current plan, updated each iteration)
├── contract.md          (generator ↔ evaluator agreed assertions)
├── progress.md          (✅ done / 🔄 in-progress / ⏳ todo)
├── iterations.log       (append-only chronology)
├── reflection.md        (latest scores + gap analysis)
├── artifacts/           (all outputs)
│   ├── iteration-1/
│   ├── iteration-2/
│   └── final/
└── traces/              (sub-agent outputs, tool logs)
    ├── generator-*.log
    └── evaluator-*.log
```

---

## Karpathy 的哲学 vs Magenta 的当前状态

| Dimension | Karpathy | Magenta 当前 | 改进方向 |
|-----------|----------|--------------|----------|
| **循环可见性** | 强制显式 | ✅ 已显式 | 保持 |
| **角色分离** | 严格三角色 | ⚠️ 可选 | 强制 generator/evaluator 分离 |
| **契约先行** | 必须协商 | ❌ 缺失 | **加入 contract negotiation** |
| **磁盘状态** | 4 个标准文件 | ⚠️ 模糊 | **标准化文件格式** |
| **主观评分** | 4 轴 + 校准 | ⚠️ 多 lens 但无分数 | **加入 0-1 评分** |
| **Trace 阅读** | 强调为核心技能 | ⚠️ 提到但不明确 | **明确 trace 驱动调试** |
| **删除脚手架** | 持续简化 | ⚠️ 未提及 | 元级别，适用全局 |
| **允许重启** | 鼓励扔掉重来 | ✅ 不阻止 | 明确鼓励 |

---

## 立即可行的改进

### 1. 最小改动（保留当前结构）
在当前的 5 步循环中注入 Karpathy 的关键实践：

```markdown
### PLAN
- [ ] Decompose task
- [ ] **NEW: Draft contract (generator proposes assertions)**
- [ ] **NEW: Contract review (evaluator critiques)**
- [ ] **NEW: Write contract.md to disk**
- [ ] Write plan.md, progress.md

### IMPLEMENT
- **NEW: Assign role "Generator" to this phase**
- **NEW: Forbidden from grading own work**
- Write to artifacts/

### OBSERVE
- Collect outputs, traces
- **NEW: Save to traces/ directory**
- Do NOT evaluate (that's REFLECT's job)

### REFLECT
- **NEW: Assign role "Evaluator"**
- **NEW: Read contract.md, check each assertion**
- **NEW: Score 0-1 on 4 axes, write reflection.md**
- Decide: continue or done?

### REFINE
- **NEW: If stuck 3x, consider full restart**
- **NEW: Append to iterations.log**
- Revise plan or finalize
```

### 2. 完全重写（采纳 Karpathy 模式）
创建一个新的 `iterative-agent-loop` skill，完全按照 Karpathy 的模式：
- 三角色强制分离
- 契约先行
- 标准化磁盘状态
- Trace 驱动调试

---

## 我的推荐

**保留 `research-orchestration` 当前名称**（你说不用改了），但：

1. **立即增强：** 注入 Karpathy 的关键实践（contract negotiation, 磁盘状态标准化, 评分框架）
2. **创建 assets/:**
   ```
   research-orchestration/
   ├── pi/
   │   └── SKILL.md (增强版)
   └── assets/
       ├── scripts/
       │   └── init_workspace.sh (创建标准文件结构)
       ├── references/
       │   └── karpathy_loops.md (这个文档)
       └── templates/
           ├── contract.md.template
           ├── plan.md.template
           ├── progress.md.template
           └── reflection.md.template
   ```

3. **在 SKILL.md 开头增加：**
   ```markdown
   ## Inspired by Karpathy's LOOPS.md
   
   This skill implements a long-running agent loop based on principles from
   Karpathy's "Field Notes on Agents That Run for Days":
   - Contract negotiation before code
   - Strict role separation (planner/generator/evaluator)
   - State on disk (plan.md, contract.md, progress.md, iterations.log)
   - Trace-driven debugging
   - Willingness to restart
   
   See `assets/references/karpathy_loops.md` for the original inspiration.
   ```

要我现在就动手改进 `research-orchestration` skill 吗？
