import type { AgentTool } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { ToolExecutionError } from "../../tool-error.ts";

export const TODO_PLAN_VERSION = 2 as const;
export const TODO_RENDER_KIND = "todo-plan";

export type TodoStatus = "pending" | "in_progress" | "completed" | "blocked";

const TODO_STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "completed", "blocked"];

export type TodoNode = {
	id: number;
	parentId: number | null;
	order: number;
	text: string;
	status: TodoStatus;
};

export type TodoPlanSnapshot = {
	title: string;
	summary: string | null;
	currentId: number | null;
	nodes: TodoNode[];
};

export type TodoPlanState = TodoPlanSnapshot & {
	version: typeof TODO_PLAN_VERSION;
	nextId: number;
	revision: number;
	/** Completed plans in reset order, oldest first. */
	history: TodoPlanSnapshot[];
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
	| "reset";

export type TodoPlacement = "first" | "last" | "before" | "after";

export type TodoOperation = {
	op: TodoOperationName;
	id?: number | string;
	targetRef?: string;
	ref?: string;
	text?: string | null;
	parentId?: number | string | null;
	parentRef?: string;
	placement?: TodoPlacement;
	relativeToId?: number | string;
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
	reset: number;
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
	/** Load the latest persisted value for the host's currently selected session branch. */
	loadState?: () => unknown;
	/** Expose a projection that permits get but rejects every mutation. */
	readOnly?: boolean;
};

const todoOperationSchema = Type.Object({
	op: StringEnum(
		["add", "update", "move", "set_status", "set_current", "set_summary", "set_title", "remove", "reset"] as const,
		{
			description:
				'Mutation verb for this operation. Put add/update/move/etc. here, never in the top-level "action" field.',
		},
	),
	id: Type.Optional(
		Type.Union([Type.Number(), Type.String()], {
			description:
				'Existing Todo targeted by this operation. Accepts the internal numeric id or the display outline path shown in the plan, e.g. "1.2" for the second child of the first item.',
		}),
	),
	targetRef: Type.Optional(Type.String({ description: "Temporary ref created by an earlier add in this batch" })),
	ref: Type.Optional(Type.String({ description: "Unique temporary ref assigned by an add operation" })),
	text: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	parentId: Type.Optional(Type.Union([Type.Number(), Type.String(), Type.Null()])),
	parentRef: Type.Optional(Type.String()),
	placement: Type.Optional(StringEnum(["first", "last", "before", "after"] as const)),
	relativeToId: Type.Optional(Type.Union([Type.Number(), Type.String()])),
	relativeToRef: Type.Optional(Type.String()),
	status: Type.Optional(StringEnum(["pending", "in_progress", "completed", "blocked"] as const)),
	cascade: Type.Optional(Type.Boolean()),
});

export const todoSchema = Type.Object({
	action: StringEnum(["get", "apply"] as const, {
		description:
			'Top-level command. The only valid values are "get" and "apply". To add or change an item, use action "apply" and put the mutation in operations[].op; never use action "add".',
	}),
	operations: Type.Optional(
		Type.Array(todoOperationSchema, {
			minItems: 1,
			description:
				'Atomic mutations used with action "apply". A single change is still an array with one operation, for example {"action":"apply","operations":[{"op":"add","text":"Run tests"}]}.',
		}),
	),
});

export const readOnlyTodoSchema = Type.Object(
	{
		action: StringEnum(["get"] as const, {
			description: "Read the latest authoritative Main Todo projection.",
		}),
	},
	{ additionalProperties: false },
);

type DraftResult =
	| { state: TodoPlanState; changes: TodoChangeSummary; refs: Record<string, number> }
	| { error: TodoError };

type Destination = { parentId: number | null; index: number };

function emptyChanges(): TodoChangeSummary {
	return { added: 0, updated: 0, moved: 0, statusChanged: 0, removed: 0, metadataChanged: 0, reset: 0 };
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
		history: [],
	};
}

export function cloneTodoPlanSnapshot(snapshot: TodoPlanSnapshot): TodoPlanSnapshot {
	return {
		title: snapshot.title,
		summary: snapshot.summary,
		currentId: snapshot.currentId,
		nodes: snapshot.nodes.map((node) => ({ ...node })),
	};
}

