import { visibleWidth } from "@earendil-works/pi-tui";
import type { TodoPlanState } from "@magenta/harness";
import { beforeAll, describe, expect, it } from "vitest";
import { renderFloatingWindow } from "../src/modes/interactive/components/floating-window.ts";
import { TodoOverlay } from "../src/modes/interactive/components/todo-overlay.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const state: TodoPlanState = {
	version: 2,
	title: "Current plan",
	summary: null,
	currentId: 5,
	nextId: 8,
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
		{ id: 7, parentId: null, order: 1, text: "Parallel branch", status: "in_progress" },
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
		const currentPlan = output();
		expect(currentPlan).toContain("Completed child");
		expect(currentPlan).not.toContain("Most recent task");
		expect(currentPlan).toContain("● 1 Root");
		expect(currentPlan).toContain("● 2 Parallel branch");
		const focusedNode = currentPlan.split("\n").find((line) => line.includes("Completed child"));
		expect(focusedNode).not.toContain("current");
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

describe("renderFloatingWindow", () => {
	beforeAll(() => initTheme("dark"));

	it("neutralizes embedded line endings without changing the frame height", () => {
		const width = 64;
		const lines = renderFloatingWindow({
			theme,
			width,
			title: "Todo\r\nPlan",
			subtitle: "current\nfollow-up",
			body: [
				theme.fg("error", "command failed\r\nfollow-up diagnostic"),
				theme.fg("text", "node title\ncontinued\rtail"),
			],
			footer: "first action\rsecond action",
		});

		expect(lines).toHaveLength(6);
		for (const line of lines) {
			expect(line).not.toMatch(/[\r\n]/);
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}

		const plain = stripAnsi(lines.join("\n"));
		expect(plain).toContain("Todo Plan");
		expect(plain).toContain("current follow-up");
		expect(plain).toContain("command failed follow-up diagnostic");
		expect(plain).toContain("node title continued tail");
		expect(plain).toContain("first action second action");
	});

	it("keeps later text in the narrow-width fallback", () => {
		const width = 7;
		const lines = renderFloatingWindow({
			theme,
			width,
			title: "unused",
			body: ["A\r\nB\nC\rD"],
		});

		expect(lines).toEqual(["A B C D"]);
		expect(lines[0]).not.toMatch(/[\r\n]/);
		expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(width);
	});
});
