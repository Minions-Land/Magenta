# Magenta Multi-Agent Proposal

Status: Working draft

This document has two deliberately separate layers:

- The **Accepted Decision Ledger** is normative. New decisions are added one at a time only after explicit confirmation.
- The **Integrated Candidate Design** is a discussion draft. It combines the accepted constraints into one concrete architecture, but none of that section is accepted merely because it appears here.

## Accepted Decision Ledger

### Decision 1: No Blocking Wait

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

### Decision 2: One Model-Visible Multiagent Tool

**Accepted.** Static workflow execution and persistent dynamic-team collaboration must be exposed to the model through one tool named `multiagent`.

Required behavior:

- The existing `sub_agent` and `teammate_agent` model-facing tools are replaced rather than retained as compatibility APIs.
- There is no `subagent` domain concept. A former sub-agent call is represented as a single-node static workflow.
- A multi-node static workflow uses the same execution model as a single-node workflow.
- Unifying the public tool does not require collapsing static workflow execution and persistent dynamic-team lifecycle into one internal state machine.

### Decision 3: Subagent Is a Workflow Template

**Accepted.** `subagent` remains only as the name of a built-in static workflow template. It is not a separate tool, controller concept, or agent type.

Required behavior:

- The model-visible static workflow set contains seven built-in templates: the existing six presets plus `subagent`.
- The trusted internal `script` workflow is not counted as one of these seven model-visible templates.
- The `subagent` template contains exactly one sessionless, one-shot worker node.
- Its final workflow output is that worker node's result, with no synthesizer or additional orchestration step.
- It runs through the same workflow execution, timeout, cancellation, observability, and background terminal-event path as every other static workflow.

### Decision 4: Strict Delegation Hierarchy

**Accepted.** Multi-agent delegation follows a strict three-tier hierarchy: main session, stateful teammate session, then sessionless workflow execution. Delegation may move only downward; same-level recursion and upward creation are prohibited.

Required behavior:

- The main session is the root authority. It may create and manage teammates and may start workflows directly.
- A teammate is a persistent, stateful child session owned by the main session.
- A teammate may start workflows, but it may not create or manage another teammate or team.
- A workflow is the leaf execution layer. Its workers may not start another workflow or create or manage teammates or teams.
- A workflow launched directly by the main session and one launched by a teammate use the same workflow runtime and leaf-level capability restrictions.
- Runtime-owned spawning of the predefined worker nodes inside a static workflow is part of that workflow's execution and is not recursive model-visible delegation.
- The main session retains supervisory visibility and control over teammate-owned descendant workflow runs.

### Decision 5: No First-Class Team Resource

**Accepted.** The unified multi-agent surface does not introduce a public Team resource. The main session directly owns and manages its persistent teammates; a "team" is only the implicit collaboration formed by those main-owned teammates, not an independently addressable aggregate.

Required behavior:

- The model-visible API has no `TeamHandle`, `teamId`, `team_create`, or independent Team lifecycle operations.
- The main session creates, addresses, and manages teammates directly through the unified `multiagent` tool.
- Each teammate belongs directly to one main session and retains its own persistent session state.
- Teammates may start leaf workflows under the delegation restrictions in Decision 4.
- `subagent` remains a single-node workflow template; unification covers workflow execution and persistent teammate collaboration without adding a new Team orchestration domain.
- Shared task coordination, if added, is scoped to the main session and its teammates rather than owned by a separate Team resource. Its concrete semantics remain a later decision.
- Internal indexing or grouping metadata may exist, but it must not create a separately addressable public Team identity or lifecycle.

### Decision 6: Main Todo Is the Team Board

**Accepted.** Each main session has one implicit team consisting of all teammates it directly owns. The main session's existing Todo is the only authoritative board for work coordinated with those teammates; the unified multi-agent design does not add a separate Team Todo or support multiple isolated teams.

Required behavior:

- There is no team-scoped Todo, task-board handle, team namespace, or per-team planning lifecycle.
- All teammates owned by one main session participate in the same coordination scope represented by that main session's Todo.
- The main session remains the human-facing coordination owner and reconciles teammate assignments, progress, and results into that Todo.
- Assignments and progress may travel through messages, but they must not create a second source of planning truth.
- Whether teammates may propose or directly mutate Todo entries is a separate access-control decision; it does not require another board.
- Supporting multiple isolated teams in one main session is outside the design and would require a new explicit decision.

### Decision 7: One AgentNode, Runtime-Owned Protocols

**Accepted.** Magenta's multi-agent runtime has one agent execution primitive, `AgentNode`. Subagent, the seven static workflow templates, and persistent teammate collaboration are not separate agent implementation types; their semantic differences are expressed through trusted runtime-owned protocols, context policy, routing policy, and lifecycle policy.

Required behavior:

