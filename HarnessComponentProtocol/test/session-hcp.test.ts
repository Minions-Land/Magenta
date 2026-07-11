import type { AgentTool } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { HcpClientassemble, HcpClientbuildsession, type HcpClientcomponent } from "../.HCP/assembly/session-hcp.ts";
import { HCP_MAGNETS, HCP_SERVERS } from "../.HCP/assembly/sources.generated.ts";
import { HcpClient } from "../HcpClient.ts";
import type { BashOperations } from "../tools/bash/pi/bash.ts";

const REPO_ROOT = "/test-repo";
const CORE_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls", "todo"] as const;
const CORE_TOOL_MODULES = CORE_TOOL_NAMES.map((name) => `tools/${name}`);

const mockBashOperations: BashOperations = {
	exec: async () => ({ exitCode: 0 }),
};

describe("session HcpClient assembly", () => {
	it("assembles TOML-selected autoload components into one HcpClient", async () => {
		const result = await HcpClientbuildsession({ repoRoot: REPO_ROOT });

		expect(result.diagnostics).toEqual([]);
		expect(result.hcp).toBeInstanceOf(HcpClient);
		expect(result.toolAddresses).toEqual(expect.arrayContaining(["tool:web-fetch", "tool:web-search"]));
		expect(result.hcp.resolveInstance<AgentTool>("tool:web-fetch")?.name).toBe("web-fetch");
		expect(result.hcp.resolveInstance<AgentTool>("tool:web-search")?.name).toBe("web-search");

		for (const slot of [
			"compaction",
			"context",
			"hook",
			"memory",
			"multiagent",
			"policy",
			"prompt-template",
			"sandbox",
			"system-prompt",
		]) {
			expect(result.hcp.resolveCapability(slot), `capability:${slot}`).toBeDefined();
		}

		const runtimeModule = result.hcp.resolveModule("runtime");
		expect(result.hcp.resolve("capability:runtime:process")).toBe(runtimeModule);
		expect(result.hcp.resolve("capability:runtime:script-runtimes")).toBe(runtimeModule);
		expect(result.hcp.resolveCapability("runtime:process")).toBeDefined();
		expect(result.hcp.resolveCapability("runtime:script-runtimes")).toBeDefined();

		for (const name of ["paper-analysis", "pptx", "research-orchestration", "self-evo"]) {
			expect(result.hcp.resolve(`skill:${name}`)).toBe(result.hcp.resolveModule(`skills/${name}`));
			expect(result.hcp.resolveInstance(`skill:${name}`)).toMatchObject({ kind: "skill", name });
		}
	});

	it("uses generated Server and Magnet classes for explicitly selected tool modules", async () => {
		const result = await HcpClientbuildsession({
			repoRoot: REPO_ROOT,
			modules: CORE_TOOL_MODULES,
			settings: { "tools/bash": { operations: mockBashOperations } },
		});

		expect(result.diagnostics).toEqual([]);
		for (const name of CORE_TOOL_NAMES) {
			const module = `tools/${name}`;
			const row = HCP_MAGNETS.find(
				(candidate) => candidate.module === module && candidate.selected && candidate.product === "tool",
			);
			const HcpServer = HCP_SERVERS.get(module);
			const server = result.hcp.resolveModule(module);
			const tool = result.hcp.resolveInstance<AgentTool>(`tool:${name}`);

			expect(row?.HcpMagnet.module).toBe(module);
			expect(row?.HcpMagnet.source).toBe(row?.source);
			expect(HcpServer).toBeDefined();
			expect(server).toBeInstanceOf(HcpServer!);
			expect(result.hcp.resolve(`tool:${name}`)).toBe(server);
			expect(tool?.name).toBe(name);
		}
	});

	it("does not assemble non-autoload tools unless their modules are selected", async () => {
		const defaults = await HcpClientbuildsession({ repoRoot: REPO_ROOT });
		expect(defaults.hcp.resolve("tool:read")).toBeUndefined();
		expect(defaults.hcp.resolve("tool:bash")).toBeUndefined();

		const selected = await HcpClientbuildsession({
			repoRoot: REPO_ROOT,
			modules: ["tools/read", "tools/bash"],
		});
		expect(selected.hcp.resolve("tool:read")).toBeDefined();
		expect(selected.hcp.resolve("tool:bash")).toBeUndefined();
		expect(selected.diagnostics).toEqual([]);
	});

	it("builds a settings-selected generated Source exactly once", async () => {
		const row = HCP_MAGNETS.find((candidate) => candidate.module === "tools/todo" && candidate.selected);
		expect(row).toBeDefined();
		const build = vi.spyOn(row!.HcpMagnet, "build");
		try {
			const result = await HcpClientbuildsession({
				repoRoot: REPO_ROOT,
				settings: { "tools/todo": {} },
			});

			expect(result.diagnostics).toEqual([]);
			expect(result.hcp.resolve("tool:todo")).toBeDefined();
			expect(build).toHaveBeenCalledTimes(1);
			await result.hcp.dispose();
		} finally {
			build.mockRestore();
		}
	});

	it("rejects fan-out from a leaf Tool Module instead of silently replacing a sibling", async () => {
		const row = HCP_MAGNETS.find((candidate) => candidate.module === "tools/read" && candidate.selected);
		expect(row).toBeDefined();
		const disposed: string[] = [];
		const HcpMagnet = {
			module: row!.module,
			kind: row!.kind,
			source: row!.source,
			build: () =>
				["first", "second"].map((name) => ({
					kind: "fixture",
					source: "fixture",
					toTool: () =>
						({
							name,
							label: name,
							description: name,
							parameters: {},
							execute: async () => ({ content: [], details: {} }),
						}) as unknown as AgentTool,
					dispose: () => {
						disposed.push(name);
					},
				})),
		};
		const component: HcpClientcomponent = { ...row!, HcpMagnet };
		const hcp = new HcpClient();
		const result = await HcpClientassemble({
			hcp,
			repoRoot: REPO_ROOT,
			includeGenerated: false,
			components: [component],
		});

		expect(result.addresses).toEqual([]);
		expect(result.diagnostics).toEqual([
			expect.objectContaining({
				code: "component_product_invalid",
				message: expect.stringContaining("requires one product per component"),
			}),
		]);
		expect(hcp.resolve("tool:first")).toBeUndefined();
		expect(hcp.resolve("tool:second")).toBeUndefined();
		expect(disposed.sort()).toEqual(["first", "second"]);
	});

	it("can assemble only requested modules through the public assembler", async () => {
		const hcp = new HcpClient();
		const result = await HcpClientassemble({
			hcp,
			repoRoot: REPO_ROOT,
			includeAutoload: false,
			modules: ["tools/read", "tools/todo"],
		});

		expect(result.diagnostics).toEqual([]);
		expect(result.addresses).toEqual(expect.arrayContaining(["tool:read", "tool:todo"]));
		expect(hcp.resolve("tool:read")).toBe(hcp.resolveModule("tools/read"));
		expect(hcp.resolve("tool:todo")).toBe(hcp.resolveModule("tools/todo"));
		expect(hcp.resolveCapability("compaction")).toBeUndefined();
		expect(hcp.resolve("skill:paper-analysis")).toBeUndefined();
	});

	it("disables a module subtree without creating a second selection path", async () => {
		const { hcp, diagnostics } = await HcpClientbuildsession({
			repoRoot: REPO_ROOT,
			disabledModules: ["skills", "compaction"],
		});

		expect(diagnostics).toEqual([]);
		expect(hcp.resolveModule("skills")).toBeUndefined();
		expect(hcp.resolve("skill:paper-analysis")).toBeUndefined();
		expect(hcp.resolveCapability("compaction")).toBeUndefined();
		expect(hcp.resolveCapability("context")).toBeDefined();
		expect(hcp.resolveCapability("runtime:script-runtimes")).toBeDefined();
	});
});
