# Todo Tool

Session-scoped todo list management tool for Magenta3.

## Overview

The `todo` tool allows the LLM to manage a todo list within the current session. State is stored in tool result details (not external files), which enables proper branching support - when you branch the conversation, the todo state is automatically correct for that point in history.

## Migrated from

Previously located at `harness/extensions/pi/bundled/todo.ts` as a PI Extension. Migrated to `harness/HarnessComponentProtocol/tools/todo/` as a native HCP tool.

## Usage

### Actions

- `list` - Show all todos
- `add` - Create a new todo (requires `text` parameter)
- `toggle` - Mark a todo as done/undone (requires `id` parameter)
- `clear` - Remove all todos

### Examples

```typescript
// Add a todo
await todoTool.execute("1", { action: "add", text: "Write tests" });
// Result: "Added #1: Write tests"

// List todos
await todoTool.execute("2", { action: "list" });
// Result: "1. [ ] Write tests"

// Toggle a todo
await todoTool.execute("3", { action: "toggle", id: 1 });
// Result: "Toggled #1: [x] Write tests"

// Clear all
await todoTool.execute("4", { action: "clear" });
// Result: "Cleared 1 todo(s)"
```

## Integration

### As HCP Component

Registered in `harness/harness.toml`:

```toml
[[components]]
kind = "tool"
name = "todo"
description = "Manage a session-scoped todo list with branching support."
path = "tools/todo/todo.toml"
```

### Usage in Code

```typescript
import { createTodoMagnet } from "@magenta/harness";

const todoMagnet = createTodoMagnet(process.cwd());
const todoTool = todoMagnet.toTool();

// Register with agent
agent.registerTool(todoTool);
```

## Testing

Run tests:

```bash
cd harness
npm test -- todo
```

All tests are located in `test/tools/todo/todo.test.ts`.

## State Management

Todo state is maintained in the `details` field of tool results:

```typescript
interface TodoDetails {
  action: "list" | "add" | "toggle" | "clear";
  todos: Todo[];
  nextId: number;
  error?: string;
}
```

This approach ensures that:
- State follows the conversation branch
- No external file storage needed
- Proper history tracking
- Branch-safe state management

## Future Enhancements

- [ ] Persist todos across sessions (optional)
- [ ] Support for due dates
- [ ] Priority levels
- [ ] Categories/tags
- [ ] Search/filter capabilities