- Model/provider selection, tools, packages, cwd/workspace, context construction, model execution, usage collection, and final-output capture use the common `AgentNode` abstraction.
- The `subagent` protocol binds exactly one clean-context, sessionless, one-shot AgentNode and automatically returns its final output before reclaiming the node.
- Static workflow protocols bind one or more clean-context AgentNodes while runtime code owns branch, barrier, ranking, threshold, loop, cancellation, and terminal semantics.
- The teammate protocol binds a retained-context AgentNode to a persistent Session with a reentrant mailbox and explicit lifecycle control.
- Unifying AgentNode does not make every node a persistent teammate and does not require one internal lifecycle state machine.
- A model is not required to call a message tool to return its final result; the runtime captures final output and converts it into the protocol result path.
- Model-authored messages are a data-plane capability. They cannot replace runtime-owned workflow control, hard timeout, cancellation, or deterministic settlement.

### Decision 8: HCP Is the Internal Multiagent Boundary

**Accepted.** The model-visible `multiagent` tool is a product facade over one source-selected HCP `multiagent` capability. `HcpServer` defines the stable internal contract, `HcpMagnet` binds a concrete provider implementation, and every Subagent, static workflow, and persistent teammate path must enter through that capability rather than retaining a separate model-facing or direct-spawn business path.

Required behavior:

- Models call only the product-level `multiagent` tool and never address HcpServer, HcpMagnet, or provider implementations directly.
- The tool resolves the active `multiagent` capability through HcpClient and delegates protocol execution and control to the selected provider.
- HcpServer owns the provider-neutral capability contract, discovery surface, and internal routing boundary.
- HcpMagnet owns source-specific construction and binding of a provider implementation.
- Provider selection and replacement must not change the model-visible tool identity or create compatibility aliases.
- Plain one-shot Subagent execution, the seven finite protocols, and the persistent teammate protocol may not bypass the HCP capability through independent controllers or direct-spawn business logic.
- Host-specific process invocation may be injected through a provider adapter, but protocol semantics, settlement, supervision, and observability remain behind the HCP boundary.

### Decision 9: Tool Facade, Capability Core

**Accepted.** Multiagent remains an independent Harness Capability owned by the `multiagent` Module. The `tools/multiagent` Module owns only the single model-visible Tool facade and binds the already-assembled `capability:multiagent`; the runtime is not moved wholesale into the Tool product.

Required behavior:

- `multiagent` and `tools/multiagent` are separate real Modules with separate HcpServers and one-product Source Magnets.
- The Capability owns AgentNode execution, protocol control, messaging, supervision, Session and teammate lifecycle, settlement, and runtime observability.
- The Tool owns the provider-facing flat schema, model-input validation and normalization, typed command dispatch, immediate acknowledgement rendering, and Tool-result presentation.
- During assembly, the Tool Source declares and resolves its dependency on `capability:multiagent`, retains the resulting live runtime reference, and calls it directly after assembly; HCP does not become per-call middleware.
- Tool visibility and runtime existence are independent. Denying the model access to `tool:multiagent` does not destroy or disable the supervising Capability.
- The Magenta Capability's `subagent` protocol becomes the canonical clean-context, sessionless, one-shot behavior. The existing Pi Subagent controller is not retained as a second production provider or compatibility path.
- Existing Pi agent-loop, model, Session, RPC, process, and TUI primitives may remain reusable dependencies behind public APIs or injected host adapters. Reusing them does not make the Magenta-owned protocol runtime a Pi Source.
- Adding a separately selectable Pi multiagent Source later requires a new explicit product decision. It is not retained speculatively for migration, fallback, or backward compatibility.

### Decision 10: Protocol Is the Public Semantic Selector

**Accepted.** A `start` request selects a trusted runtime-owned execution contract through the public `protocol` field. `topology` is not a model-authored selector; it is internal protocol data or runtime-derived observability.

Required behavior:

- `action=start` requires a supported `protocol` after runtime validation. The selected name resolves to a registered descriptor whose slots, routing, lifecycle, context, mailbox, authority, child permissions, limits, and terminal semantics are fixed by trusted runtime code.
- The model cannot submit or override `topology`, `lifecycle`, `context`, `mailbox`, `authority`, allowed child protocols, or termination conditions.
- `protocol` describes the complete execution semantics, not merely the allowed message edges. Topology is derived from the selected descriptor and may be returned as status metadata.
- Non-start actions identify an existing finite event or persistent Session and do not require the model to repeat `protocol`; the runtime resolves the existing ProtocolInstance from that target.
- The provider-facing root schema may keep `protocol` structurally optional to remain flat, but conditional action validation must reject a start request without it or with an unsupported value.
- The public protocol namespace spans both finite workflows and persistent collaboration. `subagent` is the single-node finite protocol; the six deterministic presets are finite protocols; the persistent protocol is named `teammate`.

