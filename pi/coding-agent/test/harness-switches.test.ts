import { describe, expect, it } from "vitest";
import {
	buildHarnessToolSwitches,
	formatHarnessRegistrySummary,
	formatHarnessRuntimeSummary,
} from "../src/core/harness-switches.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";

describe("harness switches", () => {
	it("orders built-in tools first and marks active tools", () => {
		const tools = buildHarnessToolSwitches(
			[
				{
					name: "custom",
					description: "Custom tool",
					parameters: {},
					sourceInfo: createSyntheticSourceInfo("<sdk:custom>", { source: "sdk" }),
				},
				{
					name: "read",
					description: "Read files",
					parameters: {},
					sourceInfo: createSyntheticSourceInfo("<builtin:read>", { source: "builtin" }),
				},
			],
			["read"],
		);

		expect(tools.map((tool) => tool.name)).toEqual(["read", "custom"]);
		expect(tools[0]?.active).toBe(true);
		expect(tools[1]?.active).toBe(false);
	});

	it("keeps package tool source visible in the harness switch view", () => {
		const tools = buildHarnessToolSwitches(
			[
				{
					name: "omics_runtime",
					description: "Run omics workflows",
					parameters: {},
					sourceInfo: createSyntheticSourceInfo("<harness-package:omics_runtime>", {
						source: "harness-package",
						origin: "package",
					}),
				},
			],
			["omics_runtime"],
		);

		expect(tools).toEqual([
			expect.objectContaining({
				name: "omics_runtime",
				active: true,
				source: "harness-package",
			}),
		]);
	});

	it("formats registry and runtime summaries without implying memory is wired", () => {
		const registry = {
			name: "magenta-harness",
			components: [
				{ kind: "tool", name: "read", path: "/tmp/read.toml", spec: {} },
				{ kind: "memory", name: "memory", path: "/tmp/memory.toml", spec: {} },
			],
			catalogs: [],
		};

		expect(formatHarnessRegistrySummary({ path: "/tmp/harness.toml", registry })).toContain(
			"tool/read, memory/memory",
		);

		const summary = formatHarnessRuntimeSummary({
			autoCompact: true,
			skillCommands: false,
			loadedSkills: 2,
			loadedExtensions: 1,
			tools: [{ name: "read", active: true, source: "builtin" }],
			activeHookEvents: ["session_before_compact"],
			registry: { registry },
		});

		expect(summary).toContain("Auto-compact: enabled");
		expect(summary).toContain("Skill commands: disabled (2 skills loaded)");
		expect(summary).toContain("Memory: registered; no AgentSession runtime switch yet");
	});
});