export function cloneTodoPlanState(state: TodoPlanState): TodoPlanState {
	return {
		...state,
		nodes: state.nodes.map((node) => ({ ...node })),
		history: state.history.map(cloneTodoPlanSnapshot),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

function isTodoPlanSnapshot(
	value: unknown,
	requireCompleted: boolean,
): value is TodoPlanSnapshot & Record<string, unknown> {
	if (!isRecord(value)) return false;
	if (typeof value.title !== "string" || value.title.trim().length === 0) return false;
	if (value.summary !== null && typeof value.summary !== "string") return false;
	if (value.currentId !== null && (!Number.isInteger(value.currentId) || (value.currentId as number) <= 0))
		return false;
	if (!Array.isArray(value.nodes)) return false;

	const byId = new Map<number, TodoNode>();
	for (const candidate of value.nodes) {
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
		if (!TODO_STATUSES.includes(candidate.status as TodoStatus)) return false;
		if (requireCompleted && candidate.status !== "completed") return false;
		const node = candidate as TodoNode;
		if (byId.has(node.id)) return false;
		byId.set(node.id, node);
	}

	const siblingOrders = new Map<string, number[]>();
	for (const node of byId.values()) {
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
	if (value.currentId !== null && !byId.has(value.currentId as number)) return false;
	return true;
}

function maxTodoId(snapshot: TodoPlanSnapshot): number {
	return snapshot.nodes.reduce((maximum, node) => Math.max(maximum, node.id), 0);
}

export function isTodoPlanState(value: unknown): value is TodoPlanState {
	if (!isRecord(value) || value.version !== TODO_PLAN_VERSION) return false;
	if (!isTodoPlanSnapshot(value, false)) return false;
	if (!Number.isInteger(value.nextId) || (value.nextId as number) < 1) return false;
	if (!Number.isInteger(value.revision) || (value.revision as number) < 0) return false;
	if (!Array.isArray(value.history)) return false;
	if (value.history.some((snapshot) => !isTodoPlanSnapshot(snapshot, true) || snapshot.nodes.length === 0))
		return false;
	const allocatedIds = new Set<number>();
	let maxId = 0;
	for (const snapshot of [value, ...value.history] as TodoPlanSnapshot[]) {
		for (const node of snapshot.nodes) {
			if (allocatedIds.has(node.id)) return false;
			allocatedIds.add(node.id);
			maxId = Math.max(maxId, node.id);
		}
	}
	return (value.nextId as number) > maxId;
}

function isLegacyTodoPlanState(value: unknown): value is TodoPlanSnapshot & {
	version: 1;
	nextId: number;
	revision: number;
} {
	if (!isRecord(value) || value.version !== 1) return false;
	if (!isTodoPlanSnapshot(value, false)) return false;
	if (!Number.isInteger(value.nextId) || (value.nextId as number) <= maxTodoId(value)) return false;
	return Number.isInteger(value.revision) && (value.revision as number) >= 0;
}

/** Restore current snapshots and losslessly migrate valid version-1 session state. */
export function restoreTodoPlanState(value: unknown): TodoPlanState | undefined {
	if (isTodoPlanState(value)) return cloneTodoPlanState(value);
	if (!isLegacyTodoPlanState(value)) return undefined;
	return {
		...cloneTodoPlanSnapshot(value),
		version: TODO_PLAN_VERSION,
		nextId: value.nextId,
		revision: value.revision,
		history: [],
	};
}

function nodeById(state: TodoPlanState, id: number): TodoNode | undefined {
	return state.nodes.find((node) => node.id === id);
}

/**
 * Resolve a display outline path (e.g. "1", "1.2", "1.1.3") to an internal numeric Todo id.
 * The path mirrors the 1-based hierarchy rendered by flattenTodoPlan; each segment selects a
 * sibling in the same order/id sort used for display. Returns undefined when the path is
 * malformed or points past the existing tree.
 */
function resolveOutlineToId(state: TodoPlanState, outline: string): number | undefined {
	const segments = outline.trim().split(".");
	if (segments.length === 0) return undefined;
	let parentId: number | null = null;
	let resolved: number | undefined;
	for (const segment of segments) {
		if (!/^\d+$/.test(segment.trim())) return undefined;
		const index = Number.parseInt(segment, 10) - 1;
		if (index < 0) return undefined;
		const siblings = sortedSiblings(state, parentId);
		const node = siblings[index];
		if (!node) return undefined;
		resolved = node.id;
		parentId = node.id;
	}
	return resolved;
}

/**
 * Coerce an operation id input into an internal numeric id. Numbers are treated as internal ids;
 * strings are treated as display outline paths (e.g. "1.2"), falling back to a bare-integer
 * internal id when no matching outline exists. Returns undefined when the input cannot be mapped.
 */
function coerceIdInput(state: TodoPlanState, input: number | string): number | undefined {
	if (typeof input === "number") return input;
	const trimmed = input.trim();
	if (!/^\d+(\.\d+)*$/.test(trimmed)) return undefined;
	const outlineId = resolveOutlineToId(state, trimmed);
	if (outlineId !== undefined) return outlineId;
	if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
	return undefined;
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
	id: number | string | undefined,
	refValue: string | undefined,
	label: string,
): number | TodoError {
	const ref = normalizeRef(refValue);
	if (id !== undefined && ref !== undefined)
		return operationError("AMBIGUOUS_TARGET", `${label} cannot use both id and ref`);
	let resolved: number | string | undefined = id;
	if (ref !== undefined) {
		resolved = refs.get(ref);
		if (resolved === undefined) return operationError("UNKNOWN_REF", `Unknown ${label} ref: ${ref}`);
	}
	if (resolved === undefined) return operationError("MISSING_TARGET", `${label} is required`);
	const numericId = coerceIdInput(state, resolved);
	if (numericId === undefined || !Number.isInteger(numericId) || numericId <= 0 || !nodeById(state, numericId)) {
		return operationError("NOT_FOUND", `${label} #${resolved} not found`);
	}
	return numericId;
}

function resolveOptionalParent(
	state: TodoPlanState,
	refs: Map<string, number>,
	parentId: number | string | null | undefined,
	parentRefValue: string | undefined,
): number | null | TodoError {
	const parentRef = normalizeRef(parentRefValue);
	if (parentId !== undefined && parentRef !== undefined) {
		return operationError("AMBIGUOUS_PARENT", "parentId and parentRef cannot both be set");
	}
	let resolved: number | string | null = parentId ?? null;
	if (parentRef !== undefined) {
		const fromRef = refs.get(parentRef);
		if (fromRef === undefined) return operationError("UNKNOWN_REF", `Unknown parent ref: ${parentRef}`);
		resolved = fromRef;
	}
	if (resolved === null) return null;
	const numericId = coerceIdInput(state, resolved);
	if (numericId === undefined || !nodeById(state, numericId))
		return operationError("NOT_FOUND", `Parent #${resolved} not found`);
	return numericId;
}

function resolveOptionalRelative(
	state: TodoPlanState,
	refs: Map<string, number>,
	id: number | string | undefined,
	refValue: string | undefined,
): number | null | TodoError {
	const ref = normalizeRef(refValue);
	if (id !== undefined && ref !== undefined) {
		return operationError("AMBIGUOUS_RELATIVE", "relativeToId and relativeToRef cannot both be set");
	}
	if (id === undefined && ref === undefined) return null;
	const resolved: number | string | undefined = ref === undefined ? id : refs.get(ref);
	if (resolved === undefined) return operationError("UNKNOWN_REF", `Unknown relative ref: ${ref}`);
	const numericId = coerceIdInput(state, resolved);
	if (numericId === undefined || !nodeById(state, numericId))
		return operationError("NOT_FOUND", `Relative Todo #${resolved} not found`);
	return numericId;
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
			case "reset": {
				if (draft.nodes.length === 0) {
					error = operationError("RESET_EMPTY_PLAN", "Cannot reset an empty Todo plan");
					break;
				}
				const incomplete = draft.nodes.filter((node) => node.status !== "completed").length;
				if (incomplete > 0) {
					error = operationError(
						"RESET_INCOMPLETE_PLAN",
						`Cannot reset Todo: ${incomplete} item${incomplete === 1 ? " is" : "s are"} not completed`,
					);
					break;
				}
				draft.history.push(cloneTodoPlanSnapshot(draft));
				draft.nodes = [];
				draft.title = "Todo";
				draft.summary = null;
				draft.currentId = null;
				refs.clear();
				changes.reset++;
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

export function flattenTodoPlan(state: TodoPlanSnapshot): FlattenedTodoNode[] {
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
	const history = state.history.length > 0 ? ` · ${state.history.length} archived` : "";
	if (state.nodes.length === 0) return `${state.title}: no items${history}`;
	const completed = state.nodes.filter((node) => node.status === "completed").length;
	const lines = [`${state.title} · ${completed}/${state.nodes.length} completed${history}`];
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
	if (changes.reset) parts.push(`archived ${changes.reset}`);
	if (state.currentId !== null) parts.push(`current #${state.currentId}`);
	return parts.join(" · ");
}

export function createTodoTool(_cwd: string, options: TodoToolOptions = {}): AgentTool<typeof todoSchema, TodoDetails> {
	let state = createEmptyTodoPlanState();

	const loadCurrentState = (): void => {
		if (!options.loadState) return;
		state = restoreTodoPlanState(options.loadState()) ?? createEmptyTodoPlanState();
	};

	return {
		name: "todo",
		label: "Todo",
		description: options.readOnly
			? 'Read Main\'s authoritative Todo projection with {"action":"get"}. This Session cannot mutate the plan; send proposed changes to Main with send_message.'
			: 'The single source of truth for multi-step planning and progress; do not mirror it in plan/progress files or a second checklist. Top-level action is only "get" or "apply". Read with {"action":"get"}. Mutate with {"action":"apply","operations":[{"op":"add","text":"..."}]}; add/update/move/etc. belong in operations[].op, never action. A single change is a one-operation batch. Use reset to archive and start a new plan only after the current plan is non-empty and every item is completed.',
		parameters: (options.readOnly ? readOnlyTodoSchema : todoSchema) as typeof todoSchema,
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

			if (options.readOnly) {
				throw new ToolExecutionError("unauthorized", "This Session has read-only access to Main Todo");
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
