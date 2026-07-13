import { Text } from "@earendil-works/pi-tui";
import {
	flattenTodoPlan,
	isTodoPlanState,
	type TodoDetails,
	type TodoNode,
	type TodoPlanState,
	type TodoStatus,
} from "@magenta/harness";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { getTextOutput } from "./render-utils.ts";
import type { ToolRenderer } from "./renderer-registry.ts";

const COLLAPSED_LINE_LIMIT = 12;
const EXPANDED_LINE_LIMIT = 40;

function statusSymbol(status: TodoStatus): string {
	switch (status) {
		case "completed":
			return "✔";
		case "in_progress":
			return "●";
		case "blocked":
			return "!";
		default:
			return "□";
	}
}

function statusColor(status: TodoStatus): "success" | "accent" | "warning" | "muted" {
	switch (status) {
		case "completed":
			return "success";
		case "in_progress":
			return "accent";
		case "blocked":
			return "warning";
		default:
			return "muted";
	}
}

function currentPath(state: TodoPlanState): Array<{ node: TodoNode; outline: string }> {
	if (state.currentId === null) return [];
	const byId = new Map(state.nodes.map((node) => [node.id, node]));
	const outlines = new Map(flattenTodoPlan(state).map((row) => [row.node.id, row.outline]));
	const path: TodoNode[] = [];
	let node = byId.get(state.currentId);
	while (node) {
		path.push(node);
		node = node.parentId === null ? undefined : byId.get(node.parentId);
	}
	return path.reverse().map((pathNode) => ({ node: pathNode, outline: outlines.get(pathNode.id) ?? "?" }));
}

function renderPlan(details: TodoDetails, expanded: boolean, theme: Theme): string {
	const state = details.state;
	const completed = state.nodes.filter((node) => node.status === "completed").length;
	const lines: string[] = [
		theme.fg("accent", theme.bold("Updated Plan")) + theme.fg("dim", ` · ${completed}/${state.nodes.length}`),
	];
	if (state.summary) lines.push(theme.fg("muted", `└ ${state.summary}`));
	const path = currentPath(state);
	if (path.length > 0)
		lines.push(
			theme.fg("accent", `Current: ${path.map(({ node, outline }) => `${outline} ${node.text}`).join(" › ")}`),
		);

	if (state.nodes.length === 0) {
		lines.push(theme.fg("dim", "No Todo items"));
		return lines.join("\n");
	}

	const limit = expanded ? EXPANDED_LINE_LIMIT : COLLAPSED_LINE_LIMIT;
	const availableRows = Math.max(1, limit - lines.length - 1);
	const rows = flattenTodoPlan(state);
	const displayed = rows.slice(0, availableRows);
	for (const { node, depth, outline } of displayed) {
		const symbol = theme.fg(statusColor(node.status), statusSymbol(node.status));
		const number = theme.fg("accent", outline);
		const text = node.status === "completed" ? theme.fg("dim", node.text) : theme.fg("text", node.text);
		lines.push(`${"  ".repeat(depth)}${symbol} ${number} ${text}`);
	}
	const remaining = rows.length - displayed.length;
	if (remaining > 0) lines.push(theme.fg("dim", `… ${remaining} more · /todo`));
	return lines.join("\n");
}

export const todoPlanRenderer: ToolRenderer<TodoDetails> = {
	renderCall(args, theme, context) {
		const action = args?.action === "apply" ? "apply" : "get";
		const operationCount = action === "apply" && Array.isArray(args?.operations) ? args.operations.length : 0;
		const suffix = operationCount > 0 ? ` · ${operationCount} operation${operationCount === 1 ? "" : "s"}` : "";
		const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		component.setText(theme.fg("toolTitle", theme.bold(`todo ${action}`)) + theme.fg("dim", suffix));
		return component;
	},
	renderResult(result, { expanded }, theme, context) {
		const details = result.details as TodoDetails | undefined;
		const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		if (details?.error) {
			component.setText(theme.fg("error", `Todo error: ${details.error.message}`));
			return component;
		}
		if (!details || !isTodoPlanState(details.state)) {
			component.setText(theme.fg("toolOutput", getTextOutput(result, context.showImages)));
			return component;
		}
		component.setText(renderPlan(details, expanded, theme));
		return component;
	},
};