### Decision 11: Persistent Protocol Is Named Teammate

**Accepted.** The public persistent collaboration protocol is named `teammate`. It represents one Main-owned, retained-context, reentrant Agent endpoint; it does not introduce a Team resource or imply an unrestricted peer-to-peer conversation network.

Required behavior:

- `action=start` with `protocol: "teammate"` creates exactly one persistent peer endpoint under the calling Main Session.
- The teammate retains its Session history, accepts reentrant assignments through its mailbox, and has explicit stop/resume lifecycle control.
- Only the Main Session may create or manage its direct teammates. A teammate may start finite protocols but may not create another teammate or Team.
- The name `teammate` identifies a protocol and owned endpoint, not a `TeamHandle`, `teamId`, Team Todo, or independently addressable Team aggregate.
- `open_conversation` is not a current model-visible protocol. It remains available only as a possible future protocol name if Magenta later supports ownerless or federated peer sessions with separately accepted identity and authorization semantics.

### Decision 12: Model Input Is Not a Trusted Node Binding

**Accepted.** The provider-facing node object describes only a protocol slot, task content, and constrained execution preferences. The runtime converts that input into a separate trusted node binding; identity, authority, routing, grants, output contracts, correlation, lifecycle, and terminal semantics are never model-authored fields.

The model-visible node fields are:

- required `slot` and `instruction`;
- optional `key` and protocol-authorized `count`;
- optional `role` and `focus` prompt metadata;
- optional `model` and `thinking` execution preferences;
- optional `tools`, `packages`, `cwd`, `workspace`, and `attemptTimeoutSeconds` constrained resource preferences.

Required behavior:

- The public node input has no `id` and no separate `provider` field. A host-defined `model` reference may encode a model pattern or provider/model pair without exposing HCP Source selection.
- Requested tools, packages, workspace, cwd, model, thinking, and timeout values are not grants. The runtime validates or intersects them with caller authority, protocol policy, host policy, workspace roots, and hard limits.
- Runtime-generated fields include node/run/protocol identity, ownership lineage, authority, routes, resolved grants, trusted guards, output schema, correlation, lifecycle, and terminal behavior.
- Slot names and cardinality are protocol-owned: `subagent` requires `worker = 1`; `classify_and_act` requires `classifier = 1` and keyed `handler >= 1` with optional `fallback = 0..1`; `fan_out_synthesize` requires `worker = 1..N` and `synthesizer = 1`; `adversarial_verify` requires `generator = 1` and `verifier = 1..N`; `generate_and_filter` requires `generator = 1..N` and one logical `evaluator`; `tournament` requires `approach = 2..N` and one logical `judge`; `loop_until_done` requires `refiner = 1`; `teammate` requires `peer = 1`.
- `count` creates independent instances only where that slot permits it. It cannot encode loops, tournament comparisons, dynamic branches, evaluator attempts, or other protocol control.
- Unknown slots, missing required slots, duplicate singleton slots, duplicate keyed-slot keys, unsupported `count`, and invalid cardinality are validation errors and are never silently ignored.
- Prompt assembly order is fixed: trusted protocol guard, node-local `instruction`, then shared protocol `message.content`.

### Decision 13: Canonical Limits and No Implicit Timeouts

**Accepted.** Each public limit expresses one enforceable runtime budget. Node cardinality, concurrency, iteration count, retained-output count, confidence threshold, whole-run timeout, and per-attempt timeout remain distinct concepts with no compatibility aliases.

The canonical run-level fields are `maxConcurrent`, `maxIterations`, `minConfidence`, `maxOutputs`, and `runTimeoutSeconds`. Per-node `attemptTimeoutSeconds` remains in `NodeBindingInput`.

Required behavior:

- Node quantities are expressed only by protocol-authorized slot cardinality and `count`; there are no separate `workerCount`, `verifyCount`, `candidateCount`, or `approachCount` limits.
- `threshold`, `topK`, and ambiguous `timeoutSeconds` aliases are not exposed. Their unambiguous concepts are `minConfidence`, `maxOutputs`, `runTimeoutSeconds`, and `attemptTimeoutSeconds`.
- Omitted `runTimeoutSeconds` and `attemptTimeoutSeconds` mean no multiagent semantic deadline and create no hidden timer. A deadline exists only when a caller, Host/Session policy, or trusted protocol policy explicitly injects one.
- Every injected or policy-tightened deadline is visible in acknowledgement and status data through requested/effective values and provenance; timeout injection or clamping is never silent.
- A finite run deadline covers queueing, node execution, tools, barriers, reducers, retries, and settlement from registration. An attempt deadline begins when one AgentNode attempt starts and cannot extend the remaining run deadline.
- `teammate` rejects a whole-session `runTimeoutSeconds`; an optional peer `attemptTimeoutSeconds` applies to each active model turn. Assignment-queue expiry would require a separately named future contract.
- `loop_until_done` still requires a finite effective `maxIterations` hard cap even when it has no wall-clock deadline. This is a control-flow termination invariant, not an implicit time limit.
- Unsupported fields, non-finite values, invalid ranges, contradictory deadlines, and protocol-inapplicable limits are validation errors rather than ignored input.
- Host and protocol policy may make requested limits stricter, but returned `effectiveLimits` must disclose the result. Requested limits are never resource grants.
- Cross-provider token or monetary limits are not exposed until the runtime can enforce and settle them under one reliable accounting contract.

