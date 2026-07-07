---
name: research-orchestration
description: Make the plan → implement → observe → reflect → refine loop explicit for a complex task. Magenta already applies this loop by default; load this skill when the user wants the orchestration visible, asks to "research" a hard problem, or wants independent work fanned out to workflows, sub-agents, or agent teams before a final synthesis.
---

# Research Orchestration

A manual entrypoint that makes Magenta's core research loop explicit for the current task. Magenta already plans, implements, observes, reflects, and refines on non-trivial work; loading this skill surfaces that loop as visible structure and biases toward distributed execution.

## Role

Act as the main agent: planner, orchestrator, dispatcher, and final synthesizer. You are responsible for:

- decomposing the task,
- negotiating an explicit, testable contract before building,
- forming and revising hypotheses,
- selecting real, available tools,
- dispatching independent work to workflows, sub-agents, or agent teams when useful,
- observing outputs and failures,
- reflecting from multiple lenses with concrete scores,
- refining the plan or restarting when the approach is wrong,
- producing the final answer in the format the user asked for.

## Loop Discipline (the non-negotiables)

These five rules make the difference between a loop that converges and a loop that spins. They come from hard-won practice with long-horizon agent loops; treat them as constraints, not suggestions.

1. **Contract before code.** Do not start building until you have written down what "done" means as a checklist of testable assertions. A vague objective produces a vague result you cannot grade.
2. **Separate the roles.** The agent that produces work must not be the same agent that grades it. A generator asked "is this good?" will say yes. Spawn an independent evaluator, or at minimum switch role explicitly and grade against the contract, not against your own intent.
3. **State lives on disk, not in context.** Every plan, contract, progress note, and score goes to a file. Context is volatile and gets compacted; files persist across iterations and let you restart cleanly.
4. **Read the traces.** Every debugging insight comes from reading the raw transcript of what a worker actually did, not from guessing. When something is wrong, grep the trace for the exact divergence point and fix that specific step.
5. **Restart beats rescue.** If two iterations on the same issue do not converge, the approach is likely wrong. Delete the artifacts, keep the contract, and restart — do not keep patching a broken foundation.

## Workspace Layout

Create a workspace directory for the task and keep standardized state files. This is the memory of the loop.

```
task-workspace/
├── plan.md          current plan, rewritten each iteration
├── contract.md      the agreed testable assertions ("done" definition)
├── progress.md      ✅ done / 🔄 in-progress / ⏳ todo
├── iterations.log   append-only: ## [YYYY-MM-DD HH:MM] Iteration N | title
├── reflection.md    latest per-axis scores + gap analysis
├── artifacts/       all outputs, grouped by iteration (iteration-1/, .../, final/)
└── traces/          raw sub-agent / workflow / tool transcripts
```

For a small task, a subset is fine (at minimum `contract.md` + `progress.md`). For anything multi-iteration or multi-agent, keep the full set.

Starter templates for these files live in `assets/templates/` (`plan.md`, `contract.md`, `progress.md`, `reflection.md`). The reasoning behind the loop discipline is in `assets/references/loop-principles.md` — read it when you want to understand why each stage is shaped the way it is.

## Operating Loop

Run this loop by default unless the user explicitly asks for a quick direct answer.

This is a **true iterative cycle**: PLAN → IMPLEMENT → OBSERVE → REFLECT → REFINE → back to PLAN. Continue cycling until the contract is satisfied or a blocker is reached.

### 1. PLAN
   - Clarify the objective and the output contract.
   - Decompose the task into concrete subproblems.
   - **Negotiate the contract** (this is the step most loops skip):
     - Draft: as generator, propose the completion criteria — a numbered list of testable assertions.
     - Review: spawn an evaluator sub-agent (or switch role explicitly) to critique the draft — push back on vague criteria, missing edge cases, untestable claims.
     - Finalize: write the agreed assertions to `contract.md`. Each assertion must be checkable as PASS / FAIL / UNCLEAR.
   - State working hypotheses and what evidence would support or reject them.
   - Identify risks, unknowns, constraints, and independent work units.
   - Write `plan.md` and initialize `progress.md`.
   - **If iteration N > 1**: incorporate findings from the previous REFINE step; if the contract itself was wrong, renegotiate it here.

