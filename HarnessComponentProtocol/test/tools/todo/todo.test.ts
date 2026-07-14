import type { AgentTool } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { HcpClientassemble } from "../../../.HCP/assembly/session-hcp.ts";
import { HCP_MAGNETS } from "../../../.HCP/assembly/sources.generated.ts";
import { HcpClient } from "../../../HcpClient.ts";
import { HcpServer as TodoHcpServer } from "../../../tools/todo/HcpServer.ts";
import {
	applyTodoOperations,
	createEmptyTodoPlanState,
	createTodoTool,
	flattenTodoPlan,
	restoreTodoPlanState,
	type TodoOperation,
	type TodoPlanState,
	todoSchema,
} from "../../../tools/todo/magenta/todo.ts";

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

function createTool() {
	return createTodoTool("/tmp");
}

async function apply(tool: ReturnType<typeof createTool>, operations: TodoOperation[]) {
	return tool.execute("apply", { action: "apply", operations });
}

describe("todo HCP component", () => {
	it("assembles the Magenta-owned generated Magnet", async () => {
		const generated = HCP_MAGNETS.find((entry) => entry.module === "tools/todo" && entry.selected);
		expect(generated).toMatchObject({ source: "magenta" });

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
			renderKind: "todo-plan",
		});
		expect(tool?.description).toContain("single source of truth");
		expect(tool?.description).toContain('Top-level action is only "get" or "apply"');
		expect(tool?.description).toContain("operations[].op, never action");
		expect(tool?.execute).toBeTypeOf("function");
	});

	it("advertises get/apply as the only top-level actions", () => {
		expect(todoSchema.properties.action).toMatchObject({
			type: "string",
			enum: ["get", "apply"],
			description: expect.stringContaining('never use action "add"'),
		});
		expect(todoSchema.properties.operations).toMatchObject({ minItems: 1 });
		expect(todoSchema.properties.operations.items.properties.op).toMatchObject({
			type: "string",
			enum: ["add", "update", "move", "set_status", "set_current", "set_summary", "set_title", "remove", "reset"],
			description: expect.stringContaining('never in the top-level "action" field'),
		});
		expect((todoSchema.properties.operations as { description?: string }).description).toContain(
			'{"action":"apply","operations":[{"op":"add","text":"Run tests"}]}',
		);
	});
});

