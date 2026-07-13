---
name: research-orchestration
description: Make the plan -> implement -> observe -> reflect -> refine loop explicit for a complex task. Uses the session Todo as the single source of truth for planning and progress, and fans independent work out to workflows, sub-agents, or agent teams when useful.
---

# Research Orchestration

A manual entrypoint that makes Magenta's normal research loop visible for the current task. Use it when the user asks to research a hard problem, wants independent work fanned out, or needs an explicit iterative process.

## Role

Act as the main agent: planner, orchestrator, dispatcher, and final synthesizer. You are responsible for:

- turning the objective into testable completion criteria,
- maintaining one coherent execution plan,
- selecting real, available tools,
- dispatching independent work when it improves coverage or role separation,
- observing outputs and failures,
- arranging an independent evaluation,
- refining or restarting when evidence rejects the current approach,
- producing the final answer in the requested format.

## One State Model

**Todo is the single source of truth for planning and progress.** For every non-trivial task, use the session Todo when the tool is available. Do not mirror its title, summary, completion criteria, current work, or statuses into another checklist or planning artifact.

The Todo protocol is exact:

- Read with `{"action":"get"}`.
- Mutate with `{"action":"apply","operations":[...]}`.
- Top-level `action` is only `get` or `apply`.
- Mutation verbs such as `add`, `update`, `set_status`, and `set_current` belong only in `operations[].op`.
- A single mutation is still one `apply` batch containing one operation. Never call the tool with a top-level action such as `{"action":"add"}`.

Seed the Todo in one atomic `apply` batch. Use its title for the task, its summary for the objective or current synthesis, nodes for testable completion criteria and work units, statuses for progress, and `currentId` for the active item. Update it at meaningful milestones, after a changed conclusion, or when the active item changes. Do not update it for every command.

Do not create or maintain `plan.md`, `progress.md`, `contract.md`, `reflection.md`, a second checklist, or an equivalent planning ledger. Context compaction is not a reason to duplicate state: the Todo is session-branch state and is the recovery point. If Todo is unavailable, keep the plan concise in the conversation and do not silently introduce a file-based substitute.

Files on disk are for actual deliverables, requested reports, datasets, reproducible experiments, or other task artifacts. They are not a second account of what is pending or complete. Raw tool and worker traces already live in the harness event infrastructure; inspect them there unless the user explicitly requests an exported trace artifact.

For a trivial task, skip persistent planning entirely.

## Loop Discipline

These constraints keep the loop convergent:

1. **Contract before implementation.** Add testable completion criteria to Todo before substantial work. Each criterion must be decidable as pass, fail, or unclear from evidence.
2. **One progress ledger.** Todo owns the plan, active item, status, and synthesis. Never dual-write progress to files or prose checklists.
3. **Separate production and evaluation.** The worker that produces an artifact must not be its only evaluator. Use an independent sub-agent, workflow verifier, or an explicit evaluator role grounded in the Todo criteria.
4. **Read the traces.** Diagnose failures from the raw worker or tool output. Find the first divergence instead of guessing from the final symptom.
5. **Restart beats repeated rescue.** If two iterations fail for the same reason, preserve the objective and completion criteria in Todo, discard the failed approach, and restart from a different hypothesis.

## Operating Loop

Run PLAN -> IMPLEMENT -> OBSERVE -> REFLECT -> REFINE until the Todo completion criteria pass or a real blocker remains.

### 1. PLAN

- Read the current Todo before changing it.
- Clarify the objective and constraints.
- Draft testable completion criteria and have an independent evaluator challenge omissions or ambiguity when risk warrants it.
- Seed or revise the Todo with one atomic `apply` batch.
- Set one current item. Keep independent work units separate enough to dispatch safely.
- Record hypotheses only when they affect an upcoming decision; put the current synthesis in the Todo summary rather than a parallel note.

### 2. IMPLEMENT

- Act as the generator, not the grader.
- Use real Magenta capabilities rather than remembered or invented interfaces.
- Produce task artifacts in their natural locations.
- Update Todo only when a work unit reaches a meaningful state transition: `in_progress`, `completed`, `blocked`, or materially revised.

### 3. OBSERVE

- Collect facts from commands, tests, worker returns, screenshots, external sources, or runtime behavior.
- Inspect raw traces when behavior diverges.
- Keep evidence with the real artifact or test output. Do not copy status into a progress file.

### 4. REFLECT

- Switch to an evaluator role or dispatch an independent evaluator.
- Walk the Todo completion criteria and classify each as pass, fail, or unclear from concrete evidence.
- Mark only demonstrated criteria completed. Keep failed work pending or blocked and summarize the largest remaining gap in the Todo summary.
- Evaluate correctness, coverage, rigor, and requested-format compliance when those dimensions matter, without creating a separate reflection ledger.

### 5. REFINE

- Revise the Todo in one `apply` batch to reflect the evidence and select the next current item.
- If the completion criteria were wrong, update them explicitly before continuing.
- If the same approach has failed twice, replace the approach instead of accumulating patches.
- Finish only when every required Todo criterion is complete, or mark the exact blocker and report what evidence or capability is missing.

## Distributed Execution

Use distributed execution when work units are independent or benefit from specialized review. This also enforces producer/evaluator separation.

- Run independent investigations in parallel when their inputs and file ownership do not conflict.
- Prefer read-only sub-agents for research, review, test analysis, and alternative designs; synthesize their results in the main agent.
- Use persistent teammates only when retained context across multiple assignments is valuable, and assign non-overlapping ownership if they edit.
- Use workflow patterns when their deterministic control flow fits the problem:
  - `adversarial_verify` for high false-positive-cost claims,
  - `generate_and_filter` for competing candidates,
  - `tournament` for pairwise subjective selection,
  - `classify_and_act` for type-specific routing,
  - `fan_out_synthesize` for the same check over many items,
  - `loop_until_done` for bounded iteration that excludes prior findings.
- Keep coordination, conflict resolution, Todo ownership, and final synthesis in the main agent. Workers do not maintain competing progress ledgers.

## Output Discipline

Keep process updates concise and operational. The Todo carries durable state; user-facing updates explain only what changed, what was learned, and what is next. The final answer should lead with the requested result and the verification that matters, not an exported copy of the Todo.

If evidence is insufficient or a capability cannot be called, mark the affected Todo item blocked and state the next verifiable step. Do not claim completion from intent alone.
