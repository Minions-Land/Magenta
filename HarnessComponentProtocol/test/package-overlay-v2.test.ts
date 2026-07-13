import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { HcpClientpackageinputfromoverlay } from "../_magenta/packages/hcp-client-components.ts";
import {
	discoverHarnessPackages,
	getHarnessPackagesRoot,
	loadPackageOverlay,
	loadSinglePackage,
	parsePackageSelector,
} from "../_magenta/packages/package-overlay-v2.ts";
import { HcpClientbuildpackagesessionfortest, type HcpClientpackagetestbuildresult } from "./package-test-utils.ts";
import { writeFixturePackage } from "./package-v2-fixtures.ts";

const PROCESS_ECHO_TOML = `kind = "tool"
name = "echo_tool"
description = "Echo through a package process tool."
runtime = "process"
command = "node"
args = ["-e", "process.stdin.pipe(process.stdout)"]
operation = "execute"
read_only = true
destructive = false

[parameters]
type = "object"
additionalProperties = true
`;

describe("package overlay v2 (isomorphic HCP structure)", () => {
	it("parses package selectors with and without profiles", () => {
		expect(parsePackageSelector("AutOmicScience")).toEqual({ packageId: "AutOmicScience" });
		expect(parsePackageSelector("AutOmicScience:scrna,spatial")).toEqual({
			packageId: "AutOmicScience",
			profiles: ["scrna", "spatial"],
		});
	});

	it("resolves the default packages root under the repo", () => {
		expect(getHarnessPackagesRoot("/repo")).toBe("/repo/packages");
	});

	it("discovers v2 packages and reports their manifest metadata", async () => {
		const packagesRoot = await mkdtemp(join(tmpdir(), "pkg-v2-discover-"));
		try {
			await writeFixturePackage(packagesRoot, {
				id: "AlphaDomain",
				source: "AlphaDomain",
				profiles: [{ name: "core", description: "core" }],
				components: [
					{ kind: "brand", name: "AlphaDomain", source: "AlphaDomain" },
					{ kind: "skill", item: "guide", name: "guide", source: "AlphaDomain", includeInContext: true },
				],
			});
			const result = await discoverHarnessPackages({ packagesRoot });
			expect(result.packagesRoot).toBe(packagesRoot);
			expect(result.packages.map((p) => p.id)).toEqual(["AlphaDomain"]);
			expect(result.packages[0]?.manifest.components.length).toBe(2);
			expect(result.packages[0]?.manifest.profiles.map((p) => p.name)).toEqual(["core"]);
			expect(result.diagnostics).toEqual([]);
		} finally {
			await rm(packagesRoot, { recursive: true, force: true });
		}
	});

	it("loads a package's real magnets manifest-driven and infers products", async () => {
		const packagesRoot = await mkdtemp(join(tmpdir(), "pkg-v2-load-"));
		try {
			await writeFixturePackage(packagesRoot, {
				id: "BetaDomain",
				source: "BetaDomain",
				components: [
					{ kind: "brand", name: "BetaDomain", source: "BetaDomain" },
					{ kind: "system-prompt", name: "system-prompt", source: "BetaDomain", mergeMode: "append" },
					{ kind: "skill", item: "workflow", name: "workflow", source: "BetaDomain" },
					{
						kind: "tool",
						item: "echo",
						name: "echo_tool",
						source: "BetaDomain",
						descriptorToml: PROCESS_ECHO_TOML,
					},
				],
			});
			const overlay = await loadPackageOverlay({ packagesRoot, selections: ["BetaDomain"] });
			expect(overlay.packageId).toBe("BetaDomain");
			expect(overlay.source).toBe("BetaDomain");
			expect(overlay.diagnostics.filter((d) => d.type === "error")).toEqual([]);
			expect(overlay.components.length).toBe(4);

			const byProduct = overlay.components.reduce<Record<string, number>>((acc, c) => {
				acc[c.product] = (acc[c.product] ?? 0) + 1;
				return acc;
			}, {});
			expect(byProduct).toEqual({ resource: 3, tool: 1 });

			// Package source flows through — tools are NOT relabeled "descriptor".
			const tool = overlay.components.find((c) => c.product === "tool");
			expect(tool?.source).toBe("BetaDomain");
			// Routing module is generalized to the parent server.
			expect(tool?.module).toBe("tools");
			expect(overlay.components.find((c) => c.kind === "skill")?.module).toBe("skills");
		} finally {
			await rm(packagesRoot, { recursive: true, force: true });
		}
	});

	it("filters components by profile tag while always loading untagged ones", async () => {
		const packagesRoot = await mkdtemp(join(tmpdir(), "pkg-v2-profile-"));
		try {
			await writeFixturePackage(packagesRoot, {
				id: "GammaDomain",
				source: "GammaDomain",
				profiles: [{ name: "single-cell" }, { name: "spatial" }],
				components: [
					// untagged → always loads
					{ kind: "brand", name: "GammaDomain", source: "GammaDomain" },
					{ kind: "skill", item: "shared", name: "shared", source: "GammaDomain" },
					// tagged → load only when profile selected
					{ kind: "skill", item: "sc", name: "sc", source: "GammaDomain", profiles: ["single-cell"] },
					{ kind: "skill", item: "sp", name: "sp", source: "GammaDomain", profiles: ["spatial"] },
				],
			});

			const full = await loadPackageOverlay({ packagesRoot, selections: ["GammaDomain"] });
			expect(full.components.map((c) => c.name).sort()).toEqual(["GammaDomain", "sc", "shared", "sp"]);

			const scOnly = await loadPackageOverlay({ packagesRoot, selections: ["GammaDomain:single-cell"] });
			expect(scOnly.components.map((c) => c.name).sort()).toEqual(["GammaDomain", "sc", "shared"]);
			expect(scOnly.components.map((c) => c.name)).not.toContain("sp");
		} finally {
			await rm(packagesRoot, { recursive: true, force: true });
		}
	});

	it("assembles process-backed package tools into AgentTool instances through one HcpClient", async () => {
		const packagesRoot = await mkdtemp(join(tmpdir(), "pkg-v2-assemble-"));
		let assembly: HcpClientpackagetestbuildresult | undefined;
		try {
			await writeFixturePackage(packagesRoot, {
				id: "DeltaDomain",
				source: "DeltaDomain",
				components: [
					{
						kind: "tool",
						item: "echo",
						name: "echo_tool",
						source: "DeltaDomain",
						descriptorToml: PROCESS_ECHO_TOML,
					},
				],
			});
			const overlay = await loadPackageOverlay({ packagesRoot, selections: ["DeltaDomain"] });
			assembly = await HcpClientbuildpackagesessionfortest({ repoRoot: packagesRoot, overlay });

			expect(assembly.packageToolAddresses).toContain("tool:echo_tool");
			const tool = assembly.hcp.resolveInstance<AgentTool>("tool:echo_tool");
			expect(tool?.name).toBe("echo_tool");
			const result = await tool!.execute("call-1", {});
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toBe("{}");
		} finally {
			await assembly?.hcp.dispose();
			await rm(packagesRoot, { recursive: true, force: true });
		}
	});

	it("routes package resources (skill/brand/system-prompt) into the session Client", async () => {
		const packagesRoot = await mkdtemp(join(tmpdir(), "pkg-v2-resource-"));
		let assembly: HcpClientpackagetestbuildresult | undefined;
		try {
			await writeFixturePackage(packagesRoot, {
				id: "EpsilonDomain",
				source: "EpsilonDomain",
				components: [
					{ kind: "brand", name: "EpsilonDomain", source: "EpsilonDomain" },
					{ kind: "skill", item: "guide", name: "guide", source: "EpsilonDomain", includeInContext: true },
					{ kind: "system-prompt", name: "system-prompt", source: "EpsilonDomain", mergeMode: "append" },
				],
			});
			const overlay = await loadPackageOverlay({ packagesRoot, selections: ["EpsilonDomain"] });
			assembly = await HcpClientbuildpackagesessionfortest({ repoRoot: packagesRoot, overlay });

			expect(assembly.diagnostics.filter((d) => "type" in d && d.type === "error")).toEqual([]);
			expect(assembly.packageResourceAddresses).toContain("skill:guide");
			expect(assembly.packageResourceAddresses).toContain("brand:EpsilonDomain");
		} finally {
			await assembly?.hcp.dispose();
			await rm(packagesRoot, { recursive: true, force: true });
		}
	});

	it("reports an error when a declared component has no HcpMagnet.ts", async () => {
		const packagesRoot = await mkdtemp(join(tmpdir(), "pkg-v2-missing-"));
		try {
			const pkgDir = join(packagesRoot, "BrokenDomain");
			await mkdir(pkgDir, { recursive: true });
			await writeFile(
				join(pkgDir, "package.toml"),
				`schema_version = "magenta.package.v2"
id = "BrokenDomain"
name = "BrokenDomain"
version = "1.0.0"
source = "BrokenDomain"

[[components]]
kind = "skill"
name = "ghost"
source = "BrokenDomain"
path = "skills/ghost/BrokenDomain"
`,
				"utf-8",
			);
			const overlay = await loadSinglePackage(pkgDir);
			expect(overlay.components).toEqual([]);
			expect(overlay.diagnostics.some((d) => d.code === "magnet_not_found")).toBe(true);
		} finally {
			await rm(packagesRoot, { recursive: true, force: true });
		}
	});

	it("rejects a magnet whose static source disagrees with the manifest", async () => {
		const packagesRoot = await mkdtemp(join(tmpdir(), "pkg-v2-mismatch-"));
		try {
			const pkgDir = join(packagesRoot, "MismatchDomain");
			const magnetDir = join(pkgDir, "skills", "guide", "MismatchDomain");
			await mkdir(magnetDir, { recursive: true });
			// Magnet declares a different source than the manifest.
			await writeFile(
				join(magnetDir, "HcpMagnet.ts"),
				`export class HcpMagnet {
	static readonly module = "skills/guide";
	static readonly kind = "skill";
	static readonly source = "WrongSource";
	static build(_c: unknown) { return new HcpMagnet(); }
	readonly kind = "resource:skill";
	readonly source = "WrongSource";
	toResource() { return { kind: "skill", name: "guide", source: "WrongSource", mergeMode: "replace", contentPath: "x" }; }
}
`,
				"utf-8",
			);
			await writeFile(join(magnetDir, "SKILL.md"), "# guide\n", "utf-8");
			await writeFile(
				join(pkgDir, "package.toml"),
				`schema_version = "magenta.package.v2"
id = "MismatchDomain"
name = "MismatchDomain"
version = "1.0.0"
source = "MismatchDomain"

[[components]]
kind = "skill"
name = "guide"
source = "MismatchDomain"
path = "skills/guide/MismatchDomain"
`,
				"utf-8",
			);
			const overlay = await loadSinglePackage(pkgDir);
			expect(overlay.components).toEqual([]);
			expect(overlay.diagnostics.some((d) => d.code === "magnet_source_mismatch")).toBe(true);
		} finally {
			await rm(packagesRoot, { recursive: true, force: true });
		}
	});

	it("merges multiple package selections with later selections replacing same-address components", async () => {
		const packagesRoot = await mkdtemp(join(tmpdir(), "pkg-v2-merge-"));
		try {
			await writeFixturePackage(packagesRoot, {
				id: "FirstDomain",
				source: "FirstDomain",
				components: [{ kind: "skill", item: "guide", name: "guide", source: "FirstDomain" }],
			});
			await writeFixturePackage(packagesRoot, {
				id: "SecondDomain",
				source: "SecondDomain",
				components: [{ kind: "skill", item: "helper", name: "helper", source: "SecondDomain" }],
			});
			const overlay = await loadPackageOverlay({
				packagesRoot,
				selections: ["FirstDomain", "SecondDomain"],
			});
			expect(overlay.components.map((c) => c.name).sort()).toEqual(["guide", "helper"]);
		} finally {
			await rm(packagesRoot, { recursive: true, force: true });
		}
	});
});
