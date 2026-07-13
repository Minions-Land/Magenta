# Magenta Todo Tool

Magenta-owned hierarchical Todo planning with atomic batch mutations and session-branch snapshots.

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

type TodoPlanState = {
  version: 1;
  title: string;
  summary: string | null;
  currentId: number | null;
  nodes: TodoNode[];
  nextId: number;
  revision: number;
};
```

The persisted representation is normalized rather than recursively nested. `parentId` defines hierarchy and `order` defines sibling order. IDs remain stable when nodes move.

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
- `clear` — clear the current plan without reusing previously allocated IDs.

Placement values are `first`, `last`, `before`, and `after`. `before`/`after` require `relativeToId` or `relativeToRef`.

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
