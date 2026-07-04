/**
 * Todo tool - session-scoped todo list management
 * 
 * Migrated from extensions/pi/bundled/todo.ts to harness/tools/todo/
 * 
 * State is stored in tool result details (not external files), which allows
 * proper branching - when you branch, the todo state is automatically
 * correct for that point in history.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { NativeToolSpec } from "../../../../hcp-magnet/native.ts";
import { NativeToolMagnet } from "../../../../hcp-magnet/native.ts";

// Type definitions
interface Todo {
	id: number;
	text: string;
	done: boolean;
}

interface TodoDetails {
	action: "list" | "add" | "toggle" | "clear";
	todos: Todo[];
	nextId: number;
	error?: string;
}

// Parameter schema
export const todoSchema = Type.Object({
	action: StringEnum(["list", "add", "toggle", "clear"] as const),
	text: Type.Optional(Type.String({ description: "Todo text (for add)" })),
	id: Type.Optional(Type.Number({ description: "Todo ID (for toggle)" })),
});

// NativeToolSpec definition
export const todoSpec: NativeToolSpec<typeof todoSchema, TodoDetails> = {
	name: "todo",
	label: "Todo",
	description:
		"Manage a session-scoped todo list. Actions: list (show all), add (create new), toggle (mark done/undone by id), clear (remove all).",
	parameters: todoSchema,

	createExecute: (cwd) => {
		// Session state - will be persisted via details
		// In a real implementation, this would be restored from session storage
		let todos: Todo[] = [];
		let nextId = 1;

		return async (toolCallId, params, signal, onUpdate) => {
			const { action, text, id } = params;

			let error: string | undefined;
			let content = "";

			switch (action) {
				case "list":
					if (todos.length === 0) {
						content = "No todos";
					} else {
						content = todos.map((t) => `${t.id}. [${t.done ? "x" : " "}] ${t.text}`).join("\n");
					}
					break;

				case "add":
					if (!text) {
						error = "text is required for add action";
						content = "Error: " + error;
					} else {
						const newTodo: Todo = { id: nextId++, text, done: false };
						todos.push(newTodo);
						content = `Added #${newTodo.id}: ${newTodo.text}`;
					}
					break;

				case "toggle":
					if (id === undefined) {
						error = "id is required for toggle action";
						content = "Error: " + error;
					} else {
						const todo = todos.find((t) => t.id === id);
						if (!todo) {
							error = `Todo #${id} not found`;
							content = "Error: " + error;
						} else {
							todo.done = !todo.done;
							content = `Toggled #${todo.id}: [${todo.done ? "x" : " "}] ${todo.text}`;
						}
					}
					break;

				case "clear":
					const count = todos.length;
					todos = [];
					nextId = 1;
					content = `Cleared ${count} todo(s)`;
					break;
			}

			const details: TodoDetails = {
				action,
				todos: [...todos],
				nextId,
				error,
			};

			return {
				content: [{ type: "text", text: content }],
				details,
			};
		};
	},
};

/**
 * Create a todo tool magnet for the given working directory.
 */
export function createTodoMagnet(cwd: string): NativeToolMagnet<typeof todoSchema, TodoDetails> {
	return new NativeToolMagnet(todoSpec, cwd);
}
