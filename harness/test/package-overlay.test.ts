import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TObject } from "typebox";
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../core/env/pi/nodejs.ts";
import {
	assemblePackageToolMagnets,
	discoverHarnessPackages,
	loadPackageOverlay,
	parsePackageSelector,
} from "../hcp-client/overlay/package-overlay.ts";
import type { ProcessToolMagnet } from "../hcp-magnet/process.ts";
import { loadSkills } from "../modules/skills/pi/skills.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

// packages/ is a git submodule (MagentaPackages); when it is not initialized
// (fresh clone without --recurse-submodules, or CI that skips submodules) the
// real-package integration tests below have nothing to read. Gate them on the
// submodule being present so they skip cleanly instead of failing on missing files.
const hasAutOmicScience = existsSync(join(repoRoot, "packages", "AutOmicScience", "package.toml"));
const itAutOmic = it.skipIf(!hasAutOmicScience);

function firstText(result: { content: readonly { type: string; text?: string }[] } | undefined): string {
	const part = result?.content[0];
	return part && part.type === "text" ? (part.text ?? "") : "";
}

describe("harness package overlay", () => {
	it("parses package selectors", () => {
		expect(parsePackageSelector("AutOmicScience")).toEqual({ packageId: "AutOmicScience" });
		expect(parsePackageSelector("AutOmicScience:scrna,spatial")).toEqual({
			packageId: "AutOmicScience",
			profiles: ["scrna", "spatial"],
		});
	});

	it("discovers package manifests and resolves selected profile overlays", async () => {
		await withTempRepo(async ({ repoRoot, packagesRoot }) => {
			await writeText(
				join(packagesRoot, "AutOmicScience", "package.toml"),
				`schema_version = "magenta.package.v1"
id = "AutOmicScience"
name = "AutOmicScience"
kind = "domain"
domain = "bioinformatics"
description = "Multi-omics analysis harness package."
default_profiles = ["general"]

[[components]]
kind = "brand"
name = "omics-brand"
path = "brands/omics"

[[profiles]]
name = "general"
description = "Shared omics resources."
harness = "general/harness.toml"

[[profiles]]
name = "scrna"
description = "Single-cell RNA-seq resources."
extends = ["general"]
harness = "task/scrna/harness.toml"
`,
			);
			await writeText(
				join(packagesRoot, "AutOmicScience", "general", "harness.toml"),
				`name = "omics-general"
description = "Shared omics package profile."

[[components.mcp]]
name = "omics_preflight"
path = "mcp/process/omics-preflight.toml"

[[components.skill]]
name = "omics-shared"
path = "skills/omics-shared"
include_in_context = true

[[components.system-prompt]]
name = "system-prompt"
path = "system-prompt/system-prompt.toml"
`,
			);
			await writeText(
				join(packagesRoot, "AutOmicScience", "task", "scrna", "harness.toml"),
				`name = "omics-scrna"
description = "Single-cell RNA-seq profile."

[[components]]
kind = "skill"
name = "omics-shared"
path = "skills/omics-shared-scrna"
include_in_context = true

[[components]]
kind = "skill"
name = "omics-scrna"
path = "skills/omics-scrna"
include_in_context = true

[[components]]
kind = "system-prompt"
name = "system-prompt"
path = "system-prompt/system-prompt.toml"
`,
			);
			await writeText(join(packagesRoot, "AutOmicScience", "brands", "omics", "README.md"), "brand");
			await writeText(
				join(packagesRoot, "AutOmicScience", "general", "mcp", "process", "omics-preflight.toml"),
				`kind = "mcp"
name = "omics_preflight"
`,
			);
			await writeText(
				join(packagesRoot, "AutOmicScience", "general", "skills", "omics-shared", "SKILL.md"),
				`---
name: omics-shared
description: Shared omics skill.
---
Shared.
`,
			);
			await writeText(
				join(packagesRoot, "AutOmicScience", "general", "system-prompt", "system-prompt.toml"),
				`kind = "system-prompt"
name = "system-prompt"
description = "General prompt."
source = "AutOmicScience"
content_path = "SYSTEM.md"
`,
			);
			await writeText(
				join(packagesRoot, "AutOmicScience", "general", "system-prompt", "SYSTEM.md"),
				"General prompt.",
			);
			await writeText(
				join(packagesRoot, "AutOmicScience", "task", "scrna", "skills", "omics-shared-scrna", "SKILL.md"),
				`---
name: omics-shared
description: Shared scRNA override.
---
Override.
`,
			);
			await writeText(
				join(packagesRoot, "AutOmicScience", "task", "scrna", "system-prompt", "system-prompt.toml"),
				`kind = "system-prompt"
name = "system-prompt"
description = "scRNA prompt."
source = "AutOmicScience"
content_path = "SYSTEM.md"
`,
			);
			await writeText(
				join(packagesRoot, "AutOmicScience", "task", "scrna", "system-prompt", "SYSTEM.md"),
				"scRNA prompt.",
			);
			await writeText(
				join(packagesRoot, "AutOmicScience", "task", "scrna", "skills", "omics-scrna", "SKILL.md"),
				`---
name: omics-scrna
description: scRNA skill.
---
scRNA.
`,
			);

			const discovery = await discoverHarnessPackages({ repoRoot });
			expect(discovery.diagnostics).toEqual([]);
			expect(discovery.repoRoot).toBe(repoRoot);
			expect(discovery.packagesRoot).toBe(packagesRoot);
			expect(discovery.packages.map((pkg) => pkg.id)).toEqual(["AutOmicScience"]);

			const overlay = await loadPackageOverlay({
				repoRoot,
				selections: ["AutOmicScience:scrna"],
			});

			expect(overlay.diagnostics).toEqual([]);
			expect(overlay.repoRoot).toBe(repoRoot);
			expect(overlay.packagesRoot).toBe(packagesRoot);
			expect(overlay.packages.map((pkg) => pkg.id)).toEqual(["AutOmicScience"]);
			expect(overlay.componentMap.get("brand:omics-brand")?.path).toBe(
				join(packagesRoot, "AutOmicScience", "brands", "omics"),
			);
			expect(overlay.componentMap.get("mcp:omics_preflight")?.path).toBe(
				join(packagesRoot, "AutOmicScience", "general", "mcp", "process", "omics-preflight.toml"),
			);
			expect(overlay.componentMap.get("skill:omics-shared")?.profile).toBe("scrna");
			expect(overlay.componentMap.get("skill:omics-shared")?.path).toBe(
				join(packagesRoot, "AutOmicScience", "task", "scrna", "skills", "omics-shared-scrna"),
			);
			expect(overlay.componentMap.get("system-prompt:system-prompt")?.profile).toBe("scrna");
			expect(overlay.componentMap.get("system-prompt:system-prompt")?.path).toBe(
				join(packagesRoot, "AutOmicScience", "task", "scrna", "system-prompt", "system-prompt.toml"),
			);
			expect(overlay.overrides).toHaveLength(2);
			expect(overlay.overrides[0]?.key).toBe("skill:omics-shared");
			expect(overlay.overrides[1]?.key).toBe("system-prompt:system-prompt");
			expect(overlay.resources.skillPaths.map((resource) => resource.name).sort()).toEqual([
				"omics-scrna",
				"omics-shared",
			]);
			expect(overlay.resources.systemPromptPaths.map((resource) => resource.path)).toEqual([
				join(packagesRoot, "AutOmicScience", "task", "scrna", "system-prompt", "system-prompt.toml"),
			]);
			expect(overlay.resources.brandPaths.map((resource) => resource.name)).toEqual(["omics-brand"]);
		});
	});

	it("reports missing selected profiles and harness files as diagnostics", async () => {
		await withTempRepo(async ({ repoRoot, packagesRoot }) => {
			await writeText(
				join(packagesRoot, "BrokenDomain", "package.toml"),
				`schema_version = "magenta.package.v1"
id = "BrokenDomain"
name = "BrokenDomain"
default_profiles = ["general"]

[[profiles]]
name = "general"
harness = "missing/harness.toml"
`,
			);

			const missingProfile = await loadPackageOverlay({
				repoRoot,
				selections: ["BrokenDomain:scrna"],
			});
			expect(missingProfile.diagnostics.some((diagnostic) => diagnostic.code === "package_profile_missing")).toBe(
				true,
			);
			expect(missingProfile.diagnostics.some((diagnostic) => diagnostic.code === "package_harness_missing")).toBe(
				true,
			);
		});
	});

	it("filters root components by profile tag while always loading untagged ones", async () => {
		await withTempRepo(async ({ repoRoot, packagesRoot }) => {
			await writeText(
				join(packagesRoot, "TagPkg", "package.toml"),
				`schema_version = "magenta.package.v1"
id = "TagPkg"
name = "TagPkg"
kind = "domain"
default_profiles = []

[[profiles]]
name = "alpha"

[[profiles]]
name = "beta"

[[profiles]]
name = "all"
extends = ["alpha", "beta"]

[[components]]
kind = "skill"
name = "shared"
path = "skills/shared"

[[components]]
kind = "skill"
name = "a1"
path = "skills/a1"
profiles = ["alpha"]

[[components]]
kind = "skill"
name = "a2"
path = "skills/a2"
profiles = ["alpha"]

[[components]]
kind = "skill"
name = "b1"
path = "skills/b1"
profiles = ["beta"]
`,
			);
			for (const name of ["shared", "a1", "a2", "b1"]) {
				await writeText(
					join(packagesRoot, "TagPkg", "skills", name, "SKILL.md"),
					`---\nname: ${name}\ndescription: ${name} skill.\n---\n${name}\n`,
				);
			}

			const skillNames = async (selector: string): Promise<string[]> => {
				const overlay = await loadPackageOverlay({ repoRoot, selections: [selector] });
				expect(overlay.diagnostics).toEqual([]);
				return overlay.resources.skillPaths.map((resource) => resource.name).sort();
			};

			// No selector + empty default_profiles = no narrowing → whole package.
			expect(await skillNames("TagPkg")).toEqual(["a1", "a2", "b1", "shared"]);
			// A profile narrows to its tagged components; untagged `shared` still loads.
			expect(await skillNames("TagPkg:alpha")).toEqual(["a1", "a2", "shared"]);
			expect(await skillNames("TagPkg:beta")).toEqual(["b1", "shared"]);
			// Multiple profiles union their tags.
			expect(await skillNames("TagPkg:alpha,beta")).toEqual(["a1", "a2", "b1", "shared"]);
			// `all` extends both topic profiles, so its closure matches every tag.
			expect(await skillNames("TagPkg:all")).toEqual(["a1", "a2", "b1", "shared"]);
		});
	});

	itAutOmic("loads the migrated AutOmicScience flat package components", async () => {
		const overlay = await loadPackageOverlay({
			repoRoot,
			selections: ["AutOmicScience"],
		});

		expect(overlay.diagnostics).toEqual([]);
		expect(overlay.packages.map((pkg) => pkg.id)).toContain("AutOmicScience");
		expect(overlay.componentMap.get("brand:AutOmicScience")?.path).toBe(
			join(repoRoot, "packages", "AutOmicScience", "brands", "AutOmicScience"),
		);
		expect(overlay.componentMap.get("skill:omics-shared")?.path).toBe(
			join(repoRoot, "packages", "AutOmicScience", "skills", "omics-shared"),
		);
		expect(overlay.componentMap.get("skill:single-cell")?.path).toBe(
			join(repoRoot, "packages", "AutOmicScience", "skills", "single-cell"),
		);
		expect(overlay.componentMap.get("skill:bulk")?.path).toBe(
			join(repoRoot, "packages", "AutOmicScience", "skills", "bulk"),
		);
		const runtimeComponent = overlay.componentMap.get("python-runtime:aose_omics_runtime");
		expect(runtimeComponent?.path).toBe(
			join(repoRoot, "packages", "AutOmicScience", "tools", "omics-compute", "python", "aose_omics_runtime"),
		);
		expect(runtimeComponent?.profile).toBeUndefined();
		const envComponent = overlay.componentMap.get("env:pixi");
		expect(envComponent?.path).toBe(
			join(repoRoot, "packages", "AutOmicScience", "tools", "omics-environment", "pixi.toml"),
		);
		expect(envComponent?.profile).toBeUndefined();
		expect(overlay.componentMap.get("tool:omics_compute")?.path).toBe(
			join(repoRoot, "packages", "AutOmicScience", "tools", "omics-compute", "omics-compute.toml"),
		);
		expect(overlay.componentMap.get("append-system-prompt:system-prompt")?.path).toBe(
			join(repoRoot, "packages", "AutOmicScience", "system-prompt", "system-prompt.toml"),
		);
		// Skill set is owned/versioned by the MagentaPackages repo (packages/ is a
		// submodule), so assert the foundational skills resolve rather than pinning
		// the exact list — the list grows as that repo adds skills.
		expect(overlay.resources.skillPaths.map((resource) => resource.name)).toEqual(
			expect.arrayContaining(["omics-shared", "single-cell", "bulk", "bioml", "spatial"]),
		);
		expect(overlay.resources.appendSystemPromptPaths.map((resource) => resource.name)).toEqual(["system-prompt"]);
		expect(overlay.resources.brandPaths.map((resource) => resource.name)).toEqual(["AutOmicScience"]);
	});

	it("assembles process-backed package tools into AgentTool instances", async () => {
		await withTempRepo(async ({ repoRoot, packagesRoot }) => {
			await writeText(
				join(packagesRoot, "ProcessDomain", "package.toml"),
				`schema_version = "magenta.package.v1"
id = "ProcessDomain"
name = "ProcessDomain"
default_profiles = ["general"]

[[profiles]]
name = "general"
harness = "general/harness.toml"
`,
			);
			await writeText(
				join(packagesRoot, "ProcessDomain", "general", "harness.toml"),
				`name = "process-general"

[[components]]
kind = "tool"
name = "echo_process"
path = "tools/echo-process.toml"
`,
			);
			await writeText(
				join(packagesRoot, "ProcessDomain", "general", "tools", "echo-process.toml"),
				`kind = "tool"
name = "echo_process"
description = "Echo a value through a process runtime."
runtime = "process"
command = "node"
args = ["echo-process.mjs"]

[parameters]
type = "object"
required = ["value"]

[parameters.properties.value]
type = "string"
description = "Value to echo."
`,
			);
			await writeText(
				join(packagesRoot, "ProcessDomain", "general", "tools", "echo-process.mjs"),
				`console.log(JSON.stringify({ argv: process.argv.slice(2) }));`,
			);

			const overlay = await loadPackageOverlay({ repoRoot, selections: ["ProcessDomain"] });
			const assembly = await assemblePackageToolMagnets(overlay);
			expect(assembly.diagnostics).toEqual([]);
			expect(assembly.magnets.map((magnet) => magnet.kind)).toEqual(["process"]);
			expect(assembly.tools.map((tool) => tool.name)).toEqual(["echo_process"]);

			const result = await assembly.tools[0]?.execute("tool-call", { value: "abc" });
			expect(result?.content[0]?.type).toBe("text");
			expect(firstText(result)).toContain('"--value","abc"');
			expect(result?.details.runtime).toBe("runtime://process");
			expect(result?.details.sandboxEnforced).toBe(true);
			expect(result?.details.runtimePolicy).toMatchObject({
				network: "deny",
				os_enforced: false,
			});
		});
	});

	it("runs package process tools through the sandboxed runtime env allowlist", async () => {
		await withTempRepo(async ({ repoRoot, packagesRoot }) => {
			await writeText(
				join(packagesRoot, "EnvDomain", "package.toml"),
				`schema_version = "magenta.package.v1"
id = "EnvDomain"
name = "EnvDomain"
default_profiles = ["general"]

[[profiles]]
name = "general"
harness = "general/harness.toml"
`,
			);
			await writeText(
				join(packagesRoot, "EnvDomain", "general", "harness.toml"),
				`name = "env-general"

[[components]]
kind = "tool"
name = "env_probe"
path = "tools/env-probe.toml"
`,
			);
			await writeText(
				join(packagesRoot, "EnvDomain", "general", "tools", "env-probe.toml"),
				`kind = "tool"
name = "env_probe"
description = "Probe inherited environment."
runtime = "process"
command = "node"
args = ["env-probe.mjs"]
operation = "read"
read_only = true

[parameters]
type = "object"
`,
			);
			await writeText(
				join(packagesRoot, "EnvDomain", "general", "tools", "env-probe.mjs"),
				`console.log(JSON.stringify({ secret: process.env.MAGENTA_PACKAGE_SECRET ?? null }));`,
			);

			process.env.MAGENTA_PACKAGE_SECRET = "must-not-leak";
			try {
				const overlay = await loadPackageOverlay({ repoRoot, selections: ["EnvDomain"] });
				const assembly = await assemblePackageToolMagnets(overlay);
				expect(assembly.diagnostics).toEqual([]);

				const result = await assembly.tools[0]?.execute("tool-call", {});
				expect(firstText(result)).toContain('"secret":null');
				expect(result?.details.runtimePolicy?.fs_read).toEqual([await realpath(repoRoot)]);
			} finally {
				delete process.env.MAGENTA_PACKAGE_SECRET;
			}
		});
	});

	it("assembles script runtime package tools through the HcpMagnet factory", async () => {
		await withTempRepo(async ({ repoRoot, packagesRoot }) => {
			await writeText(
				join(packagesRoot, "ScriptDomain", "package.toml"),
				`schema_version = "magenta.package.v1"
id = "ScriptDomain"
name = "ScriptDomain"
default_profiles = ["general"]

[[profiles]]
name = "general"
harness = "general/harness.toml"
`,
			);
			await writeText(
				join(packagesRoot, "ScriptDomain", "general", "harness.toml"),
				`name = "script-general"

[[components]]
kind = "tool"
name = "node_script"
path = "tools/node-script.toml"
`,
			);
			await writeText(
				join(packagesRoot, "ScriptDomain", "general", "tools", "node-script.toml"),
				`kind = "tool"
name = "node_script"
description = "Echo through the package script runtime."
runtime = "node"
script_path = "node-script.js"
operation = "read"
read_only = true
timeout_ms = 2500

[parameters]
type = "object"
required = ["value"]

[parameters.properties.value]
type = "string"
`,
			);
			await writeText(
				join(packagesRoot, "ScriptDomain", "general", "tools", "node-script.js"),
				`let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify(JSON.parse(input)));
});
`,
			);

			const overlay = await loadPackageOverlay({ repoRoot, selections: ["ScriptDomain"] });
			const assembly = await assemblePackageToolMagnets(overlay);
			expect(assembly.diagnostics).toEqual([]);
			expect(assembly.magnets.map((magnet) => magnet.kind)).toEqual(["script:node"]);
			expect(assembly.tools.map((tool) => tool.name)).toEqual(["node_script"]);

			const result = await assembly.tools[0]?.execute("tool-call", { value: "abc" });
			expect(firstText(result)).toContain('"value":"abc"');
			expect(result?.details.runtime).toBe("runtime://process");
			expect(result?.details.command).toBe("node");
			expect(result?.details.runtimePolicy).toMatchObject({
				network: "deny",
				os_enforced: false,
				max_wall_seconds: 2.5,
			});
		});
	});

	itAutOmic("assembles the migrated AutOmicScience python-backed compute tool", async () => {
		const overlay = await loadPackageOverlay({
			repoRoot,
			selections: ["AutOmicScience"],
		});
		const assembly = await assemblePackageToolMagnets(overlay);

		// bio_api is a runtime=mcp tool. When its vendored server binary
		// (aose-bio-mcp) has been built, assembly spawns it, enumerates the remote
		// tools, and fans them out into the address space alongside the omics
		// tools. When the binary is absent (no Rust toolchain / not yet built),
		// that is a recoverable state and assembly degrades bio_api to a single
		// `package_tool_runtime_missing` warning instead of an error. Accept both
		// so the suite is stable regardless of whether the binary is present.
		const bioBinaryBuilt = existsSync(
			join(repoRoot, "packages/AutOmicScience/tools/bio-api/rust/target/release/aose-bio-mcp"),
		);
		expect(assembly.diagnostics.filter((d) => d.type === "error")).toEqual([]);
		expect(assembly.diagnostics.filter((d) => d.type === "warning").map((d) => d.code)).toEqual(
			bioBinaryBuilt ? [] : ["package_tool_runtime_missing"],
		);
		// The four omics magnets always assemble: omics_environment +
		// omics_install_env are process tools (pixi CLI); omics_preflight and
		// omics_compute are python-backed (aose_omics_runtime). When the bio_api
		// binary is built, its remote tools add `mcp` magnets on top.
		const magnetKinds = assembly.magnets.map((magnet) => magnet.kind);
		expect(magnetKinds.filter((kind) => kind === "process").length).toBe(2);
		expect(magnetKinds.filter((kind) => kind === "python").length).toBe(2);
		if (bioBinaryBuilt) {
			expect(magnetKinds.filter((kind) => kind === "mcp").length).toBeGreaterThanOrEqual(26);
		} else {
			expect(magnetKinds).not.toContain("mcp");
		}
		const toolNames = assembly.tools.map((tool) => tool.name);
		expect(toolNames).toEqual(
			expect.arrayContaining(["omics_environment", "omics_preflight", "omics_install_env", "omics_compute"]),
		);
		if (bioBinaryBuilt) {
			// The vendored server exposes the non-key-gated bio tools, namespaced
			// under the biofetch prefix, and they must land in the address space.
			const bioTools = toolNames.filter((name) => name.startsWith("biofetch_"));
			expect(bioTools.length).toBeGreaterThanOrEqual(26);
			expect(bioTools).toContain("biofetch_ensembl_info");
		} else {
			expect(toolNames.some((name) => name.startsWith("biofetch_"))).toBe(false);
		}
		const compute = assembly.tools.find((tool) => tool.name === "omics_compute");
		expect((compute?.parameters as TObject | undefined)?.properties).toMatchObject({
			subcommand: {
				enum: expect.arrayContaining(["summarize", "preprocess", "score"]),
			},
		});
		// omics_install_env downloads packages and writes the env prefix, so it
		// must land in the trusted sandbox (network + workspace write). Guard that.
		const installIdx = assembly.tools.findIndex((tool) => tool.name === "omics_install_env");
		expect((assembly.magnets[installIdx] as ProcessToolMagnet | undefined)?.sandboxSelection().profile).toBe(
			"trusted",
		);
	});

	it("executes package-local python module runtime tools", async () => {
		await withTempRepo(async ({ repoRoot, packagesRoot }) => {
			await writeText(
				join(packagesRoot, "PythonDomain", "package.toml"),
				`schema_version = "magenta.package.v1"
id = "PythonDomain"
name = "PythonDomain"
default_profiles = ["general"]

[[profiles]]
name = "general"
harness = "general/harness.toml"
`,
			);
			await writeText(
				join(packagesRoot, "PythonDomain", "general", "harness.toml"),
				`name = "python-general"

[[components]]
kind = "tool"
name = "python_echo"
path = "tools/python-echo.toml"

[[components]]
kind = "python-runtime"
name = "example_runtime"
path = "../.runtime/example_runtime"
`,
			);
			await writeText(
				join(packagesRoot, "PythonDomain", "general", "tools", "python-echo.toml"),
				`kind = "tool"
name = "python_echo"
description = "Echo through a package-local Python module."
runtime = "example_runtime"
module = "example_runtime"
module_path = ".runtime"
python_bin = "python3"

[parameters]
type = "object"
required = ["value"]

[parameters.properties.value]
type = "string"
description = "Value to echo."
`,
			);
			await writeText(join(packagesRoot, "PythonDomain", ".runtime", "example_runtime", "__init__.py"), "");
			await writeText(
				join(packagesRoot, "PythonDomain", ".runtime", "example_runtime", "__main__.py"),
				`import json
import sys

print(json.dumps({"argv": sys.argv[1:]}))
`,
			);

			const overlay = await loadPackageOverlay({ repoRoot, selections: ["PythonDomain"] });
			const assembly = await assemblePackageToolMagnets(overlay);
			expect(assembly.diagnostics).toEqual([]);
			expect(assembly.magnets.map((magnet) => magnet.kind)).toEqual(["python"]);

			const result = await assembly.tools[0]?.execute("tool-call", { value: "xyz" });
			expect(result?.content[0]?.type).toBe("text");
			const payload = JSON.parse(firstText(result) || "{}") as { argv?: string[] };
			expect(payload.argv).toEqual(["--value", "xyz"]);
		});
	});

	it("uses package pixi environments for python tools without python_bin", async () => {
		await withTempRepo(async ({ repoRoot, packagesRoot }) => {
			const binDir = join(repoRoot, "bin");
			await writeText(
				join(binDir, "pixi"),
				`#!/usr/bin/env node
const args = process.argv.slice(2);
const executableIndex = args.indexOf("--executable");
if (executableIndex === -1) throw new Error("missing --executable");
const command = args[executableIndex + 1];
const rest = args.slice(executableIndex + 2);
const child = require("node:child_process").spawnSync(command, rest, { stdio: "inherit", env: process.env });
process.exit(child.status ?? 1);
`,
			);
			await chmod(join(binDir, "pixi"), 0o755);
			await writeText(
				join(packagesRoot, "PixiDomain", "package.toml"),
				`schema_version = "magenta.package.v1"
id = "PixiDomain"
name = "PixiDomain"
default_profiles = ["general"]

[[profiles]]
name = "general"
harness = "general/harness.toml"
`,
			);
			await writeText(
				join(packagesRoot, "PixiDomain", "general", "harness.toml"),
				`name = "pixi-general"

[[components]]
kind = "tool"
name = "pixi_python"
path = "tools/pixi-python.toml"

[[components]]
kind = "python-runtime"
name = "example_runtime"
path = "../.runtime/example_runtime"

[[components]]
kind = "env"
name = "pixi"
path = "../pixi.toml"
`,
			);
			await writeText(join(packagesRoot, "PixiDomain", "pixi.toml"), `[workspace]\nname = "pixi-domain"\n`);
			await writeText(
				join(packagesRoot, "PixiDomain", "general", "tools", "pixi-python.toml"),
				`kind = "tool"
name = "pixi_python"
description = "Echo through a package-local Python module in pixi."
runtime = "example_runtime"
module = "example_runtime"
module_path = ".runtime"
pixi_environment = "default"

[metadata.pixi_environment_by_modality]
scrna = "task1"
spatial = "task2"

[parameters]
type = "object"
required = ["value"]

[parameters.properties.value]
type = "string"
`,
			);
			await writeText(join(packagesRoot, "PixiDomain", ".runtime", "example_runtime", "__init__.py"), "");
			await writeText(
				join(packagesRoot, "PixiDomain", ".runtime", "example_runtime", "__main__.py"),
				`import json
import os
import sys

print(json.dumps({"argv": sys.argv[1:], "cwd": os.getcwd(), "path": os.environ.get("PATH", "")}))
`,
			);

			const previousPath = process.env.PATH;
			process.env.PATH = `${binDir}:${previousPath ?? ""}`;
			try {
				const overlay = await loadPackageOverlay({ repoRoot, selections: ["PixiDomain"] });
				const assembly = await assemblePackageToolMagnets(overlay);
				expect(assembly.diagnostics).toEqual([]);

				const result = await assembly.tools[0]?.execute("tool-call", {
					modality: "scrna",
					value: "xyz",
					args: { modality: "scrna" },
				});
				expect(result?.details.command).toBe("pixi");
				expect(result?.details.args).toEqual(
					expect.arrayContaining(["run", "--manifest-path", join(packagesRoot, "PixiDomain", "pixi.toml")]),
				);
				expect(result?.details.args).toEqual(expect.arrayContaining(["--environment", "task1"]));
				expect(result?.details.args).toEqual(expect.arrayContaining(["--executable", "python"]));
				expect(result?.details.args).toEqual(expect.arrayContaining(["-m", "example_runtime"]));
				const payload = JSON.parse(firstText(result) || "{}") as { argv?: string[]; cwd?: string };
				expect(payload.argv).toEqual(["--modality", "scrna", "--value", "xyz"]);
				expect(payload.cwd).toBe(await realpath(repoRoot));
			} finally {
				process.env.PATH = previousPath;
			}
		});
	});

	it("diagnoses python package tools without an explicit or package environment", async () => {
		await withTempRepo(async ({ repoRoot, packagesRoot }) => {
			await writeText(
				join(packagesRoot, "NoEnvDomain", "package.toml"),
				`schema_version = "magenta.package.v1"
id = "NoEnvDomain"
name = "NoEnvDomain"
default_profiles = ["general"]

[[profiles]]
name = "general"
harness = "general/harness.toml"
`,
			);
			await writeText(
				join(packagesRoot, "NoEnvDomain", "general", "harness.toml"),
				`name = "no-env-general"

[[components]]
kind = "tool"
name = "no_env_python"
path = "tools/no-env-python.toml"

[[components]]
kind = "python-runtime"
name = "example_runtime"
path = "../.runtime/example_runtime"
`,
			);
			await writeText(
				join(packagesRoot, "NoEnvDomain", "general", "tools", "no-env-python.toml"),
				`kind = "tool"
name = "no_env_python"
description = "Python tool with no env binding."
runtime = "example_runtime"
module = "example_runtime"
module_path = ".runtime"

[parameters]
type = "object"
`,
			);
			await writeText(join(packagesRoot, "NoEnvDomain", ".runtime", "example_runtime", "__init__.py"), "");

			const overlay = await loadPackageOverlay({ repoRoot, selections: ["NoEnvDomain"] });
			const assembly = await assemblePackageToolMagnets(overlay);

			expect(assembly.magnets).toEqual([]);
			expect(assembly.diagnostics).toEqual([
				expect.objectContaining({
					code: "package_tool_environment_missing",
					packageId: "NoEnvDomain",
				}),
			]);
		});
	});

	it("derives tools and capabilities through the one HCP registry", async () => {
		await withTempRepo(async ({ repoRoot, packagesRoot }) => {
			await writeText(
				join(packagesRoot, "HcpDomain", "package.toml"),
				`schema_version = "magenta.package.v1"
id = "HcpDomain"
name = "HcpDomain"
default_profiles = ["general"]

[[profiles]]
name = "general"
harness = "general/harness.toml"
`,
			);
			await writeText(
				join(packagesRoot, "HcpDomain", "general", "harness.toml"),
				`name = "hcp-general"

[[components]]
kind = "tool"
name = "echo_process"
path = "tools/echo-process.toml"

[[components]]
kind = "compaction"
name = "compaction"
path = "capabilities/compaction.toml"
`,
			);
			await writeText(
				join(packagesRoot, "HcpDomain", "general", "tools", "echo-process.toml"),
				`kind = "tool"
name = "echo_process"
description = "Echo a value through a process runtime."
runtime = "process"
command = "node"
args = ["echo-process.mjs"]

[parameters]
type = "object"
`,
			);
			await writeText(
				join(packagesRoot, "HcpDomain", "general", "capabilities", "compaction.toml"),
				`kind = "compaction"
name = "compaction"
description = "Context compaction."
source = "pi"
`,
			);

			const overlay = await loadPackageOverlay({ repoRoot, selections: ["HcpDomain"] });
			const assembly = await assemblePackageToolMagnets(overlay);
			expect(assembly.diagnostics).toEqual([]);

			// The tool in assembly.tools was derived by resolving THROUGH the
			// registry at its address — re-resolving yields an equivalent AgentTool
			// (toTool builds fresh each call, so compare by value, not identity).
			const toolTarget = assembly.hcp.resolve("tool://echo_process");
			expect((toolTarget?.instance?.() as { name: string }).name).toBe("echo_process");
			expect(assembly.tools[0]?.name).toBe("echo_process");

			// The capability is resolvable by slot name and IS the injected binding's
			// instance. Consumer code passes only "compaction" — no source.
			const resolved = assembly.hcp.resolveCapability("compaction");
			expect(resolved).toBe(assembly.capabilities.get("compaction")?.instance);
			expect(resolved).toBeDefined();
			// The capability never leaks onto the tool hot path.
			expect(assembly.tools.map((t) => t.name)).toEqual(["echo_process"]);
		});
	});

	it("applies component source bundles and reports conflicts", async () => {
		await withTempRepo(async ({ repoRoot, packagesRoot }) => {
			await writeText(
				join(packagesRoot, "BundleDomain", "package.toml"),
				`schema_version = "magenta.package.v1"
id = "BundleDomain"
name = "BundleDomain"
default_profiles = ["general"]

[[profiles]]
name = "general"
harness = "general/harness.toml"
`,
			);
			await writeText(
				join(packagesRoot, "BundleDomain", "general", "harness.toml"),
				`name = "bundle-general"

[[components]]
kind = "sandbox"
name = "workspace"
path = "sandbox/workspace.toml"

[[components]]
kind = "runtime"
name = "process"
path = "runtime/process.toml"
`,
			);
			await writeText(
				join(packagesRoot, "BundleDomain", "general", "sandbox", "workspace.toml"),
				`kind = "sandbox"
name = "workspace"
source = "magenta"
bundles = ["runtime:magenta"]
`,
			);
			await writeText(
				join(packagesRoot, "BundleDomain", "general", "runtime", "process.toml"),
				`kind = "runtime"
name = "process"
source = "pi"
`,
			);

			const overlay = await loadPackageOverlay({ repoRoot, selections: ["BundleDomain"] });

			expect(overlay.componentMap.get("sandbox:workspace")?.source).toBe("magenta");
			expect(overlay.componentMap.get("runtime:process")?.source).toBe("magenta");
			expect(overlay.diagnostics).toContainEqual(
				expect.objectContaining({
					type: "warning",
					code: "package_bundle_conflict",
					message: expect.stringContaining("runtime:magenta"),
				}),
			);
		});
	});

	itAutOmic("loads migrated AutOmicScience omics skills with the harness skill loader", async () => {
		const env = new NodeExecutionEnv({ cwd: repoRoot });
		const result = await loadSkills(env, ["packages/AutOmicScience/skills"]);

		expect(result.diagnostics).toEqual([]);
		expect(result.skills.map((skill) => skill.name)).toEqual(
			expect.arrayContaining(["omics-shared", "single-cell", "bulk", "bioml", "spatial"]),
		);
	});

	it("rejects absolute and package-escaping references", async () => {
		await withTempRepo(async ({ repoRoot, packagesRoot }) => {
			await writeText(
				join(packagesRoot, "StrictDomain", "package.toml"),
				`schema_version = "magenta.package.v1"
id = "StrictDomain"
name = "StrictDomain"
default_profiles = ["general"]

[[profiles]]
name = "general"
harness = "/tmp/not-a-package-harness.toml"

[[profiles]]
name = "task"
harness = "task/harness.toml"
`,
			);
			await writeText(
				join(packagesRoot, "StrictDomain", "task", "harness.toml"),
				`name = "strict-task"

[[components]]
kind = "skill"
name = "escaping-skill"
path = "../../../outside-skill"
`,
			);

			const overlay = await loadPackageOverlay({
				repoRoot,
				selections: ["StrictDomain:task"],
				includeDefaultProfiles: true,
			});

			expect(overlay.componentMap.has("skill:escaping-skill")).toBe(false);
			expect(overlay.resources.skillPaths).toEqual([]);
			expect(overlay.diagnostics.some((diagnostic) => diagnostic.code === "package_harness_invalid")).toBe(true);
			expect(overlay.diagnostics.some((diagnostic) => diagnostic.code === "package_component_invalid")).toBe(true);
		});
	});
});

async function withTempRepo(run: (paths: { repoRoot: string; packagesRoot: string }) => Promise<void>): Promise<void> {
	const repoRoot = await mkdtemp(join(tmpdir(), "magenta-harness-packages-"));
	try {
		const packagesRoot = join(repoRoot, "packages");
		await mkdir(packagesRoot, { recursive: true });
		await run({ repoRoot, packagesRoot });
	} finally {
		await rm(repoRoot, { recursive: true, force: true });
	}
}

async function writeText(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content, "utf-8");
}