## Integrated Candidate Design

**Status: Discussion only - not accepted.**

This section proposes an integrated architecture candidate for review. It is intentionally incomplete where Open Decisions remain, and it must not be treated as normative until its individual decisions are promoted into the Accepted Decision Ledger.

### 1. Candidate Summary

Expose one model-visible tool named `multiagent`, backed by four runtime primitives:

```text
multiagent tool
    -> Protocol Registry
        -> Protocol Runner
            -> AgentNode Host
            -> Typed Message Bus
            -> Supervisor
```

The candidate removes `Subagent`, `WorkflowAgent`, and `TeammateAgent` as distinct agent implementation types. The only agent execution primitive is `AgentNode`.

The differences that must remain are expressed as runtime-owned protocol and lifecycle policy:

```text
subagent             = one AgentNode + one-shot request/reply protocol
static workflow      = AgentNodes + deterministic protocol runner
teammate             = one AgentNode + persistent open-conversation protocol
```

All agent input and output is normalized into typed messages. Models are not required to call a message tool to return their final result: the runtime wraps a node's final assistant output in a typed result envelope automatically.

### 2. First Principles

The candidate is guided by these rules:

1. **One agent primitive.** Model execution, tools, cwd, model selection, context construction, and process hosting belong to one `AgentNode` abstraction.
2. **One message data plane.** Assignments, results, errors, progress, cancellation, and terminal delivery use a typed envelope and correlation model.
3. **Protocols own control flow.** Branches, barriers, ranking, thresholds, loops, cancellation propagation, and terminal conditions are runtime code, not prompt instructions.
4. **Lifecycle follows protocol policy.** A one-shot node has clean context and is reclaimed after its terminal result. A persistent node retains a logical Session and an open mailbox.
5. **Stable identity is not universal.** A persistent teammate is addressed by its Session ID. A finite run has only transient execution correlation and does not gain a second domain identity.
6. **The Main Session is the coordination root.** It owns every persistent teammate, every descendant finite run, and the sole human-facing Todo.
7. **Tool unification does not imply one internal state machine.** The public contract, node primitive, message format, supervision, and observability can be shared while protocol drivers remain specialized.

### 3. Topology Versus Protocol

Topology alone says which message edges are allowed. It does not define message order, barriers, reduction, retries, or termination.

```text
topology = allowed communication paths
protocol = topology + message types + ordering + control state + termination
```

For that reason, the candidate public schema selects a runtime-owned `protocol`, not a caller-authored graph and not a `closed | open` mode.

A protocol descriptor owns both its message topology and its trusted effects:

```ts
type ProtocolDescriptor = {
  name: ProtocolName;
  slots: SlotRule[];

  routing: "declared" | "addressed";
  lifecycle: "finite" | "persistent";
  context: "clean" | "retained";
  mailbox: "closed" | "reentrant";
  authority: "leaf" | "teammate";

  allowedCallerTiers: Array<"main" | "teammate">;
  allowedChildProtocols: ProtocolName[];
  allowedActions: MultiagentAction[];

  validateStart(input: StartInput): void;
  create(input: StartInput, runtime: ProtocolRuntime): Promise<ProtocolInstance>;
  restore?(sessionId: string, runtime: ProtocolRuntime): Promise<ProtocolInstance>;
};

type ProtocolInstance = {
  snapshot(): ProtocolSnapshot;
  dispatch(command: ProtocolCommand): Promise<CommandAcknowledgement>;

  // First terminal settlement wins. Later completion/error/timeout/cancel
  // attempts are idempotently ignored and cannot emit a second terminal event.
  settle(outcome: TerminalOutcome): boolean;
};
```

These fields are trusted runtime metadata. The model cannot declare itself persistent, grant itself messaging, change its authority tier, or select its own terminal condition.

### 4. Protocol Registry

The candidate registry contains eight model-visible protocols:

