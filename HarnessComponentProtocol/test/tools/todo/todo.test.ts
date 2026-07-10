import type { AgentTool } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { HcpClientassemble } from "../../../.HCP/assembly/session-hcp.ts";
import { HcpClient } from "../../../HcpClient.ts";
import { HcpServer as TodoHcpServer } from "../../../tools/todo/HcpServer.ts";
import { createTodoTool } from "../../../tools/todo/pi/todo.ts";

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

function createTool() {
	return createTodoTool("/tmp");
}

describe("todo HCP component", () => {
	it("assembles its generated Magnet through the real leaf Server", async () => {
		const hcp = new HcpClient();
		const result = await HcpClientassemble({
			hcp,
			repoRoot: "/tmp",
			includeAutoload: false,
			modules: ["tools/todo"],
		});

		expect(result.diagnostics).toEqual([]);
		expect(result.addresses).toContain("tool:todo");
		expect(hcp.resolveModule("tools/todo")).toBeInstanceOf(TodoHcpServer);
		expect(hcp.resolve("tool:todo")).toBe(hcp.resolveModule("tools/todo"));

		const tool = hcp.resolveInstance<AgentTool>("tool:todo");
		expect(tool).toMatchObject({
			name: "todo",
			label: "Todo",
		});
		expect(tool?.description).toContain("todo list");
		expect(tool?.execute).toBeTypeOf("function");
	});
});

describe("todo tool execution", () => {
	it("lists an empty todo set", async () => {
		const result = await createTool().execute("1", { action: "list" });
		expect(getText(result)).toBe("No todos");
		expect(result.details?.todos).toHaveLength(0);
	});

	it("adds a todo", async () => {
		const result = await createTool().execute("1", { action: "add", text: "Test task" });
		expect(getText(result)).toContain("Added");
		expect(getText(result)).toContain("Test task");
		expect(result.details?.todos).toEqual([{ id: 1, text: "Test task", done: false }]);
	});

	it("rejects an add without text", async () => {
		const result = await createTool().execute("1", { action: "add" });
		expect(getText(result)).toContain("Error");
		expect(result.details?.error).toBeDefined();
	});

	it("toggles a todo in both directions", async () => {
		const tool = createTool();
		await tool.execute("1", { action: "add", text: "Task 1" });

		const completed = await tool.execute("2", { action: "toggle", id: 1 });
		expect(getText(completed)).toContain("[x]");
		expect(completed.details?.todos[0]?.done).toBe(true);

		const reopened = await tool.execute("3", { action: "toggle", id: 1 });
		expect(getText(reopened)).toContain("[ ]");
		expect(reopened.details?.todos[0]?.done).toBe(false);
	});

	it("rejects a missing todo id", async () => {
		const result = await createTool().execute("1", { action: "toggle", id: 999 });
		expect(getText(result)).toContain("not found");
		expect(result.details?.error).toBeDefined();
	});

	it("rejects a toggle without an id", async () => {
		const result = await createTool().execute("1", { action: "toggle" });
		expect(getText(result)).toContain("Error");
		expect(result.details?.error).toBeDefined();
	});

	it("clears all todos and resets the next id", async () => {
		const tool = createTool();
		await tool.execute("1", { action: "add", text: "Task 1" });
		await tool.execute("2", { action: "add", text: "Task 2" });
		await tool.execute("3", { action: "add", text: "Task 3" });

		const cleared = await tool.execute("4", { action: "clear" });
		expect(getText(cleared)).toContain("Cleared 3 todo(s)");
		expect(cleared.details?.todos).toHaveLength(0);
		expect(cleared.details?.nextId).toBe(1);
	});

	it("keeps state within one tool instance", async () => {
		const tool = createTool();
		await tool.execute("1", { action: "add", text: "Task 1" });
		await tool.execute("2", { action: "add", text: "Task 2" });

		const listed = await tool.execute("3", { action: "list" });
		expect(getText(listed)).toContain("Task 1");
		expect(getText(listed)).toContain("Task 2");
		expect(listed.details?.todos).toHaveLength(2);
	});

	it("restores state from the host-selected session branch before each action", async () => {
		let branchState = {
			todos: [{ id: 4, text: "Current branch", done: false }],
			nextId: 5,
		};
		const tool = createTodoTool("/tmp", { loadState: () => branchState });

		const current = await tool.execute("1", { action: "add", text: "New task" });
		expect(current.details?.todos).toEqual([
			{ id: 4, text: "Current branch", done: false },
			{ id: 5, text: "New task", done: false },
		]);

		branchState = {
			todos: [{ id: 1, text: "Earlier branch", done: true }],
			nextId: 2,
		};
		const restored = await tool.execute("2", { action: "list" });
		expect(getText(restored)).toContain("Earlier branch");
		expect(getText(restored)).not.toContain("New task");
		expect(restored.details?.nextId).toBe(2);
	});
});
