# Magenta Todo Tool

Magenta-owned hierarchical Todo planning with atomic batch mutations, completed-plan history, and session-branch snapshots.

## Contract

The tool exposes exactly two top-level actions:

- `get` — read the current plan.
- `apply` — atomically apply a non-empty `operations` array. One mutation is a one-operation batch.

Mutation names such as `add`, `update`, and `set_status` are valid only in
`operations[].op`; `{ "action": "add" }` is invalid.

State is stored as a complete versioned snapshot in every tool result's `details.state`. The host restores the latest valid snapshot from the selected session branch, so fork and tree navigation keep independent plans without an external database. This state is the session's single plan, progress, completion, and evaluation ledger; orchestration must not mirror it into plan or progress Markdown files.

## State

```ts
type TodoStatus = "pending" | "in_progress" | "completed" | "blocked";

type TodoNode = {
  id: number;
  parentId: number | null;
  order: number;
  text: string;
  status: TodoStatus;
};

type TodoPlanSnapshot = {
  title: string;
  summary: string | null;
  currentId: number | null;
  nodes: TodoNode[];
};

type TodoPlanState = TodoPlanSnapshot & {
  version: 2;
  nextId: number;
  revision: number;
  history: TodoPlanSnapshot[];
};
```

The persisted representation is normalized rather than recursively nested. `parentId` defines hierarchy and `order` defines sibling order. IDs remain stable when nodes move and are not reused after reset. `history` stores completed snapshots from oldest to newest. Each archived snapshot is non-empty and every archived node is `completed`.

A node's `status` is the authoritative progress signal, and multiple nodes may be `in_progress` at the same time, including nodes on different branches. `currentId` is only an optional focus hint for clients; it does not identify the only active node and is not a scheduler or execution-order mechanism.

The host accepts valid version-1 snapshots and migrates them to version 2 with an empty history. Migration preserves the version-1 plan as the active plan; it never infers that an old plan should already be archived.

## Atomic plan creation

```ts
await todoTool.execute("1", {
  action: "apply",
  operations: [
    { op: "set_title", text: "Release Plan" },
    { op: "add", ref: "root", text: "Validate release", status: "in_progress" },
    { op: "add", ref: "windows", text: "Windows smoke", parentRef: "root" },
    { op: "add", text: "Real update validation", parentRef: "windows" },
    { op: "set_current", targetRef: "windows" },
  ],
});
```

Temporary refs exist only inside one batch. Operations are evaluated sequentially against a draft, but commit once. Any invalid operation returns an error and the unchanged state.

## Operations

- `add` — create a node, optionally using `ref`, `parentId`/`parentRef`, and sibling placement.
- `update` — replace node text.
- `move` — move a node and its descendants.
- `set_status` — set `pending`, `in_progress`, `completed`, or `blocked`; optional cascade applies to descendants.
- `set_current` — select or clear the current node.
- `set_summary` / `set_title` — update plan metadata.
- `remove` — remove a leaf; `cascade: true` is required for a subtree.
- `reset` — archive the current plan and create an empty active plan. It is rejected when the plan is empty or any node is not `completed`.

Placement values are `first`, `last`, `before`, and `after`. `before`/`after` require `relativeToId` or `relativeToRef`.

## Reset lifecycle

`reset` is evaluated at its exact position in the draft batch. This allows an agent to complete the last items, archive the finished plan, and seed the next plan atomically:

```ts
await todoTool.execute("2", {
  action: "apply",
  operations: [
    { op: "set_status", id: 3, status: "completed" },
    { op: "reset" },
    { op: "set_title", text: "Next task" },
    { op: "add", text: "Inspect the new request", status: "in_progress" },
  ],
});
```

An empty plan returns `RESET_EMPTY_PLAN`. A plan containing `pending`, `in_progress`, or `blocked` nodes returns `RESET_INCOMPLETE_PLAN`. If any later operation fails, the archive and reset roll back with the rest of the batch. Temporary refs are cleared at the reset boundary, while the global numeric ID allocator continues forward.

Because history is part of every complete state snapshot, session forks and tree navigation restore independent active plans and histories. `/todo` opens on Current; Tab opens the newest-first History list, Enter opens an archived plan, and Escape returns from detail to the list.

## Ownership

The component source is `magenta`:

```toml
source = "magenta"
sources = ["magenta"]
```

Its native implementation lives under `tools/todo/magenta/`. Pi remains the TUI client: the tool declares render kind `todo-plan`, while Pi owns the inline renderer and `/todo` overlay.

## Tests

```bash
cd HarnessComponentProtocol
npm test -- test/tools/todo/todo.test.ts
npm run check:structure
npm run check:hcp-sources
```