| Protocol | Nodes | Context/lifecycle | Runtime-owned control |
|---|---:|---|---|
| `subagent` | `worker x 1` | clean, finite | direct result, auto-stop |
| `classify_and_act` | classifier, handlers, optional fallback | clean, finite | schema-constrained branch |
| `fan_out_synthesize` | workers, synthesizer | clean, finite | parallel fan-out and all-result barrier |
| `adversarial_verify` | generator, verifier copies | clean, finite | boolean verdicts and runtime confidence |
| `generate_and_filter` | generator copies, evaluators | clean, finite | correlation, scoring, ranking, top-K |
| `tournament` | approaches, judge | clean, finite | pairwise bracket, byes, `N-1` comparisons |
| `loop_until_done` | refiner | clean, finite | feedback, history exclusion, hard cap |
| `teammate` | peer x 1 | retained, persistent | open assignments, mailbox, explicit stop |

The existing trusted internal `script` path remains internal and is not added to the model-visible registry.

The seven finite protocols preserve the accepted seven static workflow templates. The candidate reinterprets them as the finite subset of a broader protocol registry; it does not weaken their runtime-owned guarantees.

The machine-validated slot rules are:

| Protocol | Required slots | Optional/keyed slots |
|---|---|---|
| `subagent` | `worker = 1` | none |
| `classify_and_act` | `classifier = 1`, keyed `handler >= 1` | `fallback = 0..1`; handler keys must be unique |
| `fan_out_synthesize` | `worker >= 1`, `synthesizer = 1` | none |
| `adversarial_verify` | `generator = 1`, `verifier = 1` with `count >= 1` | none |
| `generate_and_filter` | `generator = 1` with `count >= 1`, `evaluator = 1` | generator instance `i` is correlated with evaluator attempt `i` |
| `tournament` | `approach >= 2`, `judge = 1` | judge is a reusable logical slot, not `count = N-1` model input |
| `loop_until_done` | `refiner = 1` | none |
| `teammate` | `peer = 1` | none |

Duplicate singleton slots, duplicate keyed-handler keys, unknown slots, and `count` on unsupported slots are validation errors.

### 5. Common AgentNode Contract

Every protocol binds content to the same node shape:

```ts
type NodeBindingInput = {
  // Runtime-defined named position in the selected protocol.
  slot: string;

  // Optional binding key, for example a classifier handler label.
  key?: string;

  // Number of identical clean-context instances requested for an authorized slot.
  count?: number;

  instruction: string;
  role?: string;
  focus?: string;

  // Host-resolved preferences, not grants or HCP Source selectors.
  model?: string;
  thinking?: string;
  tools?: string[];
  packages?: string[];

  cwd?: string;
  workspace?: "shared" | "worktree";
  attemptTimeoutSeconds?: number;
};
```

The model supplies task content and constrained resource preferences. The runtime produces a separate trusted binding containing generated identity, ownership, authority, resolved grants, routes, guards, output schema, correlation, lifecycle, and terminal semantics.

`message.content` is the protocol-level input or initial assignment. `NodeBindingInput.instruction` is that slot's local responsibility. When both are present, the runtime constructs the node prompt in a fixed order: trusted protocol guard, node instruction, then shared message input. Neither silently overrides the other.

`count` may instantiate identical independent nodes only on protocol-authorized slots. It must not represent feedback loops, tournament comparisons, evaluator attempts, or dynamic branching; those remain protocol-driver logic.

### 6. Typed Message Data Plane

All runtime communication is normalized to an envelope:

```ts
type EndpointRef = {
  kind: "session" | "run" | "node" | "external_activation";
  id: string;
};

type MessageEnvelope = {
  messageId: string;
  protocolId: string;
  correlationId: string;
  attempt: number;

  from: EndpointRef;
  to: EndpointRef;

  type:
    | "assignment"
    | "conversation"
    | "progress"
    | "result"
    | "error"
    | "control"
    | "terminal";

  terminalStatus?: "completed" | "failed" | "timed_out" | "cancelled";
  payload: unknown;
};
```

This is an internal protocol contract, not an invitation for models to forge system messages.

- The runtime emits assignments, control, barriers, and terminal messages.
- An AgentNode's final assistant output is automatically wrapped as `result`.
- A Protocol Runner validates and correlates results, then requests exactly one protocol-level terminal settlement.
- A persistent teammate may emit explicit `conversation` or `progress` messages when its routing policy permits.
- Timeout, interrupt, and force-stop remain Supervisor operations. A natural-language "please stop" message is not cancellation.

Each run also has a trusted correlation record:

```ts
type CorrelationRecord = {
  runId: string;
  rootMainSessionId: string;
  callerSessionId: string;
  parentRunId?: string;
  parentTeammateSessionId?: string;
  terminalStatus?: "completed" | "failed" | "timed_out" | "cancelled";
};
```

Ownership and lineage come from runtime context, never model input. A single settlement controller performs an atomic first-wins transition on `terminalStatus`, persists one terminal envelope, and schedules one external activation. Worker completion, failure, timeout, and cancellation all race through this same path.

The current mailbox store can be reused as one transport adapter, but plain model-authored `send_message` is not the workflow control plane.

### 7. Runtime Architecture

#### AgentNode Host

The common host owns:

