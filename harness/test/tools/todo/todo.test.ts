/**
 * Unit tests for todo tool
 */

import { describe, it, expect } from "vitest";
import { createTodoMagnet } from "../../../modules/tools/todo/pi/todo.ts";

// Helper to extract text from tool result
function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

describe("TodoMagnet", () => {
	it("should create a valid magnet", () => {
		const magnet = createTodoMagnet("/tmp");
		expect(magnet.kind).toBe("native");
	});

	it("should produce an AgentTool", () => {
		const magnet = createTodoMagnet("/tmp");
		const tool = magnet.toTool();

		expect(tool.name).toBe("todo");
		expect(tool.label).toBe("Todo");
		expect(tool.description).toContain("todo list");
		expect(tool.execute).toBeTypeOf("function");
	});

	it("should produce an HcpServer", () => {
		const magnet = createTodoMagnet("/tmp");
		const target = magnet.toHcpServer();

		expect(target.describe).toBeTypeOf("function");
		expect(target.call).toBeTypeOf("function");

		const desc = target.describe();
		expect(desc.target).toBe("tool:todo");
		expect(desc.kind).toBe("tool");
	});
});

describe("Todo tool execution", () => {
	it("should list empty todos", async () => {
		const magnet = createTodoMagnet("/tmp");
		const tool = magnet.toTool();

		const result = await tool.execute("1", { action: "list" });
		expect(getText(result)).toBe("No todos");
		expect(result.details?.todos).toHaveLength(0);
	});

	it("should add a todo", async () => {
		const magnet = createTodoMagnet("/tmp");
		const tool = magnet.toTool();

		const result = await tool.execute("1", { action: "add", text: "Test task" });
		const text = getText(result);
		expect(text).toContain("Added");
		expect(text).toContain("Test task");
		expect(result.details?.todos).toHaveLength(1);
		expect(result.details?.todos[0].text).toBe("Test task");
		expect(result.details?.todos[0].done).toBe(false);
	});

	it("should error when adding without text", async () => {
		const magnet = createTodoMagnet("/tmp");
		const tool = magnet.toTool();

		const result = await tool.execute("1", { action: "add" });
		expect(getText(result)).toContain("Error");
		expect(result.details?.error).toBeDefined();
	});

	it("should toggle a todo", async () => {
		const magnet = createTodoMagnet("/tmp");
		const tool = magnet.toTool();

		// Add a todo first
		await tool.execute("1", { action: "add", text: "Task 1" });

		// Toggle it
		const result = await tool.execute("2", { action: "toggle", id: 1 });
		const text = getText(result);
		expect(text).toContain("Toggled");
		expect(text).toContain("[x]");
		expect(result.details?.todos[0].done).toBe(true);

		// Toggle it back
		const result2 = await tool.execute("3", { action: "toggle", id: 1 });
		expect(getText(result2)).toContain("[ ]");
		expect(result2.details?.todos[0].done).toBe(false);
	});

	it("should error when toggling non-existent todo", async () => {
		const magnet = createTodoMagnet("/tmp");
		const tool = magnet.toTool();

		const result = await tool.execute("1", { action: "toggle", id: 999 });
		const text = getText(result);
		expect(text).toContain("Error");
		expect(text).toContain("not found");
		expect(result.details?.error).toBeDefined();
	});

	it("should error when toggling without id", async () => {
		const magnet = createTodoMagnet("/tmp");
		const tool = magnet.toTool();

		const result = await tool.execute("1", { action: "toggle" });
		expect(getText(result)).toContain("Error");
		expect(result.details?.error).toBeDefined();
	});

	it("should clear all todos", async () => {
		const magnet = createTodoMagnet("/tmp");
		const tool = magnet.toTool();

		// Add multiple todos
		await tool.execute("1", { action: "add", text: "Task 1" });
		await tool.execute("2", { action: "add", text: "Task 2" });
		await tool.execute("3", { action: "add", text: "Task 3" });

		// Clear them
		const result = await tool.execute("4", { action: "clear" });
		expect(getText(result)).toContain("Cleared 3 todo(s)");
		expect(result.details?.todos).toHaveLength(0);
	});

	it("should maintain state across multiple calls", async () => {
		const magnet = createTodoMagnet("/tmp");
		const tool = magnet.toTool();

		// Add first todo
		const add1 = await tool.execute("1", { action: "add", text: "Task 1" });
		expect(add1.details?.todos).toHaveLength(1);

		// Add second todo
		const add2 = await tool.execute("2", { action: "add", text: "Task 2" });
		expect(add2.details?.todos).toHaveLength(2);

		// List should show both
		const list = await tool.execute("3", { action: "list" });
		const text = getText(list);
		expect(text).toContain("Task 1");
		expect(text).toContain("Task 2");
	});
});