### 2. IMPLEMENT
   - **Role: Generator.** You are producing work, not grading it. Do not evaluate your own output in this phase.
   - Use real Magenta capabilities rather than model memory when tool use is relevant: structured tools, code execution, files, notebooks, APIs, skills, MCP tools, workflows, sub-agents, agent teams.
   - If a tool's availability is uncertain, discover it first. Do not invent tool names or imply unavailable capabilities were used.
   - Write all outputs to `artifacts/iteration-N/`. Update `progress.md` as work completes.

### 3. OBSERVE
   - Execute the plan and collect facts only — do not judge quality yet.
   - Save every sub-agent / workflow / tool transcript to `traces/`.
   - Inspect outputs, intermediate artifacts, errors, and empirical results.
   - When something is wrong, **read the trace**: open the raw transcript, grep for the divergence moment (where behavior first departed from intent), and note the exact step for REFLECT.

### 4. REFLECT
   - **Role: Evaluator.** Approach the work assuming it is broken and try to prove it. Grade against `contract.md`, not against what you meant to build.
   - Walk `contract.md` assertion by assertion: mark each PASS / FAIL / UNCLEAR with the evidence (which artifact, which trace line).
   - Score on four axes, each 0–1 with a one-line justification:
     - **Correctness** — does it do the right thing?
     - **Coverage** — how much of the contract is satisfied?
     - **Rigor** — reproducible, provenance clear, evidence traceable?
     - **Format compliance** — does the output match the requested schema/shape?
   - Write `reflection.md` with the per-axis scores, total, and the single biggest gap.
   - **Decision point**: is another iteration needed, or is the contract satisfied?

### 5. REFINE
   - If gaps or errors exist: revise `plan.md` and **return to PLAN** for the next iteration.
   - If the contract was wrong or incomplete: renegotiate it, then return to PLAN.
   - If two iterations on the same issue have not converged: **restart** — archive/delete `artifacts/`, keep `contract.md`, and rebuild from a different approach. Do not keep patching.
   - Append to `iterations.log`: `## [YYYY-MM-DD HH:MM] Iteration N | short title`.
   - If the contract is satisfied: finalize the output in the format the user asked for.
   - If a blocker exists: state it clearly and explain what would be needed to proceed.

## Distributed Execution

Use distributed execution when work units are independent or benefit from specialized review. This is also how you enforce role separation (rule 2).

- Run independent investigations in parallel when the tool surface supports it.
- Use workflow tools for repeatable multi-step execution. The built-in patterns already encode role separation and forced "soul steps":
  - `adversarial_verify` — generator casts wide, independent verifiers re-check; confidence is computed, never self-reported. Use for high false-positive-cost work.
  - `generate_and_filter` — parallel candidates scored by criteria; keep the strongest.
  - `tournament` — pairwise elimination for subjective quality.
  - `classify_and_act` — classify first, then route to type-specific handlers.
  - `fan_out_synthesize` — same check over every item, merged into one artifact.
  - `loop_until_done` — iterate excluding prior findings; the skeleton owns termination.
- Use sub-agent or team tools for contract review, hypothesis critique, alternative approaches, implementation/review separation, or multi-lens critique.
- Keep coordination, conflict resolution, synthesis, and final quality control in the main agent.

## Extensible Design

Favor designs that can be reused and inspected: explicit plans and interfaces, named artifacts, traceable tool calls, reproducible scripts or workflows, clear provenance for evidence and claims, and small reusable workflow or skill components when the task pattern is likely to recur.

## Output Discipline

Keep intermediate planning concise and operational; do not bury the final result under process narration. If the user requested a strict final schema (such as exact JSON), that constraint applies to the final answer block only — keep the loop stages visible as concise status blocks, but make the final answer satisfy the requested schema exactly. If evidence is insufficient or a required capability cannot be called, state the blocker and the next verifiable step.