- model/provider/thinking selection,
- tool and package grants,
- cwd and workspace setup,
- prompt/context assembly,
- streaming and usage collection,
- final-output capture,
- process or in-process execution transport.

A finite node may reuse Session execution machinery internally, but it must not create a domain Session identity, persist resumable conversation history, or expose resume. A teammate uses a persisted Session. Both are the same logical node abstraction with different trusted lifecycle policy while preserving the accepted sessionless finite-worker invariant.

#### Protocol Runner

The runner owns deterministic semantics that messages alone cannot guarantee:

- exact node cardinality,
- branch selection,
- barriers and bounded concurrency,
- instance correlation,
- deterministic reductions,
- loop caps and stop detectors,
- timeout and cancellation propagation,
- one protocol-level terminal event.

The six complex protocols may retain specialized executable drivers. The candidate does not require a universal graph virtual machine merely to claim implementation unification.

#### Supervisor

The Supervisor owns hard lifecycle control:

- spawn and readiness registration,
- generation/attempt tracking,
- timeout,
- abort,
- process-group termination,
- auto-stop for finite nodes,
- idle/resume for persistent nodes,
- cleanup and worktree receipts.

#### Message Bus

The bus owns durable delivery, correlation, routing ACLs, urgent wakeups, and terminal-envelope persistence. It does not decide workflow correctness.

### 8. Candidate Model-Visible Tool Contract

The root schema is deliberately flat. It does not depend on root-level `oneOf`, because some current provider adapters preserve only root `properties` and `required`.

```ts
type MultiagentAction =
  | "start"
  | "status"
  | "send"
  | "interrupt"
  | "stop"
  | "resume"
  | "integrate"
  | "discard";

type MultiagentInput = {
  action: MultiagentAction;

  // action=start
  protocol?: ProtocolName;
  nodes?: NodeBindingInput[];
  message?: {
    content: string;
    urgent?: boolean;
  };
  limits?: {
    maxConcurrent?: number;
    maxIterations?: number;
    minConfidence?: number;
    maxOutputs?: number;
    runTimeoutSeconds?: number;
  };

  // Persistent address for teammate operations.
  session?: string;

  // Optional transient background execution reference.
  event?: string;

  // Required for destructive discard.
  confirm?: boolean;
};
```

Runtime validation enforces action-specific fields, protocol slot names and cardinalities, caller tier, ownership, and target capabilities. `session` and `event` are mutually exclusive whenever an action accepts either target. The model-visible action set contains no `wait`.

The candidate action matrix is:

| Action | Required input | Allowed target/state | Immediate result | Asynchronous settlement |
|---|---|---|---|---|
| `start` | `protocol`, `nodes`; `message` when required by protocol | caller tier must allow protocol | accepted plus `event` for finite run or `session` for teammate | ready/failure or one finite terminal event |
| `status` | no target, or exactly one of `event`/`session` | any owned known target | snapshot/list only | none |
| `send` | `session`, `message` | running persistent teammate | delivery acknowledgement | assignment/result messages may follow |
| `interrupt` | `session`, replacement `message` | active persistent teammate turn | interrupt request registered | aborted-turn settlement, then replacement delivery |
| `stop` | exactly one of `event`/`session` | active finite run or live/stopped teammate as defined by state machine | stop request registered | `cancelled`/failed terminal event or teammate stopped event |
| `resume` | `session` | stopped persistent teammate with saved Session | resume registered | ready/failure event |
| `integrate` | `session` | terminal teammate with unintegrated worktree receipt | integration result | none |
| `discard` | `session`, `confirm: true` | terminal teammate with discardable worktree | discard result | none |

Invalid or inapplicable fields are rejected rather than ignored. Control acknowledgements do not claim terminal settlement.

The limits matrix is:

| Limit | Supported protocols | Meaning |
|---|---|---|
| `maxConcurrent` | finite multi-node protocols | maximum concurrently active AgentNode attempts |
| `maxIterations` | `loop_until_done` | hard runtime-owned feedback-loop cap |
| `minConfidence` | `adversarial_verify` | minimum runtime-computed verifier pass ratio |
| `maxOutputs` | `generate_and_filter` | number of ranked candidates retained |
| `runTimeoutSeconds` | all finite protocols | wall-clock deadline for the complete protocol run |
| `attemptTimeoutSeconds` | any node binding | wall-clock deadline for one node attempt |

Unsupported limits, non-finite values, invalid ranges, and an explicitly contradictory node-attempt/run deadline are validation errors. Omitted timeouts create no multiagent semantic timer. A caller, Host/Session policy, or trusted protocol policy may inject or tighten a deadline, but acknowledgement and status data must expose requested/effective values and provenance. `teammate` has no whole-session run timeout; an optional peer attempt timeout applies to each active model turn. `loop_until_done` retains a finite effective iteration cap even without a wall-clock deadline.

