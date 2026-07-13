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
		changes: { added: 0, updated: 0, moved: 0, statusChanged: 0, removed: 0, metadataChanged: 0, cleared: 0 },
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

	it("renders a compact structured Updated Plan with hierarchy and current path", () => {
		const state: TodoPlanState = {
			version: 1,
			title: "Release",
			summary: "Only real update validation remains",
			currentId: 3,
			nextId: 4,
			revision: 1,
			nodes: [
				{ id: 1, parentId: null, order: 0, text: "Release validation", status: "in_progress" },
				{ id: 2, parentId: 1, order: 0, text: "Windows", status: "completed" },
				{ id: 3, parentId: 1, order: 1, text: "Real update", status: "pending" },
			],
		};
		const output = render(details(state)).join("\n");
		expect(output).toContain("Updated Plan · 1/3");
		expect(output).toContain("Only real update validation remains");
		expect(output).toContain("Current: 1 Release validation › 1.2 Real update");
		expect(output).toContain("✔ 1.1 Windows");
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
			version: 1,
			title: "Large plan",
			summary: null,
			currentId: null,
			nodes,
			nextId: 61,
			revision: 1,
		};

		const collapsed = render(details(state));
		expect(collapsed.length).toBeLessThanOrEqual(12);
		expect(collapsed.join("\n")).toContain("more · /todo");
		const expanded = render(details(state), true);
		expect(expanded.length).toBeLessThanOrEqual(40);
		expect(expanded.join("\n")).toContain("more · /todo");
	});

	it("renders empty and failed states without pretending success", () => {
		const empty: TodoPlanState = {
			version: 1,
			title: "Todo",
			summary: null,
			currentId: null,
			nodes: [],
			nextId: 1,
			revision: 0,
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
