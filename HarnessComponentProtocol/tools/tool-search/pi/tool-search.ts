import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { HcpServerDescription } from "../../../.HCP/HcpServerTypes.ts";

export type ToolSearchEntry = {
	name: string;
	description: string;
};

export type ToolSearchOptions = {
	manifest: readonly ToolSearchEntry[];
	onActivate: (toolNames: readonly string[]) => Promise<readonly string[]> | readonly string[];
	alwaysActive?: readonly string[];
	name?: string;
	limit?: number;
};

/** Build a searchable tool manifest from descriptions owned by the session Client. */
export function buildToolSearchManifest(descriptions: readonly HcpServerDescription[]): ToolSearchEntry[] {
	const entries = new Map<string, ToolSearchEntry>();
	for (const description of descriptions) {
		if (description.kind !== "tool" || !description.target.startsWith("tool:")) continue;
		const name = toolNameFromDescription(description);
		if (!name) continue;
		entries.set(name, { name, description: description.description ?? "" });
	}
	return [...entries.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function toolNameFromDescription(description: HcpServerDescription): string | undefined {
	const metadataName = description.metadata?.name;
	if (typeof metadataName === "string" && metadataName.length > 0) return metadataName;
	const match = /(?:^|[:/])([^:/]+)$/.exec(description.target);
	return match?.[1];
}

function scoreEntry(entry: ToolSearchEntry, tokens: readonly string[]): number {
	if (tokens.length === 0) return 1;
	const haystack = `${entry.name} ${entry.description}`.toLowerCase();
	let score = 0;
	for (const token of tokens) {
		if (entry.name.toLowerCase().includes(token)) score += 2;
		else if (haystack.includes(token)) score += 1;
		else return 0;
	}
	return score;
}

export const toolSearchSchema = Type.Object({
	query: Type.Optional(Type.String({ description: "Keywords to match against tool names and descriptions." })),
	activate: Type.Optional(
		Type.Array(Type.String(), { description: "Exact tool names to activate for subsequent turns." }),
	),
	preview: Type.Optional(Type.Boolean({ description: "List matches without activating them." })),
});

type ToolSearchParams = Static<typeof toolSearchSchema>;

export function createToolSearchTool(options: ToolSearchOptions): AgentTool<typeof toolSearchSchema> {
	const name = options.name ?? "tool_search";
	const limit = options.limit ?? 20;
	const alwaysActive = [...(options.alwaysActive ?? [])];
	const manifestByName = new Map(options.manifest.map((entry) => [entry.name, entry] as const));

	return {
		name,
		label: "Tool Search",
		description:
			"Discover and activate tools on demand. Search by keyword, then activate matching tools for the next turn.",
		parameters: toolSearchSchema,
		execute: async (_toolCallId, params: ToolSearchParams): Promise<AgentToolResult<unknown>> => {
			const query = typeof params.query === "string" ? params.query.trim() : "";
			const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
			const explicit = Array.isArray(params.activate)
				? params.activate.filter((entry): entry is string => typeof entry === "string")
				: [];
			const unknownNames = explicit.filter((entry) => !manifestByName.has(entry) && !alwaysActive.includes(entry));
			const ranked = options.manifest
				.map((entry) => ({ entry, score: scoreEntry(entry, tokens) }))
				.filter(({ score }) => score > 0)
				.sort((left, right) => right.score - left.score || left.entry.name.localeCompare(right.entry.name))
				.slice(0, limit)
				.map(({ entry }) => entry);
			const toActivate =
				explicit.length > 0
					? explicit.filter((entry) => manifestByName.has(entry))
					: ranked.map((entry) => entry.name);
			const preview = params.preview === true;
			let active: readonly string[] | undefined;
			if (!preview && toActivate.length > 0) {
				active = await options.onActivate([...new Set([...alwaysActive, ...toActivate])]);
			}

			const shown =
				explicit.length > 0
					? explicit
							.map((entry) => manifestByName.get(entry))
							.filter((entry): entry is ToolSearchEntry => entry !== undefined)
					: ranked;
			const lines =
				shown.length > 0
					? [
							query ? `Tools matching "${query}":` : "Available tools:",
							...shown.map((entry) => `- ${entry.name}: ${entry.description}`),
						]
					: [query ? `No tools match "${query}".` : "No tools available."];
			if (unknownNames.length > 0) lines.push(`Unknown tool name(s) ignored: ${unknownNames.join(", ")}.`);
			if (preview) lines.push("Preview only; no tools were activated.");
			else if (active) lines.push(`Activated: ${toActivate.join(", ")}. These tools are available next turn.`);

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					query,
					matches: ranked.map((entry) => entry.name),
					activated: preview ? [] : toActivate,
					active,
					unknown: unknownNames,
				},
			};
		},
	};
}
