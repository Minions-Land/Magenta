import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { HcpServer } from "../hcp-contract/hcp-server.ts";
import type { HcpMagnet } from "../hcp-contract/hcp-magnet.ts";

/**
 * Tool Search — MCP-style deferral of tool schemas (spec §6).
 *
 * Tools are model-visible and numerous, so loading every tool's full schema
 * into the model context at session start burns context that scales with the
 * tool count. Tool Search defers that cost: at session start only a small set
 * of tools is active (the `tool_search` meta-tool plus a core few); the model
 * discovers the rest by NAME + short description through `tool_search`, then the
 * matching tools are activated (their full schemas materialized into the active
 * set) for subsequent turns.
 *
 * This is built entirely in the harness and needs no pi change: the harness
 * already separates the full tool `Map` from the `activeTools` subset the model
 * sees, and `prepareNextTurn` rebuilds the active set each turn — so activating
 * a tool mid-run takes effect on the next model turn. The meta-tool's `execute`
 * calls back into an injected `onActivate` (wired to `AgentHarness.setActiveTools`).
 *
 * Nothing here changes default behavior: a session only defers if a consumer
 * wires the meta-tool in and seeds a reduced initial active set. Tools carrying
 * the §9 `hotSwappable` attribute are the ones that may come and go this way.
 */

/** A cheap manifest entry: what the model sees before a tool's schema loads. */
export interface ToolSearchEntry {
	/** Tool name as the model invokes it. */
	name: string;
	/** Short description surfaced for discovery (no parameter schema). */
	description: string;
}

/** Options for {@link createToolSearchTool}. */
export interface ToolSearchOptions {
	/**
	 * The full catalog of deferrable tools (name + description only). Built from
	 * tool magnets' cheap `describe()` output via {@link buildToolSearchManifest},
	 * so no schema is realized until a tool is activated.
	 */
	manifest: readonly ToolSearchEntry[];
	/**
	 * Activate the named tools for subsequent turns. The harness wires this to
	 * `setActiveTools`, always preserving the always-active set (the meta-tool
	 * plus any core tools) so the model never loses the ability to search again.
	 * Returns the resulting active tool names.
	 */
	onActivate: (toolNames: readonly string[]) => Promise<readonly string[]> | readonly string[];
	/**
	 * Tools that stay active regardless of search (the meta-tool itself plus any
	 * core tools). Used to compute the union when activating and to annotate the
	 * manifest so the model knows what it already has.
	 */
	alwaysActive?: readonly string[];
	/** Meta-tool name. Defaults to `"tool_search"`. */
	name?: string;
	/** Max matches returned per search. Defaults to 20. */
	limit?: number;
}

/**
 * Build the deferral manifest (name + description) from tool magnets, using each
 * magnet's cheap `describe()` (no schema realized). Only magnets that produce a
 * tool (`toTool`) and expose an HCP server are included; the `kind` must be
 * `"tool"` in the description.
 */
export function buildToolSearchManifest(magnets: readonly HcpMagnet[]): ToolSearchEntry[] {
	const entries: ToolSearchEntry[] = [];
	for (const magnet of magnets) {
		if (typeof magnet.toTool !== "function" || typeof magnet.toHcpServer !== "function") continue;
		let server: HcpServer;
		try {
			server = magnet.toHcpServer();
		} catch {
			continue;
		}
		const description = server.describe();
		if (description.kind !== "tool") continue;
		const name = toolNameFromDescription(description);
		if (!name) continue;
		entries.push({ name, description: description.description ?? "" });
	}
	return entries;
}

/** Resolve the model-facing tool name from an HcpServerDescription. */
function toolNameFromDescription(description: {
	target: string;
	metadata?: Record<string, unknown>;
}): string | undefined {
	const meta = description.metadata ?? {};
	const toolName = meta.toolName;
	if (typeof toolName === "string" && toolName.length > 0) return toolName;
	const name = meta.name;
	if (typeof name === "string" && name.length > 0) return name;
	// Fall back to the address suffix (`tool:read` / `tool://read`).
	const match = /(?:^|[:/])([^:/]+)$/.exec(description.target);
	return match?.[1];
}

