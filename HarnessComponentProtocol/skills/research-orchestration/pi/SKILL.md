---
name: research-orchestration
description: Make the plan -> implement -> observe -> reflect -> refine loop explicit for a complex task. Uses the session Todo as the single source of truth and delegates through workflows, sessionless sub-agents, or managed teammates when useful.
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

Seed the Todo in one atomic `apply` batch. Use its title for the task, its summary for the objective or current synthesis, nodes for testable completion criteria and work units, and node `status` values as the authoritative progress state. Multiple nodes may be `in_progress` during fan-out. `currentId` is only an optional foreground focus for the main agent; set it to `null` when no single work item owns foreground attention. Update Todo at meaningful status transitions, after a changed conclusion, or when foreground focus changes. Do not update it for every command.

Do not create or maintain `plan.md`, `progress.md`, `contract.md`, `reflection.md`, a second checklist, or an equivalent planning ledger. Context compaction is not a reason to duplicate state: the Todo is session-branch state and is the recovery point. If Todo is unavailable, keep the plan concise in the conversation and do not silently introduce a file-based substitute.

Files on disk are for actual deliverables, requested reports, datasets, reproducible experiments, or other task artifacts. They are not a second account of what is pending or complete. Raw tool and worker traces already live in the harness event infrastructure; inspect them there unless the user explicitly requests an exported trace artifact.

For a trivial task, skip persistent planning entirely.

## Loop Discipline

These constraints keep the loop convergent:

1. **Contract before implementation.** Add testable completion criteria to Todo before substantial work. Each criterion must be decidable as pass, fail, or unclear from evidence.
2. **One progress ledger.** Todo owns the plan, authoritative node statuses, optional foreground focus, and synthesis. Never dual-write progress to files or prose checklists.
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
- Mark every dispatched work unit `in_progress`; more than one may be in progress concurrently. Use `currentId` only for an optional foreground focus, and leave it `null` during fan-out when no single item is foreground.
- Keep independent work units separate enough to dispatch safely.
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

- Revise the Todo in one `apply` batch to reflect the evidence through node statuses; optionally select a foreground `currentId`, or clear it during fan-out.
- If the completion criteria were wrong, update them explicitly before continuing.
- If the same approach has failed twice, replace the approach instead of accumulating patches.
- Finish only when every required Todo criterion is complete, or mark the exact blocker and report what evidence or capability is missing.

## Distributed Execution

Use distributed execution when work units are independent or benefit from specialized review. This also enforces producer/evaluator separation.

### Capability topology

- `sub_agent` starts sessionless, one-shot workers. Use it for bounded research, review, test analysis, planning, or parallel tasks whose results return to the parent. A worker does not retain a session for another assignment.
- A `workflow` orchestrates those same sessionless, one-shot workers through named presets with fixed runtime-owned control flow. The public `sub_agent` facade does not execute model-authored inline JavaScript; trusted programmatic workflow modules remain an internal Harness capability.
- `teammate_agent` is the parent-managed control plane for long-lived child sessions. Use it when retained context or multiple follow-up assignments matter. For editing, request `workspace="worktree"`; its structured terminal receipt returns through `send_message` and external activation, after which the parent explicitly integrates or discards the captured Git changes. Parent shutdown stops children but preserves unintegrated work.
- `send_message` is the urgent mailbox data plane for any known peer session id. It does not create or manage a teammate; use `teammate_agent` for child lifecycle.
- Ultra selects the model's highest native reasoning level and enables workflow and managed-teammate capabilities by default. Its coalesced, rate-limited background stall reminder may wake the main loop after a real silent or overdue epoch. It never dispatches work automatically; the main agent still decides whether and how to delegate.

Run independent investigations in parallel when their inputs and file ownership do not conflict. Prefer read-only `sub_agent` workers for bounded analysis and synthesize their results in the main agent. Choose a managed teammate for multi-assignment continuity or non-overlapping edit ownership.

### Delegation ownership

Delegation uses **soft leases**, not runtime locks. Do not claim that the harness locks files, blocks `bash`, or prevents another actor from writing. Do not add a Todo owner schema or a separate lease registry; running events, delivered assignments, and Todo work-unit boundaries are the coordination evidence.

Acquire and honor leases as follows:

- A successful `sub_agent` or workflow dispatch leases its delegated analysis scope while its event is running. Read-only workers do not own files.
- A delivered teammate assignment leases its stated scope. For editing work, the assignment must name owned files or globs and should use `workspace="worktree"`. The linked checkout isolates ordinary Git paths, but it is not a security sandbox and does not intercept absolute-path writes.
- While a lease is active, do not redo the same task. The main agent may advance only non-overlapping Todo work, coordination, and integration preparation.
- A teammate becoming idle does not release its assignment lease. The matching structured terminal receipt arrives through `send_message` and external activation; do not poll status for completion.

Release and reclaim leases as follows:

- Release a normal worker lease only after its terminal result returns; then synthesize the result and independently verify it before integrating or reporting.
- On failure, timeout, cancellation, or teammate stop, reclaim the scope only after its terminal event or receipt arrives. An interrupt followed by a replacement assignment transfers the lease only after the interrupted turn is confirmed aborted.
- A structured teammate terminal receipt releases that assignment scope. For worktree edits, first let every relevant assignment become terminal, then request teammate stop and continue non-overlapping work. Integrate only after its automatic process-terminal event arrives, and independently verify the unstaged parent changes. Do not infer release from silence or idle status.

Use named workflow presets when their fixed control flow fits the problem:

- `adversarial_verify` for high false-positive-cost claims,
- `generate_and_filter` for competing candidates,
- `tournament` for pairwise subjective selection,
- `classify_and_act` for type-specific routing,
- `fan_out_synthesize` for the same check over many items,
- `loop_until_done` for bounded iteration that excludes prior findings.

Keep coordination, conflict resolution, Todo ownership, and final synthesis in the main agent. Workers and teammates do not maintain competing progress ledgers.

## Output Discipline

Keep process updates concise and operational. The Todo carries durable state; user-facing updates explain only what changed, what was learned, and what is next. The final answer should lead with the requested result and the verification that matters, not an exported copy of the Todo.

If evidence is insufficient or a capability cannot be called, mark the affected Todo item blocked and state the next verifiable step. Do not claim completion from intent alone.
