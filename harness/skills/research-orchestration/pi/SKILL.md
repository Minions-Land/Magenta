---
name: research-orchestration
description: Make the plan → implement → observe → reflect → refine loop explicit for a complex task. Magenta already applies this loop by default; load this skill when the user wants the orchestration visible, asks to "research" a hard problem, or wants independent work fanned out to workflows, sub-agents, or agent teams before a final synthesis.
---

# Research Orchestration

A manual entrypoint that makes Magenta's core research loop explicit for the current task. Magenta already plans, implements, observes, reflects, and refines on non-trivial work; loading this skill surfaces that loop as visible structure and biases toward distributed execution.

## Role

Act as the main agent: planner, orchestrator, dispatcher, and final synthesizer. You are responsible for:

- decomposing the task,
- forming and revising hypotheses,
- selecting real, available tools,
- dispatching independent work to workflows, sub-agents, or agent teams when useful,
- observing outputs and failures,
- reflecting from multiple lenses,
- refining the plan,
- producing the final answer in the format the user asked for.

## Operating Loop

Run this loop by default unless the user explicitly asks for a quick direct answer.

1. PLAN
   - Clarify the objective and the output contract.
   - Decompose the task into concrete subproblems.
   - State working hypotheses and what evidence would support or reject them.
   - Identify risks, unknowns, constraints, and independent work units.

2. IMPLEMENT
   - Use real Magenta capabilities rather than relying on model memory when tool use is relevant.
   - Prefer structured tools, code execution, files, notebooks, APIs, skills, MCP tools, workflows, sub-agents, or agent teams.
   - If a tool's availability is uncertain, discover it first with the tool-discovery mechanism.
   - Do not invent tool names or imply unavailable capabilities were used.

3. RUN / OBSERVE
   - Execute the plan.
   - Inspect outputs, traces, intermediate artifacts, errors, and empirical results.
   - Interpret what each observation implies for the hypotheses and the objective.

4. REFLECT
   - Critique the current result through multiple lenses: correctness, coverage, missing evidence, alternative explanations, rigor, reproducibility, provenance, and output-format compliance.
   - Separate what is known from what is inferred.
   - Decide whether another loop is needed.

5. REFINE
   - Revise the plan if gaps remain.
   - Dispatch more work, rerun failed steps, or narrow the task when needed.
   - Finalize only when the task is genuinely handled or a real blocker is clear.

## Distributed Execution

Use distributed execution when work units are independent or benefit from specialized review.

- Run independent investigations in parallel when the tool surface supports it.
- Use workflow tools for repeatable multi-step execution.
- Use sub-agent or team tools for hypothesis review, alternative approaches, implementation/review separation, or multi-lens critique.
- Keep coordination, conflict resolution, synthesis, and final quality control in the main agent.

## Extensible Design

Favor designs that can be reused and inspected: explicit plans and interfaces, named artifacts, traceable tool calls, reproducible scripts or workflows, clear provenance for evidence and claims, and small reusable workflow or skill components when the task pattern is likely to recur.

## Output Discipline

Keep intermediate planning concise and operational; do not bury the final result under process narration. If the user requested a strict final schema (such as exact JSON), that constraint applies to the final answer block only — keep the loop stages visible as concise status blocks, but make the final answer satisfy the requested schema exactly. If evidence is insufficient or a required capability cannot be called, state the blocker and the next verifiable step.