### 9. Example Calls

#### One-shot Subagent Protocol

```ts
multiagent({
  action: "start",
  protocol: "subagent",
  nodes: [
    {
      slot: "worker",
      instruction: "Perform an independent security review of the supplied input"
    }
  ],
  message: {
    content: "Review the authentication module for authorization bypasses"
  }
})
```

The start call returns after registration:

```ts
{
  accepted: true,
  event: "workflow_007",
  state: "registered"
}
```

Every finite start returns a transient background event reference so concurrent runs can be unambiguously inspected or stopped and Main can supervise descendant runs. It is an execution receipt, not a stable Agent identity; the normal success path does not poll it. The node's final output is automatically returned through external activation.

#### Static Fan-Out Protocol

```ts
multiagent({
  action: "start",
  protocol: "fan_out_synthesize",
  nodes: [
    { slot: "worker", instruction: "Review frontend authentication" },
    { slot: "worker", instruction: "Review backend authentication" },
    { slot: "synthesizer", instruction: "Merge every review result" }
  ],
  message: {
    content: "Review the current repository"
  },
  limits: {
    maxConcurrent: 2
  }
})
```

The Protocol Runner launches clean-context nodes, enforces the barrier, and emits one terminal result.

#### Persistent Teammate Protocol

```ts
multiagent({
  action: "start",
  protocol: "teammate",
  nodes: [
    {
      slot: "peer",
      instruction: "Own the backend authentication work",
      workspace: "worktree",
      tools: ["read", "edit", "bash"]
    }
  ],
  message: {
    content: "Begin with the authentication endpoint"
  }
})
```

The result returns the existing persistent identity type rather than a new multi-agent handle:

```ts
{
  accepted: true,
  session: "019f..."
}
```

Further turns address the Session:

```ts
multiagent({
  action: "send",
  session: "019f...",
  message: {
    content: "Add negative-path tests"
  }
})
```

#### Candidate Response and Event Envelopes

Every immediate command result uses a stable acknowledgement shape:

```ts
type CommandAcknowledgement = {
  action: MultiagentAction;
  accepted: boolean;
  state: string;
  event?: string;
  session?: string;
  error?: {
    code: string;
    message: string;
    field?: string;
  };
};
```

Every finite terminal delivery uses one envelope regardless of outcome:

```ts
type FiniteTerminalEvent = {
  event: string;
  protocol: ProtocolName;
  status: "completed" | "failed" | "timed_out" | "cancelled";
  terminationReason: string;
  output?: unknown;
  error?: string;
  usage?: unknown;
};
```

A status snapshot always echoes the selected `event` or `session`, protocol, state, ownership-safe lineage summary, available actions, and current observability data. Exact provider-facing JSON field names remain an Open Decision, but separate success/error encodings must not change the first-wins settlement semantics.

### 10. Identity and Correlation

The candidate does not introduce a universal `maId`.

| Reference | Meaning | Lifetime |
|---|---|---|
| tool call ID | provider/runtime call correlation | one tool call |
| event reference | required finite background execution receipt and control correlation | transient |
| node ID | protocol-local routing and observability | one run by default |
| Session ID | persistent teammate address and history identity | persistent |

A finite `subagent` or static workflow always returns a transient event receipt while active, but it has no stable public identity after terminal delivery and retention expiry. A teammate is addressed by its existing Session ID. Internal run and node identifiers remain available for logs, TUI, cancellation, and observability without becoming another persistent model-managed identity.

### 11. Delegation and Routing

The accepted hierarchy is enforced as protocol authorization:

```text
Main Session
  allowed protocols: all seven finite protocols + teammate

Teammate Session
  allowed protocols: seven finite protocols only
  forbidden: teammate protocol

Finite workflow AgentNode
  allowed protocols: none
  model-visible multiagent tool: absent
```

Knowing a Session ID does not grant permission to message it. The bus validates caller tier, ownership, and routing ACL.

The Main Session retains supervisory visibility and hard-stop control over workflows launched by its teammates.

### 12. Todo and Team Scope

There is one implicit team per Main Session and one authoritative Todo:

```text
Main Session Todo
  -> human-visible plan
  -> teammate assignments
  -> workflow progress
  -> reconciled results
```

No protocol creates a Team handle, Team Todo, task-board namespace, or isolated subteam. Teammates report through messages; the Main Session reconciles those reports into the existing Todo.

The candidate default is Main-only Todo mutation: finite nodes receive no Todo tool, and teammates report proposed progress through messages for Main reconciliation. Granting a teammate owner-scoped direct mutation remains an Open Decision, but no such grant may create another board or planning source.

### 13. Completion, Cancellation, and External Activation

