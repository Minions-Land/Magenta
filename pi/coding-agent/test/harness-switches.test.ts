import { describe, expect, it } from "vitest";
import {
	buildHarnessToolSwitches,
	formatHarnessComponentsSummary,
	formatHarnessRuntimeSummary,
} from "../src/core/harness-switches.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";

describe("harness switches", () => {
	it("orders tools by name and marks active tools", () => {
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
					sourceInfo: createSyntheticSourceInfo("<hcp:pi:read>", { source: "pi" }),
				},
			],
			["read"],
		);

		expect(tools.map((tool) => tool.name)).toEqual(["custom", "read"]);
		expect(tools[0]?.active).toBe(false);
		expect(tools[1]?.active).toBe(true);
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

	it("formats generated component and runtime summaries", () => {
		const components = {
			components: [
				{
					id: "tool/read",
					module: "tools/read",
					kind: "tool",
					name: "read",
					product: "tool" as const,
					status: "active" as const,
					descriptorPath: "tools/read/read.toml",
					sources: [
						{
							source: "pi",
							status: "active" as const,
							selected: true,
							active: true,
							descriptorPath: "tools/read/read.toml",
						},
					],
				},
				{
					id: "memory/memory",
					module: "memory",
					kind: "memory",
					name: "memory",
					product: "capability" as const,
					status: "selected" as const,
					descriptorPath: "memory/memory.toml",
					sources: [
						{
							source: "magenta",
							status: "selected" as const,
							selected: true,
							active: false,
							descriptorPath: "memory/memory.toml",
						},
					],
				},
			],
		};

		expect(formatHarnessComponentsSummary(components)).toContain("tool/read, memory/memory");

		const summary = formatHarnessRuntimeSummary({
			executionProfile: "ultra",
			capabilities: { workflows: true, teammates: false },
			autoCompact: true,
			skillCommands: false,
			loadedSkills: 2,
			loadedExtensions: 1,
			tools: [{ name: "read", active: true, source: "pi" }],
			harnessPackages: ["AutOmicScience"],
			packageToolCount: 1,
			packageDiagnosticCount: 0,
			activeExtensionEvents: ["session_before_compact"],
			components,
		});

		expect(summary).toContain("Execution profile: ultra");
		expect(summary).toContain("Workflows: enabled");
		expect(summary).toContain("Teammates: disabled");
		expect(summary).toContain("Auto-compact: enabled");
		expect(summary).toContain("Skill commands: disabled (2 skills loaded)");
		expect(summary).toContain("Packages: AutOmicScience; tools:1; diagnostics:0");
		expect(summary).toContain("Extension events: 1 extensions loaded; registered events: session_before_compact");
		expect(summary).not.toContain("Hooks:");
		expect(summary).not.toContain("HCP hooks");
		expect(summary).toContain("Memory: available");
		expect(summary).toContain("Components: 1/2 active");
	});
});
