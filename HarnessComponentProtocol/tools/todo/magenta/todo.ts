import type { AgentTool } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export const TODO_PLAN_VERSION = 1 as const;
export const TODO_RENDER_KIND = "todo-plan";

export type TodoStatus = "pending" | "in_progress" | "completed" | "blocked";

export type TodoNode = {
	id: number;
	parentId: number | null;
	order: number;
	text: string;
	status: TodoStatus;
};

export type TodoPlanState = {
	version: typeof TODO_PLAN_VERSION;
	title: string;
	summary: string | null;
	currentId: number | null;
	nodes: TodoNode[];
	nextId: number;
	revision: number;
};

export type TodoOperationName =
	| "add"
	| "update"
	| "move"
	| "set_status"
	| "set_current"
	| "set_summary"
	| "set_title"
	| "remove"
	| "clear";

export type TodoPlacement = "first" | "last" | "before" | "after";

export type TodoOperation = {
	op: TodoOperationName;
	id?: number;
	targetRef?: string;
	ref?: string;
	text?: string | null;
	parentId?: number | null;
	parentRef?: string;
	placement?: TodoPlacement;
	relativeToId?: number;
	relativeToRef?: string;
	status?: TodoStatus;
	cascade?: boolean;
};

export type TodoChangeSummary = {
	added: number;
	updated: number;
	moved: number;
	statusChanged: number;
	removed: number;
	metadataChanged: number;
	cleared: number;
};

export type TodoError = {
	code: string;
	message: string;
	operationIndex?: number;
};

export type TodoDetails = {
	action: "get" | "apply";
	state: TodoPlanState;
	applied: number;
	changes: TodoChangeSummary;
	refs: Record<string, number>;
	error?: TodoError;
};

export type TodoToolOptions = {
	/** Load the latest state for the host's currently selected session branch. */
	loadState?: () => TodoPlanState | undefined;
};

const todoOperationSchema = Type.Object({
	op: StringEnum([
		"add",
		"update",
		"move",
		"set_status",
		"set_current",
		"set_summary",
		"set_title",
		"remove",
		"clear",
	] as const),
	id: Type.Optional(Type.Number({ description: "Existing Todo ID targeted by this operation" })),
	targetRef: Type.Optional(Type.String({ description: "Temporary ref created by an earlier add in this batch" })),
	ref: Type.Optional(Type.String({ description: "Unique temporary ref assigned by an add operation" })),
	text: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	parentId: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
	parentRef: Type.Optional(Type.String()),
	placement: Type.Optional(StringEnum(["first", "last", "before", "after"] as const)),
	relativeToId: Type.Optional(Type.Number()),
	relativeToRef: Type.Optional(Type.String()),
	status: Type.Optional(StringEnum(["pending", "in_progress", "completed", "blocked"] as const)),
	cascade: Type.Optional(Type.Boolean()),
});

export const todoSchema = Type.Object({
	action: StringEnum(["get", "apply"] as const),
	operations: Type.Optional(
		Type.Array(todoOperationSchema, {
			description: "Atomic Todo mutations. A one-item change is an array with one operation.",
		}),
	),
});

type DraftResult =
	| { state: TodoPlanState; changes: TodoChangeSummary; refs: Record<string, number> }
	| { error: TodoError };

type Destination = { parentId: number | null; index: number };

function emptyChanges(): TodoChangeSummary {
	return { added: 0, updated: 0, moved: 0, statusChanged: 0, removed: 0, metadataChanged: 0, cleared: 0 };
}

export function createEmptyTodoPlanState(): TodoPlanState {
	return {
		version: TODO_PLAN_VERSION,
		title: "Todo",
		summary: null,
		currentId: null,
		nodes: [],
		nextId: 1,
		revision: 0,
	};
}