describe("todo atomic batch execution", () => {
	it("gets an empty versioned plan", async () => {
		const result = await createTool().execute("get", { action: "get" });
		expect(getText(result)).toBe("Todo: no items");
		expect(result.details).toMatchObject({
			action: "get",
			applied: 0,
			state: createEmptyTodoPlanState(),
		});
	});

	it("creates a nested plan and metadata in one batch using temporary refs", async () => {
		const result = await apply(createTool(), [
			{ op: "set_title", text: "Release Plan" },
			{ op: "set_summary", text: "Finish the real update validation" },
			{ op: "add", ref: "root", text: "Release validation", status: "in_progress" },
			{ op: "add", ref: "windows", text: "Windows validation", parentRef: "root" },
			{ op: "add", ref: "smoke", text: "Run Windows smoke", parentRef: "windows" },
			{ op: "set_status", targetRef: "smoke", status: "completed" },
			{ op: "set_current", targetRef: "windows" },
		]);

		expect(getText(result)).toContain("Applied 7 Todo operations");
		expect(result.details.error).toBeUndefined();
		expect(result.details.refs).toEqual({ root: 1, windows: 2, smoke: 3 });
		expect(result.details.state).toEqual({
			version: 2,
			title: "Release Plan",
			summary: "Finish the real update validation",
			currentId: 2,
			nextId: 4,
			revision: 1,
			history: [],
			nodes: [
				{ id: 1, parentId: null, order: 0, text: "Release validation", status: "in_progress" },
				{ id: 2, parentId: 1, order: 0, text: "Windows validation", status: "pending" },
				{ id: 3, parentId: 2, order: 0, text: "Run Windows smoke", status: "completed" },
			],
		});
		expect(flattenTodoPlan(result.details.state).map((row) => row.outline)).toEqual(["1", "1.1", "1.1.1"]);
	});

	it("targets todos by the display outline path shown in the plan", async () => {
		const tool = createTool();
		await apply(tool, [
			{ op: "add", ref: "root", text: "Root" },
			{ op: "add", ref: "childA", text: "Child A", parentRef: "root" },
			{ op: "add", ref: "childB", text: "Child B", parentRef: "root" },
		]);

		// "1.2" is the second child of the first root item, i.e. internal id 3.
		const statusResult = await apply(tool, [{ op: "set_status", id: "1.2", status: "completed" }]);
		expect(statusResult.details.error).toBeUndefined();
		expect(statusResult.details.state.nodes.find((node) => node.id === 3)?.status).toBe("completed");

		// Outline paths also work for set_current and as a numeric id string.
		const currentResult = await apply(tool, [{ op: "set_current", id: "1.1" }]);
		expect(currentResult.details.error).toBeUndefined();
		expect(currentResult.details.state.currentId).toBe(2);

		const numericStringResult = await apply(tool, [{ op: "set_status", id: "1", status: "in_progress" }]);
		expect(numericStringResult.details.error).toBeUndefined();
		expect(numericStringResult.details.state.nodes.find((node) => node.id === 1)?.status).toBe("in_progress");
	});

	it("reports NOT_FOUND for an outline path past the tree", async () => {
		const tool = createTool();
		await apply(tool, [{ op: "add", text: "Only item" }]);
		const rejected = await apply(tool, [{ op: "set_status", id: "1.5", status: "completed" }]);
		expect(rejected.details.error?.code).toBe("NOT_FOUND");
		expect(rejected.details.error?.message).toContain("#1.5");
	});

	it("treats a single mutation as a one-operation batch", async () => {
		const result = await apply(createTool(), [{ op: "add", text: "One item" }]);
		expect(result.details.applied).toBe(1);
		expect(result.details.state.nodes).toEqual([
			{ id: 1, parentId: null, order: 0, text: "One item", status: "pending" },
		]);
	});

	it("updates text and migrates valid version-1 session snapshots", async () => {
		const tool = createTool();
		await apply(tool, [{ op: "add", text: "Draft" }]);

		const updated = await apply(tool, [{ op: "update", id: 1, text: "Reviewed" }]);
		expect(updated.details.state.nodes[0]?.text).toBe("Reviewed");

		const legacy = {
			version: 1,
			title: "Legacy",
			summary: "Preserve this plan",
			currentId: 3,
			nodes: [{ id: 3, parentId: null, order: 0, text: "Old work", status: "in_progress" }],
			nextId: 4,
			revision: 7,
		};
		expect(restoreTodoPlanState(legacy)).toEqual({ ...legacy, version: 2, history: [] });
		expect(restoreTodoPlanState({ ...legacy, nextId: 3 })).toBeUndefined();
		expect(
			restoreTodoPlanState({
				...legacy,
				version: 2,
				history: [
					{
						title: "Duplicate IDs",
						summary: null,
						currentId: 3,
						nodes: [{ id: 3, parentId: null, order: 0, text: "Archived", status: "completed" }],
					},
				],
			}),
		).toBeUndefined();
	});

	it("rejects reset for empty and incomplete plans without changing state", async () => {
		const emptyTool = createTool();
		const empty = await apply(emptyTool, [{ op: "reset" }]);
		expect(empty.details).toMatchObject({
			applied: 0,
			error: { code: "RESET_EMPTY_PLAN", operationIndex: 0 },
			state: createEmptyTodoPlanState(),
		});

		for (const status of ["pending", "in_progress", "blocked"] as const) {
			const tool = createTool();
			const seeded = await apply(tool, [{ op: "add", text: status, status }]);
			const rejected = await apply(tool, [{ op: "reset" }]);
			expect(rejected.details.error).toMatchObject({ code: "RESET_INCOMPLETE_PLAN", operationIndex: 0 });
			expect(rejected.details.state).toEqual(seeded.details.state);
		}

		const hierarchy = createTool();
		await apply(hierarchy, [
			{ op: "add", ref: "parent", text: "Parent", status: "pending" },
			{ op: "add", text: "Finished child", parentRef: "parent", status: "completed" },
		]);
		const rejected = await apply(hierarchy, [{ op: "reset" }]);
		expect(rejected.details.error?.code).toBe("RESET_INCOMPLETE_PLAN");
	});

	it("archives a completed hierarchy, resets metadata, and deep-clones history", async () => {
		const tool = createTool();
		await apply(tool, [
			{ op: "set_title", text: "Completed release" },
			{ op: "set_summary", text: "All checks passed" },
			{ op: "add", ref: "root", text: "Release", status: "completed" },
			{ op: "add", ref: "child", text: "Smoke test", parentRef: "root", status: "completed" },
			{ op: "set_current", targetRef: "child" },
		]);

		const reset = await apply(tool, [{ op: "reset" }]);
		expect(getText(reset)).toContain("archived 1");
		expect(reset.details.changes.reset).toBe(1);
		expect(reset.details.state).toEqual({
			version: 2,
			title: "Todo",
			summary: null,
			currentId: null,
			nodes: [],
			nextId: 3,
			revision: 2,
			history: [
				{
					title: "Completed release",
					summary: "All checks passed",
					currentId: 2,
					nodes: [
						{ id: 1, parentId: null, order: 0, text: "Release", status: "completed" },
						{ id: 2, parentId: 1, order: 0, text: "Smoke test", status: "completed" },
					],
				},
			],
		});

		reset.details.state.history[0]!.nodes[0]!.text = "mutated result";
		const current = await tool.execute("get-after-reset", { action: "get" });
		expect(current.details.state.history[0]?.nodes[0]?.text).toBe("Release");
		expect(getText(current)).toBe("Todo: no items · 1 archived");
	});

	it("supports completing, resetting, and starting fresh work in one atomic batch", async () => {
		const tool = createTool();
		const result = await apply(tool, [
			{ op: "add", ref: "task", text: "First task" },
			{ op: "set_status", targetRef: "task", status: "completed" },
			{ op: "reset" },
			{ op: "set_title", text: "Next plan" },
			{ op: "add", ref: "task", text: "Second task" },
			{ op: "set_current", targetRef: "task" },
		]);

		expect(result.details.error).toBeUndefined();
		expect(result.details.refs).toEqual({ task: 2 });
		expect(result.details.state).toMatchObject({
			title: "Next plan",
			currentId: 2,
			nextId: 3,
			history: [{ title: "Todo", nodes: [{ id: 1, status: "completed" }] }],
			nodes: [{ id: 2, text: "Second task", status: "pending" }],
		});

		const secondReset = await apply(tool, [{ op: "set_status", id: 2, status: "completed" }, { op: "reset" }]);
		expect(secondReset.details.state).toMatchObject({
			title: "Todo",
			currentId: null,
			nextId: 3,
			nodes: [],
			history: [
				{ title: "Todo", nodes: [{ id: 1, text: "First task" }] },
				{ title: "Next plan", nodes: [{ id: 2, text: "Second task" }] },
			],
		});
	});

	it("rolls back reset and its archive when a later operation fails", async () => {
		const tool = createTool();
		const seeded = await apply(tool, [{ op: "add", text: "Finished", status: "completed" }]);
		const failed = await apply(tool, [{ op: "reset" }, { op: "add", text: "  " }]);
		expect(failed.details.error).toMatchObject({ code: "INVALID_TEXT", operationIndex: 1 });
		expect(failed.details.state).toEqual(seeded.details.state);
	});

	it("rolls back the entire batch when a middle operation fails", async () => {
		const tool = createTool();
		const seeded = await apply(tool, [
			{ op: "add", ref: "a", text: "A" },
			{ op: "add", ref: "b", text: "B" },
			{ op: "set_current", targetRef: "a" },
		]);
		const before = structuredClone(seeded.details.state);

		const failed = await apply(tool, [
			{ op: "set_summary", text: "must roll back" },
			{ op: "add", text: "invalid", parentRef: "missing" },
			{ op: "remove", id: 1 },
		]);

		expect(failed.details).toMatchObject({ applied: 0, error: { code: "UNKNOWN_REF", operationIndex: 1 } });
		expect(failed.details.state).toEqual(before);
		const current = await tool.execute("get", { action: "get" });
		expect(current.details.state).toEqual(before);
	});

	it("rejects duplicate and forward temporary refs", () => {
		const initial = createEmptyTodoPlanState();
		const duplicate = applyTodoOperations(initial, [
			{ op: "add", ref: "same", text: "A" },
			{ op: "add", ref: "same", text: "B" },
		]);
		expect(duplicate).toMatchObject({ error: { code: "DUPLICATE_REF", operationIndex: 1 } });

		const forward = applyTodoOperations(initial, [
			{ op: "add", text: "Child", parentRef: "later" },
			{ op: "add", ref: "later", text: "Parent" },
		]);
		expect(forward).toMatchObject({ error: { code: "UNKNOWN_REF", operationIndex: 0 } });
	});

	it("supports arbitrary sibling placement and moving across parents", async () => {
		const tool = createTool();
		await apply(tool, [
			{ op: "add", ref: "a", text: "A" },
			{ op: "add", ref: "b", text: "B" },
			{ op: "add", ref: "c", text: "C" },
		]);
		const changed = await apply(tool, [
			{ op: "add", text: "Before B", placement: "before", relativeToId: 2 },
			{ op: "move", id: 2, parentId: 1, placement: "first" },
			{ op: "move", id: 3, placement: "first" },
		]);

		expect(changed.details.state.nodes).toEqual([
			{ id: 1, parentId: null, order: 1, text: "A", status: "pending" },
			{ id: 2, parentId: 1, order: 0, text: "B", status: "pending" },
			{ id: 3, parentId: null, order: 0, text: "C", status: "pending" },
			{ id: 4, parentId: null, order: 2, text: "Before B", status: "pending" },
		]);
	});

	it("rejects moves that create a cycle", async () => {
		const tool = createTool();
		await apply(tool, [
			{ op: "add", ref: "root", text: "Root" },
			{ op: "add", ref: "child", text: "Child", parentRef: "root" },
			{ op: "add", ref: "grandchild", text: "Grandchild", parentRef: "child" },
		]);
		const failed = await apply(tool, [{ op: "move", id: 1, parentId: 3 }]);
		expect(failed.details).toMatchObject({ applied: 0, error: { code: "CYCLE", operationIndex: 0 } });
		expect(failed.details.state.nodes).toHaveLength(3);
	});

	it("requires cascade for subtree removal and clears a removed current item", async () => {
		const tool = createTool();
		await apply(tool, [
			{ op: "add", ref: "root", text: "Root" },
			{ op: "add", ref: "child", text: "Child", parentRef: "root" },
			{ op: "set_current", targetRef: "child" },
		]);
		const rejected = await apply(tool, [{ op: "remove", id: 1 }]);
		expect(rejected.details.error?.code).toBe("HAS_CHILDREN");

		const removed = await apply(tool, [{ op: "remove", id: 1, cascade: true }]);
		expect(removed.details.state.nodes).toEqual([]);
		expect(removed.details.state.currentId).toBeNull();
		expect(removed.details.state.nextId).toBe(3);
	});

	it("restores the host-selected branch snapshot before every action", async () => {
		let branchState: TodoPlanState = {
			version: 2,
			title: "Current branch",
			summary: null,
			currentId: null,
			nodes: [{ id: 4, parentId: null, order: 0, text: "Current", status: "pending" }],
			nextId: 5,
			revision: 3,
			history: [],
		};
		const tool = createTodoTool("/tmp", { loadState: () => branchState });

		const current = await tool.execute("get-current", { action: "get" });
		expect(current.details.state.title).toBe("Current branch");

		branchState = {
			version: 2,
			title: "Earlier branch",
			summary: "restored",
			currentId: 1,
			nodes: [{ id: 1, parentId: null, order: 0, text: "Earlier", status: "completed" }],
			nextId: 2,
			revision: 1,
			history: [],
		};
		const restored = await tool.execute("get-restored", { action: "get" });
		expect(restored.details.state).toEqual(branchState);
		expect(getText(restored)).toContain("Earlier");
	});
});
