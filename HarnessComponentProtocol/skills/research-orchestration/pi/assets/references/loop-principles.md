# Loop Principles

The theoretical basis for research-orchestration's loop discipline. These notes explain why a long-running agent loop converges instead of spinning.

## The core shift: write the loop, not the prompt

A prompt is used once. A loop is a procedure that repeatedly gathers evidence, reasons, acts, verifies, and refines. Once a model can follow a procedure without constant supervision, the procedure becomes the durable unit of leverage.

Durable does not mean duplicated. The loop needs one state owner that survives context compaction and branch navigation. In Magenta that owner is the session Todo.

## The eight principles

### 1. Separate the roles

A generator produces work. An evaluator assumes the result may be wrong and tries to prove where it fails. Mixing those roles makes evaluation drift toward the producer's intent instead of the observable result. Use an independent worker when the cost of a false pass is meaningful.

### 2. Negotiate the contract first

Before substantial implementation, turn "done" into testable assertions and let an evaluator challenge ambiguity, omissions, and weak edge cases. Store the agreed criteria as Todo nodes so the same assertions drive planning, execution, and final grading.

### 3. Keep one state owner

Multiple progress ledgers disagree. A session Todo already carries the task title, summary, hierarchy, current item, statuses, revision, and branch-local persistence. It therefore owns planning and progress. Do not mirror that state into `plan.md`, `progress.md`, `contract.md`, `reflection.md`, prose checklists, or another tracker.

Disk remains appropriate for actual artifacts: code, requested reports, datasets, experiment outputs, and reproducible evidence. Those artifacts support the Todo; they do not restate its status.

### 4. Let the loop restart

A strong loop can abandon an approach when evidence rejects it. Preserve the objective and completion criteria in Todo, replace the failed work units, and rebuild from a different hypothesis. Repeatedly patching the same failed foundation hides the actual error.

### 5. Score the subjective

Subjective quality becomes more tractable when evaluated against named axes and references. Correctness, coverage, rigor, and format compliance are useful defaults. Record the actionable conclusion in the Todo summary and statuses; create a separate report only when that report is itself a requested deliverable.

### 6. Read the traces

Most debugging insight comes from raw worker and tool output. Find the first point where behavior departed from the contract, then fix that decision. The harness already retains event and worker traces, so inspect them there instead of copying them into a second state directory.

### 7. The bottleneck moves

When implementation becomes easy, planning becomes the bottleneck. When planning improves, verification becomes the bottleneck. When verification is automated, judgment becomes the bottleneck. The explicit loop and current Todo item make that movement visible.

### 8. Delete scaffolding

Harness structure exists to compensate for limitations. Re-evaluate it as capabilities improve and remove redundant state, templates, and handoffs. A structure that only grows is no longer being designed.

## Mapping to the loop

- **PLAN** negotiates criteria and seeds or revises the Todo.
- **IMPLEMENT** enforces the generator role and changes real artifacts.
- **OBSERVE** collects evidence and reads traces.
- **REFLECT** independently grades the Todo criteria.
- **REFINE** updates the one Todo ledger, changes the approach, and selects the next current item.

The cadence remains PLAN -> IMPLEMENT -> OBSERVE -> REFLECT -> REFINE. The Todo is the only planning and progress record across all five stages.
