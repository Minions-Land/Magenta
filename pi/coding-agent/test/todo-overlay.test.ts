import type { TodoPlanState } from "@magenta/harness";
import { beforeAll, describe, expect, it } from "vitest";
import { TodoOverlay } from "../src/modes/interactive/components/todo-overlay.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const state: TodoPlanState = {
	version: 2,
	title: "Current plan",
	summary: null,
	currentId: 5,
	nextId: 7,
	revision: 5,
	history: [
		{
			title: "First archive",
			summary: "Initial work",
			currentId: 2,
			nodes: [
				{ id: 1, parentId: null, order: 0, text: "First root", status: "completed" },
				{ id: 2, parentId: 1, order: 0, text: "First archived task", status: "completed" },
			],
		},
		{
			title: "Most recent archive",
			summary: null,
			currentId: 3,
			nodes: [{ id: 3, parentId: null, order: 0, text: "Most recent task", status: "completed" }],
		},
	],
	nodes: [
		{ id: 4, parentId: null, order: 0, text: "Root", status: "in_progress" },
		{ id: 5, parentId: 4, order: 0, text: "Completed child", status: "completed" },
		{ id: 6, parentId: 4, order: 1, text: "Pending child", status: "pending" },
	],
};

describe("TodoOverlay", () => {
	beforeAll(() => initTheme("dark"));

	it("renders and filters the current plan without mutating its snapshot", () => {
		let renders = 0;
		let closed = 0;
		const original = structuredClone(state);
		const overlay = new TodoOverlay({ requestRender: () => renders++ }, theme, state, 30, () => closed++);
		const output = () => stripAnsi(overlay.render(100).join("\n"));

		expect(output()).toContain("[Current]");
		expect(output()).toContain("History (2)");
		expect(output()).toContain("Completed child");
		expect(output()).not.toContain("Most recent task");
		overlay.handleInput("f");
		expect(output()).not.toContain("Completed child");
		overlay.handleInput("/");
		for (const char of "pending") overlay.handleInput(char);
		overlay.handleInput("\r");
		expect(output()).toContain("Root");
		expect(output()).toContain("Pending child");
		overlay.handleInput("\x1b");

		expect(closed).toBe(1);
		expect(renders).toBeGreaterThan(0);
		expect(state).toEqual(original);
	});

	it("lists newest history first, opens details, and uses escape as back then close", () => {
		let closed = 0;
		const original = structuredClone(state);
		const overlay = new TodoOverlay({ requestRender: () => {} }, theme, state, 30, () => closed++);
		const output = () => stripAnsi(overlay.render(100).join("\n"));

		overlay.handleInput("\t");
		const history = output();
		expect(history).toContain("[History (2)]");
		expect(history.indexOf("Most recent archive")).toBeLessThan(history.indexOf("First archive"));

		overlay.handleInput("\r");
		expect(output()).toContain("history #2/2");
		expect(output()).toContain("Most recent task");
		overlay.handleInput("\x1b");
		expect(closed).toBe(0);
		expect(output()).toContain("[History (2)]");

		overlay.handleInput("j");
		overlay.handleInput("\r");
		expect(output()).toContain("history #1/2");
		expect(output()).toContain("Initial work");
		expect(output()).toContain("First archived task");
		overlay.handleInput("/");
		for (const char of "archived") overlay.handleInput(char);
		overlay.handleInput("\r");
		expect(output()).toContain("First archived task");

		overlay.handleInput("\x1b");
		expect(closed).toBe(0);
		overlay.handleInput("\x1b");
		expect(closed).toBe(1);
		expect(state).toEqual(original);
	});

	it("keeps history available when the current plan is empty and q closes from detail", () => {
		let closed = 0;
		const emptyCurrent: TodoPlanState = {
			...structuredClone(state),
			title: "Todo",
			summary: null,
			currentId: null,
			nodes: [],
		};
		const original = structuredClone(emptyCurrent);
		const overlay = new TodoOverlay({ requestRender: () => {} }, theme, emptyCurrent, 30, () => closed++);
		const output = () => stripAnsi(overlay.render(100).join("\n"));

		expect(output()).toContain("No current Todo plan");
		overlay.handleInput("\t");
		overlay.handleInput("\r");
		expect(output()).toContain("Most recent task");
		overlay.handleInput("q");

		expect(closed).toBe(1);
		expect(emptyCurrent).toEqual(original);
	});
});