- `start` returns only after the background work or persistent Session has been registered.
- Every finite start returns a transient `event` receipt; every persistent teammate start returns its Session ID.
- Finite protocols settle exactly once as `completed`, `failed`, `timed_out`, or `cancelled`, then deliver that one terminal envelope through external activation.
- Persistent teammate assignments may produce per-turn result envelopes without terminating the Session.
- `status` is an immediate snapshot and is not a polling recommendation.
- `stop` acknowledges a control request; final cancellation settlement arrives asynchronously through the first-wins settlement path.
- Hard timeout and cancellation are Supervisor operations and must propagate to every active descendant.
- No model-visible call blocks until completion, cancellation, or timeout settlement.

### 14. Observability

Every finite protocol run must retain:

- protocol name and run correlation,
- node tree, attempts, and state,
- routing and phase transitions,
- per-node and aggregate usage/cost,
- structured outcomes such as confidence, finalists, and iterations,
- termination reason,
- timeout and cancellation propagation.

Every persistent teammate must retain:

- Session ID and parent Session lineage,
- activity and assignment state,
- mailbox delivery and unread state,
- compaction/context telemetry,
- worktree and immutable receipt state,
- descendant finite runs.

The TUI may present both through one multi-agent event surface without pretending their lifecycle states are identical.

### 15. Security and Independence

- Finite workflow nodes receive clean context by default.
- Independent verifier, evaluator, judge, and candidate nodes must not share retained teammate history.
- Protocol output schemas and guards are runtime-owned.
- Workflow nodes do not receive peer messaging, Todo mutation, or recursive delegation tools.
- Teammates may receive broader tools only under Main-owned policy; direct Todo mutation is denied by default.
- Routing ACLs are runtime checks, not prompt-only instructions.
- A model cannot self-report confidence, ranking, completion, or cancellation settlement where the protocol requires deterministic computation.

### 16. Recommended Implementation Shape

This is an implementation outline, not a compatibility commitment:

1. Extract a common internal `AgentNodeHost` beneath the current sessionless worker and persistent teammate paths.
2. Introduce a typed message envelope, trusted endpoint references, and a persistent protocol-scoped correlation/ownership store.
3. Introduce a Protocol Registry with trusted descriptors, specialized drivers, and protocol-instance command dispatch.
4. Route all final node outputs and all terminal outcomes through the message/result and first-wins settlement paths automatically.
5. Keep hard lifecycle control in one Supervisor while making terminal settlement ownership explicit.
6. Register one model-visible `multiagent` facade with caller-tier-specific protocol availability.
7. Migrate the seven finite templates and the persistent teammate path onto the common node/message contracts.
8. Replace the model-visible `sub_agent` and `teammate_agent` tools rather than preserving compatibility aliases.
9. Decide separately whether the standalone model-visible `send_message` tool is folded into `multiagent action=send`; the mailbox transport itself may remain internal.

### 17. Required Equivalence Tests

Before removing existing tools, the candidate must prove:

- one model-visible multi-agent tool and no model-visible `wait`,
- one-node `subagent` direct result with no synthesizer, no Session identity/file, and no resume capability,
- exact classify routing and fallback behavior,
- fan-out all-result barrier,
- runtime-computed adversarial confidence,
- generator/evaluator one-to-one correlation and top-K,
- tournament `N-1` comparisons and bye handling,
- loop hard cap and no-new-finding termination,
- clean-context independence for verifier/judge/evaluator nodes,
- hard timeout and cancellation propagation,
- one transient event receipt per finite start and exactly one terminal settlement/event under completion-timeout-cancel races,
- persistent teammate history and same-Session resume,
- Main -> Teammate -> finite-protocol delegation restriction,
- Main supervisory visibility over descendant runs,
- no Team handle and no second Todo.

### 18. Explicit Non-Goals

- Multiple isolated teams within one Main Session.
- A first-class Team resource or Team Todo.
- Backward-compatible `sub_agent` or `teammate_agent` model-facing aliases.
- A model-authored arbitrary graph DSL.
- Replacing deterministic protocol control with an LLM coordinator told to "send the right messages."
- Making every AgentNode a persistent teammate Session.
- Making every AgentNode explicitly call a message tool to return its final output.
- A universal public ID for finite runs and persistent Sessions.
- Blocking wait semantics.

### 19. Open Decisions

The following remain candidates and must be discussed one at a time:

1. Whether the standalone model-visible `send_message` tool is removed in favor of `multiagent action=send`.
2. Whether teammates can directly mutate the Main Todo or only report proposed updates.
3. The retention period and TUI presentation of transient finite event receipts after terminal settlement.
4. How stopped teammate Sessions are indexed, rediscovered, authorized, and resumed after the Main runtime itself restarts.
5. Whether persistent teammate assignment completion is always inferred from a turn's final output or may also use explicit terminal receipts.
6. The stable provider-facing response, validation-error, status-snapshot, control-acknowledgement, worktree-receipt, and terminal-event JSON contracts.
