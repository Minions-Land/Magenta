# Magenta Multi-Agent Proposal

Status: Working draft

This proposal records only decisions confirmed in discussion. New decisions are added one at a time.

## Decision 1: No Blocking Wait

**Accepted.** The model-visible multi-agent API must not expose an operation that keeps a tool call open while an agent, workflow, assignment, cancellation, or timeout settles.

Required behavior:

- Starting multi-agent work returns after the background event has been registered.
- Completion, failure, timeout, and cancellation settlement happen asynchronously.
- Terminal results return through Magenta's external-activation path.
- Status inspection is an immediate snapshot, not a polling or waiting mechanism.
- When the principal agent has no independent work, it ends the current turn and is reactivated by the terminal event.
- A blocking wait implementation may remain only as an internal compatibility path and must be disabled by default.
- Blocking wait must be absent from model-visible tool schemas, descriptions, prompt guidelines, and recommended workflows.

This does not prohibit internal runtime promises or host-level shutdown settlement. It prohibits blocking wait semantics in the model-facing multi-agent tool.

## Decision 2: One Model-Visible Multiagent Tool

**Accepted.** Static workflow execution and persistent dynamic-team collaboration must be exposed to the model through one tool named `multiagent`.

Required behavior:

- The existing `sub_agent` and `teammate_agent` model-facing tools are replaced rather than retained as compatibility APIs.
- There is no `subagent` domain concept. A former sub-agent call is represented as a single-node static workflow.
- A multi-node static workflow uses the same execution model as a single-node workflow.
- Unifying the public tool does not require collapsing static workflow execution and persistent dynamic-team lifecycle into one internal state machine.

## Decision 3: Subagent Is a Workflow Template

**Accepted.** `subagent` remains only as the name of a built-in static workflow template. It is not a separate tool, controller concept, or agent type.

Required behavior:

- The model-visible static workflow set contains seven built-in templates: the existing six presets plus `subagent`.
- The trusted internal `script` workflow is not counted as one of these seven model-visible templates.
- The `subagent` template contains exactly one sessionless, one-shot worker node.
- Its final workflow output is that worker node's result, with no synthesizer or additional orchestration step.
- It runs through the same workflow execution, timeout, cancellation, observability, and background terminal-event path as every other static workflow.

## Decision 4: Strict Delegation Hierarchy

**Accepted.** Multi-agent delegation follows a strict three-tier hierarchy: main session, stateful teammate session, then sessionless workflow execution. Delegation may move only downward; same-level recursion and upward creation are prohibited.

Required behavior:

- The main session is the root authority. It may create and manage teammates and may start workflows directly.
- A teammate is a persistent, stateful child session owned by the main session.
- A teammate may start workflows, but it may not create or manage another teammate or team.
- A workflow is the leaf execution layer. Its workers may not start another workflow or create or manage teammates or teams.
- A workflow launched directly by the main session and one launched by a teammate use the same workflow runtime and leaf-level capability restrictions.
- Runtime-owned spawning of the predefined worker nodes inside a static workflow is part of that workflow's execution and is not recursive model-visible delegation.
- The main session retains supervisory visibility and control over teammate-owned descendant workflow runs.

## Decision 5: No First-Class Team Resource

**Accepted.** The unified multi-agent surface does not introduce a public Team resource. The main session directly owns and manages its persistent teammates; a "team" is only the implicit collaboration formed by those main-owned teammates, not an independently addressable aggregate.

Required behavior:

- The model-visible API has no `TeamHandle`, `teamId`, `team_create`, or independent Team lifecycle operations.
- The main session creates, addresses, and manages teammates directly through the unified `multiagent` tool.
- Each teammate belongs directly to one main session and retains its own persistent session state.
- Teammates may start leaf workflows under the delegation restrictions in Decision 4.
- `subagent` remains a single-node workflow template; unification covers workflow execution and persistent teammate collaboration without adding a new Team orchestration domain.
- Shared task coordination, if added, is scoped to the main session and its teammates rather than owned by a separate Team resource. Its concrete semantics remain a later decision.
- Internal indexing or grouping metadata may exist, but it must not create a separately addressable public Team identity or lifecycle.

## Decision 6: Main Todo Is the Team Board

**Accepted.** Each main session has one implicit team consisting of all teammates it directly owns. The main session's existing Todo is the only authoritative board for work coordinated with those teammates; the unified multi-agent design does not add a separate Team Todo or support multiple isolated teams.

Required behavior:

- There is no team-scoped Todo, task-board handle, team namespace, or per-team planning lifecycle.
- All teammates owned by one main session participate in the same coordination scope represented by that main session's Todo.
- The main session remains the human-facing coordination owner and reconciles teammate assignments, progress, and results into that Todo.
- Assignments and progress may travel through messages, but they must not create a second source of planning truth.
- Whether teammates may propose or directly mutate Todo entries is a separate access-control decision; it does not require another board.
- Supporting multiple isolated teams in one main session is outside the design and would require a new explicit decision.

## Decision 7: One AgentNode, Runtime-Owned Protocols

**Accepted.** Magenta's multi-agent runtime has one agent execution primitive, `AgentNode`. Subagent, the seven static workflow templates, and persistent teammate collaboration are not separate agent implementation types; their semantic differences are expressed through trusted runtime-owned protocols, context policy, routing policy, and lifecycle policy.

Required behavior:

- Model/provider selection, tools, packages, cwd/workspace, context construction, model execution, usage collection, and final-output capture use the common `AgentNode` abstraction.
- The `subagent` protocol binds exactly one clean-context, sessionless, one-shot AgentNode and automatically returns its final output before reclaiming the node.
- Static workflow protocols bind one or more clean-context AgentNodes while runtime code owns branch, barrier, ranking, threshold, loop, cancellation, and terminal semantics.
- The teammate protocol binds a retained-context AgentNode to a persistent Session with a reentrant mailbox and explicit lifecycle control.
- Unifying AgentNode does not make every node a persistent teammate and does not require one internal lifecycle state machine.
- A model is not required to call a message tool to return its final result; the runtime captures final output and converts it into the protocol result path.
- Model-authored messages are a data-plane capability. They cannot replace runtime-owned workflow control, hard timeout, cancellation, or deterministic settlement.
