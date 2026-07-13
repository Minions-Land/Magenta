import type { TodoPlanState } from "@magenta/harness";
import { beforeAll, describe, expect, it } from "vitest";
import { TodoOverlay } from "../src/modes/interactive/components/todo-overlay.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const state: TodoPlanState = {
	version: 1,
	title: "Plan",
	summary: null,
	currentId: 2,
	nextId: 4,
	revision: 1,
	nodes: [
		{ id: 1, parentId: null, order: 0, text: "Root", status: "in_progress" },
		{ id: 2, parentId: 1, order: 0, text: "Completed child", status: "completed" },
		{ id: 3, parentId: 1, order: 1, text: "Pending child", status: "pending" },
	],
};

describe("TodoOverlay", () => {
	beforeAll(() => initTheme("dark"));

	it("renders, folds, filters, searches, and never mutates its snapshot", () => {
		let renders = 0;
		let closed = 0;
		const original = structuredClone(state);
		const overlay = new TodoOverlay({ requestRender: () => renders++ }, theme, state, 30, () => closed++);
		const output = () => stripAnsi(overlay.render(100).join("\n"));
		expect(output()).toContain("Completed child");
		overlay.handleInput("f");
		expect(output()).not.toContain("Completed child");
		overlay.handleInput("/");
		for (const char of "pending") overlay.handleInput(char);
		overlay.handleInput("\r");
		expect(output()).toContain("Root");
		expect(output()).toContain("Pending child");
		overlay.handleInput("q");
		expect(closed).toBe(1);
		expect(renders).toBeGreaterThan(0);
		expect(state).toEqual(original);
	});
});
