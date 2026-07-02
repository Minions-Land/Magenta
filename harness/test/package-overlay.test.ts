import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../env/pi/nodejs.ts";
import {
	assemblePackageToolMagnets,
	discoverHarnessPackages,
	loadPackageOverlay,
	parsePackageSelector,
} from "../assembly/package-overlay/pi/package-overlay.ts";
import { loadSkills } from "../skills/pi/skills.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

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
				join(
					packagesRoot,
					"AutOmicScience",
					"task",
					"scrna",
					"skills",
					"omics-shared-scrna",
					"SKILL.md",
				),
				`---
name: omics-shared
description: Shared scRNA override.
---
Override.
`,
			);
			await writeText(
				join(
					packagesRoot,
					"AutOmicScience",
					"task",
					"scrna",
					"skills",
					"omics-scrna",
					"SKILL.md",
				),
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
			expect(overlay.overrides).toHaveLength(1);
			expect(overlay.overrides[0]?.key).toBe("skill:omics-shared");
			expect(overlay.resources.skillPaths.map((resource) => resource.name).sort()).toEqual([
				"omics-scrna",
				"omics-shared",
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

	it("loads the migrated AutOmicScience flat package components", async () => {
		const overlay = await loadPackageOverlay({
			repoRoot,
			selections: ["AutOmicScience"],
		});

		expect(overlay.diagnostics).toEqual([]);
		expect(overlay.packages.map((pkg) => pkg.id)).toContain("AutOmicScience");
		expect(overlay.componentMap.get("skill:omics-shared")?.path).toBe(
			join(repoRoot, "packages", "AutOmicScience", "skills", "omics-shared"),
		);
		expect(overlay.componentMap.get("skill:rna")?.path).toBe(
			join(repoRoot, "packages", "AutOmicScience", "skills", "rna"),
		);
		expect(overlay.componentMap.get("skill:multi-omics")?.path).toBe(
			join(repoRoot, "packages", "AutOmicScience", "skills", "multi-omics"),
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
		expect(overlay.resources.skillPaths.map((resource) => resource.name).sort()).toEqual([
			"multi-omics",
			"omics-shared",
			"rna",
			"scatac-seq",
			"spatial",
		]);
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
			expect(result?.content[0]?.text).toContain('"--value","abc"');
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
				expect(result?.content[0]?.text).toContain('"secret":null');
				expect(result?.details.runtimePolicy?.fs_read).toEqual([await realpath(repoRoot)]);
			} finally {
				delete process.env.MAGENTA_PACKAGE_SECRET;
			}
		});
	});

	it("assembles script runtime package tools through the Magnet factory", async () => {
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
			expect(result?.content[0]?.text).toContain('"value":"abc"');
			expect(result?.details.runtime).toBe("runtime://process");
			expect(result?.details.command).toBe("node");
			expect(result?.details.runtimePolicy).toMatchObject({
				network: "deny",
				os_enforced: false,
				max_wall_seconds: 2.5,
			});
		});
	});

	it("assembles the migrated AutOmicScience python-backed compute tool", async () => {
		const overlay = await loadPackageOverlay({
			repoRoot,
			selections: ["AutOmicScience"],
		});
		const assembly = await assemblePackageToolMagnets(overlay);

		expect(assembly.diagnostics).toEqual([]);
		expect(assembly.magnets.map((magnet) => magnet.kind)).toEqual(["python"]);
		expect(assembly.tools.map((tool) => tool.name)).toEqual(["omics_compute"]);
		expect(assembly.tools[0]?.parameters.properties).toMatchObject({
			subcommand: {
				enum: expect.arrayContaining(["summarize", "preprocess", "score"]),
			},
		});
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
			const payload = JSON.parse(result?.content[0]?.text ?? "{}") as { argv?: string[] };
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
				const payload = JSON.parse(result?.content[0]?.text ?? "{}") as { argv?: string[]; cwd?: string };
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

	it("loads migrated AutOmicScience omics skills with the harness skill loader", async () => {
		const env = new NodeExecutionEnv({ cwd: repoRoot });
		const result = await loadSkills(env, ["packages/AutOmicScience/skills"]);

		expect(result.diagnostics).toEqual([]);
		expect(result.skills.map((skill) => skill.name).sort()).toEqual([
			"multi-omics",
			"omics-shared",
			"rna",
			"scatac-seq",
			"spatial",
		]);
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
