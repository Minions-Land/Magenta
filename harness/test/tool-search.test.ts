import type { AgentContext, AgentTool } from "@earendil-works/pi-agent-core";
import {
	createModels,
	type FauxProviderHandle,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../core/env/pi/nodejs.ts";
import { AgentHarness } from "../core/loop/pi/agent-harness.ts";
import { InMemorySessionStorage } from "../core/session/pi/memory-storage.ts";
import { Session } from "../core/session/pi/session.ts";
import type { HcpMagnet } from "../hcp-contract/hcp-magnet.ts";
import { createReadMagnet } from "../hcp-magnet/native.ts";
import {
	buildToolSearchManifest,
	createToolSearchTool,
	type ToolSearchEntry,
} from "../modules/tools-search/tool-search.ts";

/**
 * Tool Search (spec §6) — MCP-style deferral of tool schemas. These tests pin
 * the manifest-from-magnets extraction, the keyword ranking, and the activation
 * contract (the meta-tool activates matches via the injected `onActivate`, which
 * the harness wires to `setActiveTools`). No pi loop is needed: the meta-tool is
 * a normal AgentTool whose `execute` mutates the active set for the next turn.
 */

const MANIFEST: ToolSearchEntry[] = [
	{ name: "read", description: "Read the contents of a file with optional offset and limit." },
	{ name: "write", description: "Write content to a file, creating or overwriting it." },
	{ name: "grep", description: "Search file contents for a regex pattern." },
	{ name: "web-search", description: "Search the web for current information." },
];

async function runSearch(
	tool: ReturnType<typeof createToolSearchTool>,
	params: { query?: string; activate?: string[]; preview?: boolean },
): Promise<{ text: string; details: any }> {
	const result = await tool.execute("call-1", params as never);
	const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
	return { text, details: result.details };
}

describe("Tool Search — manifest from magnets", () => {
	it("extracts name + description from a tool magnet's cheap describe() (no schema)", () => {
		const manifest = buildToolSearchManifest([createReadMagnet(process.cwd())]);
		expect(manifest).toHaveLength(1);
		expect(manifest[0]?.name).toBe("read");
		expect(manifest[0]?.description).toContain("Read the contents");
	});

	it("skips magnets that are not tools (no toTool / non-tool kind)", () => {
		const capabilityLike: HcpMagnet = {
			kind: "native",
			toCapability: () => ({ kind: "memory", name: "memory", source: "magenta", instance: {} }),
			toHcpServer: () => ({
				describe: () => ({ target: "capability:memory", kind: "memory", ops: [] }),
				call: () => undefined,
			}),
		};
		expect(buildToolSearchManifest([capabilityLike])).toEqual([]);
	});
});

describe("Tool Search — ranking", () => {
	it("ranks name matches above description-only matches and requires every token to match", async () => {
		const tool = createToolSearchTool({ manifest: MANIFEST, onActivate: (n) => n });
		const { details } = await runSearch(tool, { query: "search", preview: true });
		// "web-search" matches in name (score 2); "grep" matches "search" in description (score 1).
		expect(details.matches[0]).toBe("web-search");
		expect(details.matches).toContain("grep");
		expect(details.matches).not.toContain("read");
	});

	it("returns nothing when a token matches no tool", async () => {
		const tool = createToolSearchTool({ manifest: MANIFEST, onActivate: (n) => n });
		const { details } = await runSearch(tool, { query: "nonexistent", preview: true });
		expect(details.matches).toEqual([]);
	});

	it("lists everything for an empty query", async () => {
		const tool = createToolSearchTool({ manifest: MANIFEST, onActivate: (n) => n });
		const { details } = await runSearch(tool, { preview: true });
		expect(details.matches.sort()).toEqual(["grep", "read", "web-search", "write"]);
	});
});

describe("Tool Search — activation", () => {
	it("activates the best matches via onActivate, preserving the always-active set", async () => {
		const calls: string[][] = [];
		const tool = createToolSearchTool({
			manifest: MANIFEST,
			alwaysActive: ["tool_search"],
			onActivate: (names) => {
				calls.push([...names]);
				return names;
			},
		});
		const { details } = await runSearch(tool, { query: "file" });
		expect(calls).toHaveLength(1);
		// always-active is preserved in the union handed to setActiveTools.
		expect(calls[0]).toContain("tool_search");
		expect(details.activated.length).toBeGreaterThan(0);
		expect(details.active).toContain("tool_search");
	});

	it("preview mode never activates", async () => {
		const calls: string[][] = [];
		const tool = createToolSearchTool({
			manifest: MANIFEST,
			alwaysActive: ["tool_search"],
			onActivate: (names) => {
				calls.push([...names]);
				return names;
			},
		});
		const { text, details } = await runSearch(tool, { query: "file", preview: true });
		expect(calls).toHaveLength(0);
		expect(details.activated).toEqual([]);
		expect(text).toContain("Preview only");
	});

	it("explicit activate list takes precedence over the query and ignores unknown names", async () => {
		const calls: string[][] = [];
		const tool = createToolSearchTool({
			manifest: MANIFEST,
			alwaysActive: ["tool_search"],
			onActivate: (names) => {
				calls.push([...names]);
				return names;
			},
		});
		const { text, details } = await runSearch(tool, { query: "grep", activate: ["read", "bogus"] });
		expect(details.activated).toEqual(["read"]);
		expect(calls[0]).toEqual(expect.arrayContaining(["tool_search", "read"]));
		expect(calls[0]).not.toContain("bogus");
		expect(text).toContain("Unknown tool name(s) ignored: bogus");
	});

	it("does not call onActivate when there is nothing to activate", async () => {
		const calls: string[][] = [];
		const tool = createToolSearchTool({
			manifest: MANIFEST,
			onActivate: (names) => {
				calls.push([...names]);
				return names;
			},
		});
		await runSearch(tool, { query: "nonexistent" });
		expect(calls).toHaveLength(0);
	});
});

describe("Tool Search — meta-tool shape", () => {
	it("is a normal AgentTool with a stable default name and schema", () => {
		const tool = createToolSearchTool({ manifest: MANIFEST, onActivate: (n) => n });
		expect(tool.name).toBe("tool_search");
		expect(tool.label).toBe("Tool Search");
		expect(tool.parameters).toBeDefined();
		expect(typeof tool.execute).toBe("function");
	});

	it("honors a custom meta-tool name", () => {
		const tool = createToolSearchTool({ manifest: MANIFEST, onActivate: (n) => n, name: "load_tools" });
		expect(tool.name).toBe("load_tools");
	});
});

describe("Tool Search — end-to-end deferral through AgentHarness", () => {
	const models = createModels();
	let fauxCount = 0;
	function newFaux(): FauxProviderHandle {
		const faux = fauxProvider({ provider: `faux-ts-${++fauxCount}` });
		models.setProvider(faux.provider);
		return faux;
	}

	it("activates a deferred tool via tool_search and the next model turn sees it", async () => {
		// A deferred tool the model does NOT start with.
		const deferred: AgentTool = {
			name: "calculate",
			label: "Calculate",
			description: "Evaluate an arithmetic expression.",
			parameters: { type: "object", properties: {} } as never,
			execute: async () => ({ content: [{ type: "text", text: "42" }], details: undefined }),
		};

		const registration = newFaux();
		const toolsPerTurn: string[][] = [];
		registration.setResponses([
			// Turn 1: only tool_search is active; the model searches + activates "calculate".
			(context: AgentContext) => {
				toolsPerTurn.push((context.tools ?? []).map((t) => t.name).sort());
				return fauxAssistantMessage(fauxToolCall("tool_search", { query: "arithmetic" }, { id: "call-1" }), {
					stopReason: "toolUse",
				});
			},
			// Turn 2: the activated tool must now be visible to the model.
			(context: AgentContext) => {
				toolsPerTurn.push((context.tools ?? []).map((t) => t.name).sort());
				return fauxAssistantMessage("done");
			},
		]);

		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			models,
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
			// Seed the reduced initial active set: only the meta-tool.
			tools: [deferred],
			activeToolNames: [],
		});

		const manifest = buildToolSearchManifest([]).concat([
			{ name: "calculate", description: "Evaluate an arithmetic expression." },
		]);
		const searchTool = createToolSearchTool({
			manifest,
			alwaysActive: ["tool_search"],
			onActivate: async (names) => {
				await harness.setActiveTools([...names]);
				return harness.getActiveTools().map((t) => t.name);
			},
		});
		await harness.setTools([deferred, searchTool], ["tool_search"]);

		await harness.prompt("compute something");

		// Turn 1 saw only tool_search; turn 2 saw calculate activated alongside it.
		expect(toolsPerTurn[0]).toEqual(["tool_search"]);
		expect(toolsPerTurn[1]).toEqual(["calculate", "tool_search"]);
	});
});