/** Score a manifest entry against a whitespace-delimited query (0 = no match). */
function scoreEntry(entry: ToolSearchEntry, tokens: readonly string[]): number {
	if (tokens.length === 0) return 1; // empty query lists everything
	const haystack = `${entry.name} ${entry.description}`.toLowerCase();
	let score = 0;
	for (const token of tokens) {
		const inName = entry.name.toLowerCase().includes(token);
		const inDescription = haystack.includes(token);
		if (inName) score += 2;
		else if (inDescription) score += 1;
		else return 0; // every token must match somewhere
	}
	return score;
}

/** Parameter schema for the `tool_search` meta-tool. */
export const toolSearchSchema = Type.Object({
	query: Type.Optional(
		Type.String({
			description: "Keywords to match against tool names and descriptions. Omit to list all available tools.",
		}),
	),
	activate: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Exact tool names to activate for subsequent turns. If omitted, the best matches for `query` are activated.",
		}),
	),
	preview: Type.Optional(
		Type.Boolean({
			description: "If true, only list matches without activating them.",
		}),
	),
});

type ToolSearchParams = Static<typeof toolSearchSchema>;

/**
 * Create the `tool_search` meta-tool. It is a normal {@link AgentTool} that
 * stays in the always-active set; given a query it returns matching tool names +
 * descriptions and (unless `preview` is set) activates them for the next turn.
 */
export function createToolSearchTool(options: ToolSearchOptions): AgentTool<typeof toolSearchSchema> {
	const name = options.name ?? "tool_search";
	const limit = options.limit ?? 20;
	const alwaysActive = [...(options.alwaysActive ?? [])];
	const manifestByName = new Map(options.manifest.map((entry) => [entry.name, entry] as const));

	return {
		name,
		label: "Tool Search",
		description:
			"Discover and activate tools on demand. Search by keyword to see matching tool names and descriptions, " +
			"then the matches are activated so their full schemas become available on the next turn. Use this when " +
			"you need a capability whose tool is not currently active.",
		parameters: toolSearchSchema,
		execute: async (_toolCallId, params: ToolSearchParams): Promise<AgentToolResult<unknown>> => {
			const query = typeof params.query === "string" ? params.query.trim() : "";
			const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);

			// Explicit activation list takes precedence over query matching.
			const explicit = Array.isArray(params.activate)
				? params.activate.filter((n): n is string => typeof n === "string")
				: [];
			const unknownNames = explicit.filter((n) => !manifestByName.has(n) && !alwaysActive.includes(n));

			const ranked = options.manifest
				.map((entry) => ({ entry, score: scoreEntry(entry, tokens) }))
				.filter(({ score }) => score > 0)
				.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
				.slice(0, limit)
				.map(({ entry }) => entry);

			const toActivateNames =
				explicit.length > 0 ? explicit.filter((n) => manifestByName.has(n)) : ranked.map((e) => e.name);

			const preview = params.preview === true;
			let activeNames: readonly string[] | undefined;
			if (!preview && toActivateNames.length > 0) {
				const union = Array.from(new Set([...alwaysActive, ...toActivateNames]));
				activeNames = await options.onActivate(union);
			}

			const lines: string[] = [];
			if (ranked.length === 0 && explicit.length === 0) {
				lines.push(query ? `No tools match "${query}".` : "No tools available.");
			} else {
				const shown =
					explicit.length > 0
						? explicit.map((n) => manifestByName.get(n)).filter((e): e is ToolSearchEntry => e !== undefined)
						: ranked;
				lines.push(query ? `Tools matching "${query}":` : "Available tools:");
				for (const entry of shown) {
					lines.push(`- ${entry.name}: ${entry.description}`);
				}
			}
			if (unknownNames.length > 0) {
				lines.push(`Unknown tool name(s) ignored: ${unknownNames.join(", ")}.`);
			}
			if (!preview && activeNames) {
				lines.push(`Activated: ${toActivateNames.join(", ") || "(none)"}. These tools are available next turn.`);
			} else if (preview) {
				lines.push("Preview only — no tools were activated.");
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					query,
					matches: ranked.map((e) => e.name),
					activated: preview ? [] : toActivateNames,
					active: activeNames ?? undefined,
					unknown: unknownNames,
				},
			};
		},
	};
}
