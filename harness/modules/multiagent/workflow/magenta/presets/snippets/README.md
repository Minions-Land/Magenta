# Workflow Snippets

Reusable code patterns for writing workflow scripts. These are not complete workflows — they are copy-paste building blocks that demonstrate the loop-discipline best practices.

## Available Snippets

### `contract-negotiation.ts`
The two-phase pattern for negotiating a testable contract before building:
1. Generator drafts completion criteria (numbered assertions)
2. Evaluator reviews and pushes back
3. Finalized contract written to disk / logged

Use this at the start of any multi-iteration loop where "done" is non-obvious. The contract becomes the grading rubric in REFLECT.

### `four-axis-scoring.ts`
The standard REFLECT pattern: score an artifact on four axes (correctness, coverage, rigor, format), each 0–1 with a one-line reason. Returns a total score and per-axis justifications.

Use this to grade IMPLEMENT output in the REFLECT phase. The scores drive the decision: iterate, finalize, or restart.

## How to Use

1. Read the snippet file — the header comment explains the pattern and where it fits in the loop.
2. Copy the function(s) into your workflow script (or import if you structure your script as modules).
3. Adapt the prompts / schema to your domain.
4. Call the function in the appropriate loop stage (PLAN for contract negotiation, REFLECT for scoring).

These snippets assume your workflow follows the plan → implement → observe → reflect → refine loop discipline from the research-orchestration skill. If you're writing a workflow from scratch, read `harness/modules/skills/research-orchestration/pi/SKILL.md` first.

## Principles Demonstrated

Each snippet embodies one or more of the loop principles:
- **Contract negotiation** → contract before code, separate the roles
- **Four-axis scoring** → score the subjective, separate the roles

See `harness/modules/skills/research-orchestration/pi/assets/references/loop-principles.md` for the theory.
