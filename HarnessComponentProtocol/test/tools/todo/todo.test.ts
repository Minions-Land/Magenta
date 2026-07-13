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
	type TodoOperation,
	type TodoPlanState,
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
		expect(tool?.description).toContain("hierarchical");
		expect(tool?.execute).toBeTypeOf("function");
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
			version: 1,
			title: "Release Plan",
			summary: "Finish the real update validation",
			currentId: 2,
			nextId: 4,
			revision: 1,
			nodes: [
				{ id: 1, parentId: null, order: 0, text: "Release validation", status: "in_progress" },
				{ id: 2, parentId: 1, order: 0, text: "Windows validation", status: "pending" },
				{ id: 3, parentId: 2, order: 0, text: "Run Windows smoke", status: "completed" },
			],
		});
		expect(flattenTodoPlan(result.details.state).map((row) => row.outline)).toEqual(["1", "1.1", "1.1.1"]);
	});

	it("treats a single mutation as a one-operation batch", async () => {
		const result = await apply(createTool(), [{ op: "add", text: "One item" }]);
		expect(result.details.applied).toBe(1);
		expect(result.details.state.nodes).toEqual([
			{ id: 1, parentId: null, order: 0, text: "One item", status: "pending" },
		]);
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
			version: 1,
			title: "Current branch",
			summary: null,
			currentId: null,
			nodes: [{ id: 4, parentId: null, order: 0, text: "Current", status: "pending" }],
			nextId: 5,
			revision: 3,
		};
		const tool = createTodoTool("/tmp", { loadState: () => branchState });

		const current = await tool.execute("get-current", { action: "get" });
		expect(current.details.state.title).toBe("Current branch");

		branchState = {
			version: 1,
			title: "Earlier branch",
			summary: "restored",
			currentId: 1,
			nodes: [{ id: 1, parentId: null, order: 0, text: "Earlier", status: "completed" }],
			nextId: 2,
			revision: 1,
		};
		const restored = await tool.execute("get-restored", { action: "get" });
		expect(restored.details.state).toEqual(branchState);
		expect(getText(restored)).toContain("Earlier");
	});
});
