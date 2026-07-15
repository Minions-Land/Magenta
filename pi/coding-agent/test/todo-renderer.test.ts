import type { TodoDetails, TodoPlanState } from "@magenta/harness";
import { beforeAll, describe, expect, it } from "vitest";
import type { ToolRenderContext } from "../src/core/extensions/types.ts";
import { todoPlanRenderer } from "../src/core/tools/todo-renderer.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function context(expanded = false): ToolRenderContext {
	return {
		args: { action: "get" },
		toolCallId: "todo-render",
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd: process.cwd(),
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded,
		showImages: true,
		isError: false,
	};
}

function details(state: TodoPlanState): TodoDetails {
	return {
		action: "get",
		state,
		applied: 0,
		changes: { added: 0, updated: 0, moved: 0, statusChanged: 0, removed: 0, metadataChanged: 0, reset: 0 },
		refs: {},
	};
}

function render(result: TodoDetails, expanded = false, width = 120): string[] {
	const component = todoPlanRenderer.renderResult!(
		{ content: [{ type: "text", text: "fallback" }], details: result },
		{ expanded, isPartial: false },
		theme,
		context(expanded),
	);
	return component.render(width).map(stripAnsi);
}

describe("todo-plan renderer", () => {
	beforeAll(() => initTheme("dark"));

	it("renders a compact structured Updated Plan with every in-progress branch", () => {
		const state: TodoPlanState = {
			version: 2,
			title: "Release",
			summary: "Only real update validation remains",
			currentId: 3,
			nextId: 5,
			revision: 1,
			history: [],
			nodes: [
				{ id: 1, parentId: null, order: 0, text: "Release validation", status: "in_progress" },
				{ id: 2, parentId: 1, order: 0, text: "Windows", status: "completed" },
				{ id: 3, parentId: 1, order: 1, text: "Real update", status: "pending" },
				{ id: 4, parentId: null, order: 1, text: "Package artifacts", status: "in_progress" },
			],
		};
		const output = render(details(state)).join("\n");
		expect(output).toContain("Updated Plan · 1/4");
		expect(output).toContain("Only real update validation remains");
		expect(output).not.toContain("Current:");
		expect(output).toContain("● 1 Release validation");
		expect(output).toContain("✔ 1.1 Windows");
		expect(output).toContain("● 2 Package artifacts");
	});

	it("bounds long collapsed and expanded plans and points to /todo", () => {
		const nodes = Array.from({ length: 60 }, (_, index) => ({
			id: index + 1,
			parentId: null,
			order: index,
			text: `Task ${index + 1}`,
			status: "pending" as const,
		}));
		const state: TodoPlanState = {
			version: 2,
			title: "Large plan",
			summary: null,
			currentId: null,
			nodes,
			nextId: 61,
			revision: 1,
			history: [],
		};

		const collapsed = render(details(state));
		expect(collapsed.length).toBeLessThanOrEqual(12);
		expect(collapsed.join("\n")).toContain("more · /todo");
		const expanded = render(details(state), true);
		expect(expanded.length).toBeLessThanOrEqual(40);
		expect(expanded.join("\n")).toContain("more · /todo");
	});

	it("shows archived plan count after a successful reset", () => {
		const state: TodoPlanState = {
			version: 2,
			title: "Todo",
			summary: null,
			currentId: null,
			nodes: [],
			nextId: 2,
			revision: 2,
			history: [
				{
					title: "Finished plan",
					summary: null,
					currentId: 1,
					nodes: [{ id: 1, parentId: null, order: 0, text: "Done", status: "completed" }],
				},
			],
		};
		const reset = details(state);
		reset.action = "apply";
		reset.changes.reset = 1;
		const output = render(reset).join("\n");
		expect(output).toContain("Updated Plan · 0/0 · 1 archived");
		expect(output).toContain("No Todo items");
	});

	it("renders empty and failed states without pretending success", () => {
		const empty: TodoPlanState = {
			version: 2,
			title: "Todo",
			summary: null,
			currentId: null,
			nodes: [],
			nextId: 1,
			revision: 0,
			history: [],
		};
		expect(render(details(empty)).join("\n")).toContain("No Todo items");

		const failed = details(empty);
		failed.action = "apply";
		failed.error = { code: "INVALID_TEXT", message: "Todo text must be non-empty", operationIndex: 0 };
		const output = render(failed).join("\n");
		expect(output).toContain("Todo error: Todo text must be non-empty");
		expect(output).not.toContain("Updated Plan");
	});
});