export function cloneTodoPlanState(state: TodoPlanState): TodoPlanState {
	return { ...state, nodes: state.nodes.map((node) => ({ ...node })) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

export function isTodoPlanState(value: unknown): value is TodoPlanState {
	if (!isRecord(value)) return false;
	if (value.version !== TODO_PLAN_VERSION) return false;
	if (typeof value.title !== "string" || value.title.trim().length === 0) return false;
	if (value.summary !== null && typeof value.summary !== "string") return false;
	if (value.currentId !== null && (!Number.isInteger(value.currentId) || (value.currentId as number) <= 0))
		return false;
	if (!Number.isInteger(value.nextId) || (value.nextId as number) < 1) return false;
	if (!Number.isInteger(value.revision) || (value.revision as number) < 0) return false;
	if (!Array.isArray(value.nodes)) return false;

	const nodes = value.nodes as unknown[];
	const byId = new Map<number, TodoNode>();
	for (const candidate of nodes) {
		if (!isRecord(candidate)) return false;
		if (!Number.isInteger(candidate.id) || (candidate.id as number) <= 0) return false;
		if (
			candidate.parentId !== null &&
			(!Number.isInteger(candidate.parentId) || (candidate.parentId as number) <= 0)
		) {
			return false;
		}
		if (!Number.isInteger(candidate.order) || (candidate.order as number) < 0) return false;
		if (typeof candidate.text !== "string" || candidate.text.trim().length === 0) return false;
		if (!(["pending", "in_progress", "completed", "blocked"] as unknown[]).includes(candidate.status)) return false;
		const node = candidate as TodoNode;
		if (byId.has(node.id)) return false;
		byId.set(node.id, node);
	}

	let maxId = 0;
	const siblingOrders = new Map<string, number[]>();
	for (const node of byId.values()) {
		maxId = Math.max(maxId, node.id);
		if (node.parentId !== null && (!byId.has(node.parentId) || node.parentId === node.id)) return false;
		const key = String(node.parentId ?? "root");
		const orders = siblingOrders.get(key) ?? [];
		orders.push(node.order);
		siblingOrders.set(key, orders);

		const seen = new Set<number>([node.id]);
		let parentId = node.parentId;
		while (parentId !== null) {
			if (seen.has(parentId)) return false;
			seen.add(parentId);
			parentId = byId.get(parentId)?.parentId ?? null;
		}
	}
	for (const orders of siblingOrders.values()) {
		orders.sort((left, right) => left - right);
		if (orders.some((order, index) => order !== index)) return false;
	}
	if ((value.nextId as number) <= maxId) return false;
	if (value.currentId !== null && !byId.has(value.currentId as number)) return false;
	return true;
}

function nodeById(state: TodoPlanState, id: number): TodoNode | undefined {
	return state.nodes.find((node) => node.id === id);
}

function sortedSiblings(state: TodoPlanState, parentId: number | null, excludeId?: number): TodoNode[] {
	return state.nodes
		.filter((node) => node.parentId === parentId && node.id !== excludeId)
		.sort((left, right) => left.order - right.order || left.id - right.id);
}

function setSiblingOrder(nodes: TodoNode[]): void {
	for (let index = 0; index < nodes.length; index++) nodes[index]!.order = index;
}

function normalizeParent(state: TodoPlanState, parentId: number | null): void {
	setSiblingOrder(sortedSiblings(state, parentId));
}

function descendantsOf(state: TodoPlanState, id: number): TodoNode[] {
	const children = new Map<number, TodoNode[]>();
	for (const node of state.nodes) {
		if (node.parentId === null) continue;
		const values = children.get(node.parentId) ?? [];
		values.push(node);
		children.set(node.parentId, values);
	}
	const descendants: TodoNode[] = [];
	const stack = [...(children.get(id) ?? [])];
	while (stack.length > 0) {
		const node = stack.pop()!;
		descendants.push(node);
		stack.push(...(children.get(node.id) ?? []));
	}
	return descendants;
}

function operationError(code: string, message: string): TodoError {
	return { code, message };
}

function normalizeRef(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}

function resolveExistingId(
	state: TodoPlanState,
	refs: Map<string, number>,
	id: number | undefined,
	refValue: string | undefined,
	label: string,
): number | TodoError {
	const ref = normalizeRef(refValue);
	if (id !== undefined && ref !== undefined)
		return operationError("AMBIGUOUS_TARGET", `${label} cannot use both id and ref`);
	let resolved = id;
	if (ref !== undefined) {
		resolved = refs.get(ref);
		if (resolved === undefined) return operationError("UNKNOWN_REF", `Unknown ${label} ref: ${ref}`);
	}
	if (resolved === undefined) return operationError("MISSING_TARGET", `${label} is required`);
	if (!Number.isInteger(resolved) || resolved <= 0 || !nodeById(state, resolved)) {
		return operationError("NOT_FOUND", `${label} #${resolved} not found`);
	}
	return resolved;
}

function resolveOptionalParent(
	state: TodoPlanState,
	refs: Map<string, number>,
	parentId: number | null | undefined,
	parentRefValue: string | undefined,
): number | null | TodoError {
	const parentRef = normalizeRef(parentRefValue);
	if (parentId !== undefined && parentRef !== undefined) {
		return operationError("AMBIGUOUS_PARENT", "parentId and parentRef cannot both be set");
	}
	let resolved = parentId ?? null;
	if (parentRef !== undefined) {
		resolved = refs.get(parentRef) ?? Number.NaN;
		if (!Number.isInteger(resolved)) return operationError("UNKNOWN_REF", `Unknown parent ref: ${parentRef}`);
	}
	if (resolved !== null && !nodeById(state, resolved))
		return operationError("NOT_FOUND", `Parent #${resolved} not found`);
	return resolved;
}

function resolveOptionalRelative(
	state: TodoPlanState,
	refs: Map<string, number>,
	id: number | undefined,
	refValue: string | undefined,
): number | null | TodoError {
	const ref = normalizeRef(refValue);
	if (id !== undefined && ref !== undefined) {
		return operationError("AMBIGUOUS_RELATIVE", "relativeToId and relativeToRef cannot both be set");
	}
	if (id === undefined && ref === undefined) return null;
	const resolved = ref === undefined ? id : refs.get(ref);
	if (resolved === undefined) return operationError("UNKNOWN_REF", `Unknown relative ref: ${ref}`);
	if (!nodeById(state, resolved)) return operationError("NOT_FOUND", `Relative Todo #${resolved} not found`);
	return resolved;
}

function resolveDestination(
	state: TodoPlanState,
	refs: Map<string, number>,
	operation: TodoOperation,
	movingId?: number,
): Destination | TodoError {
	const placement = operation.placement ?? "last";
	const requestedParent = resolveOptionalParent(state, refs, operation.parentId, operation.parentRef);
	if (isTodoError(requestedParent)) return requestedParent;
	const relativeId = resolveOptionalRelative(state, refs, operation.relativeToId, operation.relativeToRef);
	if (isTodoError(relativeId)) return relativeId;

	if (placement === "before" || placement === "after") {
		if (relativeId === null)
			return operationError("MISSING_RELATIVE", `${placement} requires relativeToId or relativeToRef`);
		if (relativeId === movingId)
			return operationError("INVALID_RELATIVE", "A Todo cannot be positioned relative to itself");
		const relative = nodeById(state, relativeId)!;
		const suppliedParent = operation.parentId !== undefined || normalizeRef(operation.parentRef) !== undefined;
		if (suppliedParent && requestedParent !== relative.parentId) {
			return operationError(
				"PARENT_MISMATCH",
				"Explicit destination parent does not match the relative Todo parent",
			);
		}
		const siblings = sortedSiblings(state, relative.parentId, movingId);
		const relativeIndex = siblings.findIndex((node) => node.id === relative.id);
		if (relativeIndex < 0)
			return operationError("INVALID_RELATIVE", "Relative Todo is not in the destination sibling set");
		return { parentId: relative.parentId, index: relativeIndex + (placement === "after" ? 1 : 0) };
	}

	if (relativeId !== null)
		return operationError("UNEXPECTED_RELATIVE", `${placement} does not accept a relative Todo`);
	const siblings = sortedSiblings(state, requestedParent, movingId);
	return { parentId: requestedParent, index: placement === "first" ? 0 : siblings.length };
}

function isTodoError(value: unknown): value is TodoError {
	return isRecord(value) && typeof value.code === "string" && typeof value.message === "string";
}

function placeNode(state: TodoPlanState, node: TodoNode, destination: Destination, oldParentId?: number | null): void {
	const siblings = sortedSiblings(state, destination.parentId, node.id);
	const index = Math.max(0, Math.min(destination.index, siblings.length));
	node.parentId = destination.parentId;
	siblings.splice(index, 0, node);
	setSiblingOrder(siblings);
	if (oldParentId !== undefined && oldParentId !== destination.parentId) normalizeParent(state, oldParentId);
}

function cleanText(value: string | null | undefined, label: string): string | TodoError {
	if (typeof value !== "string" || value.trim().length === 0) {
		return operationError("INVALID_TEXT", `${label} must be a non-empty string`);
	}
	return value.trim();
}

export function applyTodoOperations(state: TodoPlanState, operations: TodoOperation[]): DraftResult {
	if (!Array.isArray(operations) || operations.length === 0) {
		return { error: operationError("EMPTY_BATCH", "apply requires at least one operation") };
	}
	if (!isTodoPlanState(state)) return { error: operationError("INVALID_STATE", "Current Todo state is invalid") };

	const draft = cloneTodoPlanState(state);
	const refs = new Map<string, number>();
	const changes = emptyChanges();

	for (let operationIndex = 0; operationIndex < operations.length; operationIndex++) {
		const operation = operations[operationIndex]!;
		let error: TodoError | undefined;

		switch (operation.op) {
			case "add": {
				const text = cleanText(operation.text, "Todo text");
				if (isTodoError(text)) {
					error = text;
					break;
				}
				const ref = normalizeRef(operation.ref);
				if (operation.ref !== undefined && ref === undefined) {
					error = operationError("INVALID_REF", "Todo ref must be a non-empty string");
					break;
				}
				if (ref !== undefined && refs.has(ref)) {
					error = operationError("DUPLICATE_REF", `Duplicate Todo ref: ${ref}`);
					break;
				}
				const destination = resolveDestination(draft, refs, operation);
				if (isTodoError(destination)) {
					error = destination;
					break;
				}
				const node: TodoNode = {
					id: draft.nextId++,
					parentId: destination.parentId,
					order: 0,
					text,
					status: operation.status ?? "pending",
				};
				draft.nodes.push(node);
				placeNode(draft, node, destination);
				if (ref !== undefined) refs.set(ref, node.id);
				changes.added++;
				break;
			}
			case "update": {
				const id = resolveExistingId(draft, refs, operation.id, operation.targetRef, "Todo");
				if (isTodoError(id)) {
					error = id;
					break;
				}
				const text = cleanText(operation.text, "Todo text");
				if (isTodoError(text)) {
					error = text;
					break;
				}
				nodeById(draft, id)!.text = text;
				changes.updated++;
				break;
			}
			case "move": {
				const id = resolveExistingId(draft, refs, operation.id, operation.targetRef, "Todo");
				if (isTodoError(id)) {
					error = id;
					break;
				}
				const node = nodeById(draft, id)!;
				const destination = resolveDestination(draft, refs, operation, id);
				if (isTodoError(destination)) {
					error = destination;
					break;
				}
				if (
					destination.parentId === id ||
					descendantsOf(draft, id).some((descendant) => descendant.id === destination.parentId)
				) {
					error = operationError("CYCLE", "A Todo cannot move under itself or one of its descendants");
					break;
				}
				const oldParentId = node.parentId;
				placeNode(draft, node, destination, oldParentId);
				changes.moved++;
				break;
			}
			case "set_status": {
				const id = resolveExistingId(draft, refs, operation.id, operation.targetRef, "Todo");
				if (isTodoError(id)) {
					error = id;
					break;
				}
				if (!operation.status) {
					error = operationError("MISSING_STATUS", "set_status requires status");
					break;
				}
				const targets = [nodeById(draft, id)!, ...(operation.cascade ? descendantsOf(draft, id) : [])];
				for (const target of targets) target.status = operation.status;
				changes.statusChanged += targets.length;
				break;
			}
			case "set_current": {
				if (operation.id === undefined && normalizeRef(operation.targetRef) === undefined) {
					draft.currentId = null;
				} else {
					const id = resolveExistingId(draft, refs, operation.id, operation.targetRef, "Current Todo");
					if (isTodoError(id)) {
						error = id;
						break;
					}
					draft.currentId = id;
				}
				changes.metadataChanged++;
				break;
			}
			case "set_summary": {
				const summary = typeof operation.text === "string" ? operation.text.trim() : "";
				draft.summary = summary || null;
				changes.metadataChanged++;
				break;
			}
			case "set_title": {
				const title = cleanText(operation.text, "Todo title");
				if (isTodoError(title)) {
					error = title;
					break;
				}
				draft.title = title;
				changes.metadataChanged++;
				break;
			}
			case "remove": {
				const id = resolveExistingId(draft, refs, operation.id, operation.targetRef, "Todo");
				if (isTodoError(id)) {
					error = id;
					break;
				}
				const node = nodeById(draft, id)!;
				const descendants = descendantsOf(draft, id);
				if (descendants.length > 0 && !operation.cascade) {
					error = operationError(
						"HAS_CHILDREN",
						`Todo #${id} has descendants; use cascade: true to remove the subtree`,
					);
					break;
				}
				const removedIds = new Set([id, ...descendants.map((descendant) => descendant.id)]);
				draft.nodes = draft.nodes.filter((candidate) => !removedIds.has(candidate.id));
				normalizeParent(draft, node.parentId);
				if (draft.currentId !== null && removedIds.has(draft.currentId)) draft.currentId = null;
				changes.removed += removedIds.size;
				break;
			}
			case "clear": {
				changes.removed += draft.nodes.length;
				draft.nodes = [];
				draft.title = "Todo";
				draft.summary = null;
				draft.currentId = null;
				changes.cleared++;
				break;
			}
			default:
				error = operationError("UNKNOWN_OPERATION", `Unknown Todo operation: ${(operation as TodoOperation).op}`);
		}

		if (error) return { error: { ...error, operationIndex } };
	}

	draft.revision = state.revision + 1;
	if (!isTodoPlanState(draft)) return { error: operationError("INVALID_RESULT", "Todo batch produced invalid state") };
	return { state: draft, changes, refs: Object.fromEntries(refs) };
}

function statusMarker(status: TodoStatus): string {
	switch (status) {
		case "completed":
			return "[x]";
		case "in_progress":
			return "[~]";
		case "blocked":
			return "[!]";
		default:
			return "[ ]";
	}
}

export type FlattenedTodoNode = { node: TodoNode; depth: number; outline: string };

export function flattenTodoPlan(state: TodoPlanState): FlattenedTodoNode[] {
	const children = new Map<number | null, TodoNode[]>();
	for (const node of state.nodes) {
		const values = children.get(node.parentId) ?? [];
		values.push(node);
		children.set(node.parentId, values);
	}
	for (const values of children.values()) values.sort((left, right) => left.order - right.order || left.id - right.id);

	const rows: FlattenedTodoNode[] = [];
	const roots = children.get(null) ?? [];
	const stack = roots.map((node, index) => ({ node, depth: 0, outline: String(index + 1) })).reverse();
	while (stack.length > 0) {
		const row = stack.pop()!;
		rows.push(row);
		const descendants = children.get(row.node.id) ?? [];
		for (let index = descendants.length - 1; index >= 0; index--) {
			stack.push({
				node: descendants[index]!,
				depth: row.depth + 1,
				outline: `${row.outline}.${index + 1}`,
			});
		}
	}
	return rows;
}

function formatPlan(state: TodoPlanState): string {
	if (state.nodes.length === 0) return `${state.title}: no items`;
	const completed = state.nodes.filter((node) => node.status === "completed").length;
	const lines = [`${state.title} · ${completed}/${state.nodes.length} completed`];
	if (state.summary) lines.push(state.summary);
	for (const { node, depth, outline } of flattenTodoPlan(state)) {
		const current = node.id === state.currentId ? " <current>" : "";
		lines.push(`${"  ".repeat(depth)}${statusMarker(node.status)} ${outline} ${node.text}${current}`);
	}
	return lines.join("\n");
}

function compactApplyResult(details: TodoDetails): string {
	const { changes, state, applied } = details;
	const parts = [`Applied ${applied} Todo operation${applied === 1 ? "" : "s"}`];
	if (changes.added) parts.push(`added ${changes.added}`);
	if (changes.updated) parts.push(`updated ${changes.updated}`);
	if (changes.moved) parts.push(`moved ${changes.moved}`);
	if (changes.statusChanged) parts.push(`status ${changes.statusChanged}`);
	if (changes.removed) parts.push(`removed ${changes.removed}`);
	if (state.currentId !== null) parts.push(`current #${state.currentId}`);
	return parts.join(" · ");
}

export function createTodoTool(_cwd: string, options: TodoToolOptions = {}): AgentTool<typeof todoSchema, TodoDetails> {
	let state = createEmptyTodoPlanState();

	const loadCurrentState = (): void => {
		if (!options.loadState) return;
		const loaded = options.loadState();
		state = loaded && isTodoPlanState(loaded) ? cloneTodoPlanState(loaded) : createEmptyTodoPlanState();
	};

	return {
		name: "todo",
		label: "Todo",
		description:
			"Manage a hierarchical session-branch Todo plan. Read with get; mutate atomically with one apply operations array. A single change is a one-operation batch.",
		parameters: todoSchema,
		executionMode: "sequential",
		renderKind: TODO_RENDER_KIND,
		execute: async (_toolCallId, params) => {
			loadCurrentState();
			if (params.action === "get") {
				return {
					content: [{ type: "text", text: formatPlan(state) }],
					details: {
						action: "get",
						state: cloneTodoPlanState(state),
						applied: 0,
						changes: emptyChanges(),
						refs: {},
					},
				};
			}

			const original = cloneTodoPlanState(state);
			const operations = (params.operations ?? []) as TodoOperation[];
			const result = applyTodoOperations(original, operations);
			if ("error" in result) {
				const details: TodoDetails = {
					action: "apply",
					state: original,
					applied: 0,
					changes: emptyChanges(),
					refs: {},
					error: result.error,
				};
				return { content: [{ type: "text", text: `Error: ${result.error.message}` }], details };
			}

			state = result.state;
			const details: TodoDetails = {
				action: "apply",
				state: cloneTodoPlanState(state),
				applied: operations.length,
				changes: result.changes,
				refs: result.refs,
			};
			return { content: [{ type: "text", text: compactApplyResult(details) }], details };
		},
	};
}
