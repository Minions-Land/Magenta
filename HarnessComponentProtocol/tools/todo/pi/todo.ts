import type { AgentTool } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export type Todo = {
	id: number;
	text: string;
	done: boolean;
};

export type TodoDetails = {
	action: "list" | "add" | "toggle" | "clear";
	todos: Todo[];
	nextId: number;
	error?: string;
};

export type TodoState = Pick<TodoDetails, "todos" | "nextId">;

export type TodoToolOptions = {
	/** Load the latest state for the host's currently selected session branch. */
	loadState?: () => TodoState | undefined;
};

export const todoSchema = Type.Object({
	action: StringEnum(["list", "add", "toggle", "clear"] as const),
	text: Type.Optional(Type.String({ description: "Todo text (for add)" })),
	id: Type.Optional(Type.Number({ description: "Todo ID (for toggle)" })),
});

export function createTodoTool(_cwd: string, options: TodoToolOptions = {}): AgentTool<typeof todoSchema, TodoDetails> {
	let todos: Todo[] = [];
	let nextId = 1;

	return {
		name: "todo",
		label: "Todo",
		description: "Manage a session-scoped todo list. Actions: list, add, toggle, and clear.",
		parameters: todoSchema,
		executionMode: "sequential",
		execute: async (_toolCallId, params) => {
			if (options.loadState) {
				const state = options.loadState();
				todos = state?.todos.map((todo) => ({ ...todo })) ?? [];
				nextId = state?.nextId ?? 1;
			}

			const { action, text, id } = params;
			let error: string | undefined;
			let content: string;

			switch (action) {
				case "list":
					content =
						todos.length === 0
							? "No todos"
							: todos.map((todo) => `${todo.id}. [${todo.done ? "x" : " "}] ${todo.text}`).join("\n");
					break;
				case "add": {
					if (!text) {
						error = "text is required for add action";
						content = `Error: ${error}`;
						break;
					}
					const created = { id: nextId++, text, done: false };
					todos.push(created);
					content = `Added #${created.id}: ${created.text}`;
					break;
				}
				case "toggle": {
					const todo = id === undefined ? undefined : todos.find((candidate) => candidate.id === id);
					if (!todo) {
						error = id === undefined ? "id is required for toggle action" : `Todo #${id} not found`;
						content = `Error: ${error}`;
						break;
					}
					todo.done = !todo.done;
					content = `Toggled #${todo.id}: [${todo.done ? "x" : " "}] ${todo.text}`;
					break;
				}
				case "clear": {
					const count = todos.length;
					todos = [];
					nextId = 1;
					content = `Cleared ${count} todo(s)`;
					break;
				}
			}

			return {
				content: [{ type: "text", text: content }],
				details: { action, todos: [...todos], nextId, error },
			};
		},
	};
}
