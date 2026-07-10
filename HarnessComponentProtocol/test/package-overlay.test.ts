import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import { describe, expect, it } from "vitest";
import { HcpClientbuildsession } from "../.HCP/assembly/session-hcp.ts";
import type { HcpMagnetResource } from "../.HCP/HcpMagnetTypes.ts";
import {
	discoverHarnessPackages,
	loadPackageOverlay,
	parsePackageSelector,
} from "../_magenta/packages/package-overlay.ts";
import type { ProcessToolDetails } from "../tools/process-tool.ts";

type SessionAssembly = Awaited<ReturnType<typeof HcpClientbuildsession>>;
type ProcessAgentTool = AgentTool<TSchema, ProcessToolDetails>;

function firstText(result: { content: readonly { type: string; text?: string }[] } | undefined): string {
	const part = result?.content[0];
	return part && part.type === "text" ? (part.text ?? "") : "";
}

function resolveProcessTool(assembly: SessionAssembly, name: string): ProcessAgentTool {
	const address = `tool:${name}`;
	const tool = assembly.hcp.resolveInstance<ProcessAgentTool>(address);
	if (!tool) throw new Error(`Expected package tool ${address} to be assembled`);
	return tool;
}

function packageToolNames(assembly: SessionAssembly): string[] {
	return assembly.packageToolAddresses.map((address) => {
		const tool = assembly.hcp.resolveInstance<AgentTool>(address);
		if (!tool) throw new Error(`Expected package tool ${address} to resolve`);
		return tool.name;
	});
}

function packageToolKinds(assembly: SessionAssembly): string[] {
	const descriptions = new Map(assembly.hcp.describeAll().map((description) => [description.target, description]));
	return assembly.packageToolAddresses.map((address) => {
		const implementation = descriptions.get(address)?.metadata?.implementation;
		if (typeof implementation !== "string") {
			throw new Error(`Expected package tool ${address} to describe its implementation kind`);
		}
		return implementation;
	});
}

describe("harness package overlay", () => {
	it("parses package selectors", () => {
		expect(parsePackageSelector("AutOmicScience")).toEqual({ packageId: "AutOmicScience" });
		expect(parsePackageSelector("AutOmicScience:scrna,spatial")).toEqual({
			packageId: "AutOmicScience",
			profiles: ["scrna", "spatial"],
		});
	});

	it("assembles tools from an explicitly managed external root", async () => {
		const repoRoot = await mkdtemp(join(tmpdir(), "magenta-package-host-"));
		const packagesRoot = await mkdtemp(join(tmpdir(), "magenta-packages-"));
		const packageDir = join(packagesRoot, "external-folder");
		let assembly: SessionAssembly | undefined;
		try {
			await writeText(
				join(packageDir, "package.toml"),
				`schema_version = "magenta.package.v1"
id = "ExternalDomain"
name = "External Domain"
kind = "domain"
default_profiles = ["general"]

[[profiles]]
name = "general"
harness = "general/harness.toml"
`,
			);
			await writeText(
				join(packageDir, "general", "harness.toml"),
				`[[components]]
kind = "tool"
name = "external_echo"
path = "tools/external-echo.toml"
`,
			);
			await writeText(
				join(packageDir, "general", "tools", "external-echo.toml"),
				`kind = "tool"
name = "external_echo"
description = "Echo through an externally managed package."
runtime = "process"
command = "node"
args = ["-e", "process.stdin.pipe(process.stdout)"]
operation = "execute"
read_only = true
destructive = false

[parameters]
type = "object"
additionalProperties = true
`,
			);

			const discovery = await discoverHarnessPackages({ repoRoot, packagesRoot });
			expect(discovery.packagesRoot).toBe(packagesRoot);
			expect(discovery.packages.map((pkg) => pkg.id)).toEqual(["ExternalDomain"]);

			const overlay = await loadPackageOverlay({ repoRoot, packagesRoot, selections: ["ExternalDomain"] });
			expect(overlay.packagesRoot).toBe(packagesRoot);
			expect(overlay.packages.map((pkg) => pkg.id)).toEqual(["ExternalDomain"]);
			expect(overlay.diagnostics).toEqual([]);

			assembly = await HcpClientbuildsession({ repoRoot, overlay });
			expect(assembly.diagnostics).toEqual([]);
			expect(assembly.packageToolAddresses).toEqual(["tool:external_echo"]);
			expect(assembly.hcp.resolveInstance<AgentTool>("tool:external_echo")?.name).toBe("external_echo");
			const result = await resolveProcessTool(assembly, "external_echo").execute("external-call", {});
			expect(firstText(result)).toBe("{}");
		} finally {
			await assembly?.hcp.dispose();
			await Promise.all([
				rm(repoRoot, { recursive: true, force: true }),
				rm(packagesRoot, { recursive: true, force: true }),
			]);
		}
	});

	it("routes a Package Resource through the root Server and replaces a repository leaf address", async () => {
		await withTempRepo(async ({ repoRoot, packagesRoot }) => {
			const packageDir = join(packagesRoot, "OverrideDomain");
			await writeText(
				join(packageDir, "package.toml"),
				`schema_version = "magenta.package.v1"
id = "OverrideDomain"
name = "Override Domain"

[[components]]
kind = "skill"
name = "paper-analysis"
path = "skills/paper-analysis"

[[components]]
kind = "prompt"
name = "package-prompt"
path = "prompts/package-prompt.md"

[[components]]
kind = "theme"
name = "package-theme"
path = "themes/package-theme.json"

[[components]]
kind = "brand"
name = "package-brand"
path = "brand/BRAND.md"
`,
			);
			await writeText(
				join(packageDir, "skills", "paper-analysis", "SKILL.md"),
				`---
name: paper-analysis
description: Package override.
---

# Package paper analysis
`,
			);
			await writeText(join(packageDir, "prompts", "package-prompt.md"), "Package prompt.");
			await writeText(join(packageDir, "themes", "package-theme.json"), "{}");
			await writeText(join(packageDir, "brand", "BRAND.md"), "Package brand.");

			const overlay = await loadPackageOverlay({ repoRoot, selections: ["OverrideDomain"] });
			const assembly = await HcpClientbuildsession({ repoRoot, overlay });
			try {
				expect(assembly.diagnostics).toEqual([]);
				expect([...assembly.packageResourceAddresses].sort()).toEqual(
					[
						"brand:package-brand",
						"prompt-template:package-prompt",
						"skill:paper-analysis",
						"theme:package-theme",
					].sort(),
				);
				expect(assembly.hcp.resolve("skill:paper-analysis")).toBe(assembly.hcp.resolveModule("skills"));
				expect(assembly.hcp.resolveModule("skills/paper-analysis")).toBeUndefined();
				expect(assembly.hcp.resolveInstance<HcpMagnetResource>("skill:paper-analysis")).toMatchObject({
					kind: "skill",
					name: "paper-analysis",
					source: "OverrideDomain",
					contentPath: join(packageDir, "skills", "paper-analysis"),
					metadata: { origin: "package", packageId: "OverrideDomain", packageDir },
				});
				for (const [address, module] of [
					["prompt-template:package-prompt", "prompt-templates"],
					["theme:package-theme", "themes"],
					["brand:package-brand", "brand"],
				] as const) {
					expect(assembly.hcp.resolve(address)).toBe(assembly.hcp.resolveModule(module));
					expect(assembly.hcp.resolveInstance<HcpMagnetResource>(address)).toMatchObject({
						name: address.slice(address.indexOf(":") + 1),
						source: "OverrideDomain",
					});
				}
			} finally {
				await assembly.hcp.dispose();
			}
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
			expect(
				overlay.components
					.filter((component) => component.kind === "skill")
					.map((component) => component.name)
					.sort(),
			).toEqual(["omics-scrna", "omics-shared"]);
			expect(
				overlay.components
					.filter((component) => component.kind === "system-prompt")
					.map((component) => component.path),
			).toEqual([join(packagesRoot, "AutOmicScience", "task", "scrna", "system-prompt", "system-prompt.toml")]);
			expect(
				overlay.components.filter((component) => component.kind === "brand").map((component) => component.name),
			).toEqual(["omics-brand"]);
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
				return overlay.components
					.filter((component) => component.kind === "skill")
					.map((component) => component.name)
					.sort();
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
			const descriptorPath = join(packagesRoot, "ProcessDomain", "general", "tools", "echo-process.toml");
			const processDescriptor = (trusted = false) => `kind = "tool"
name = "echo_process"
description = "Echo a value through a process runtime."
runtime = "process"
command = "node"
args = ["echo-process.mjs"]
${trusted ? 'tags = ["trusted"]' : ""}

[parameters]
type = "object"
required = ["value"]

[parameters.properties.value]
type = "string"
description = "Value to echo."
`;
			await writeText(descriptorPath, processDescriptor());
			await writeText(
				join(packagesRoot, "ProcessDomain", "general", "tools", "echo-process.mjs"),
				`console.log(JSON.stringify({ argv: process.argv.slice(2) }));`,
			);

			const overlay = await loadPackageOverlay({ repoRoot, selections: ["ProcessDomain"] });
			const assembly = await HcpClientbuildsession({ repoRoot, overlay });
			expect(assembly.diagnostics).toEqual([]);
			expect(assembly.packageToolAddresses).toEqual(["tool:echo_process"]);
			expect(packageToolKinds(assembly)).toEqual(["process"]);

			const result = await resolveProcessTool(assembly, "echo_process").execute("tool-call", { value: "abc" });
			expect(result?.content[0]?.type).toBe("text");
			expect(firstText(result)).toContain('"--value","abc"');
			expect(result?.details.runtime).toBe("runtime://process");
			expect(result?.details.sandbox?.profile).toBe("restricted");
			expect(result?.details.sandboxEnforced).toBe(true);
			expect(result?.details.runtimePolicy).toMatchObject({
				network: "deny",
				os_enforced: false,
			});

			const withoutRuntime = await HcpClientbuildsession({
				repoRoot,
				overlay,
				disabledModules: ["runtime"],
			});
			expect(withoutRuntime.packageToolAddresses).toEqual([]);
			expect(withoutRuntime.diagnostics).toContainEqual(
				expect.objectContaining({
					code: "component_dependency_missing",
					module: "tools",
					name: "echo_process",
					message: expect.stringContaining("runtime:process"),
				}),
			);

			await writeText(descriptorPath, processDescriptor(true));
			const trustedAssembly = await HcpClientbuildsession({ repoRoot, overlay });
			expect(trustedAssembly.diagnostics).toEqual([]);
			const trustedResult = await resolveProcessTool(trustedAssembly, "echo_process").execute("tool-call", {
				value: "trusted",
			});
			expect(trustedResult.details.sandbox?.profile).toBe("trusted");
			expect(trustedResult.details.runtimePolicy?.network).toBe("allow");
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
				const assembly = await HcpClientbuildsession({ repoRoot, overlay });
				expect(assembly.diagnostics).toEqual([]);

				const result = await resolveProcessTool(assembly, "env_probe").execute("tool-call", {});
				expect(firstText(result)).toContain('"secret":null');
				expect(result?.details.runtimePolicy?.fs_read).toEqual([await realpath(join(packagesRoot, "EnvDomain"))]);
			} finally {
				delete process.env.MAGENTA_PACKAGE_SECRET;
			}
		});
	});

	it("assembles script runtime package tools through the one HcpClient path", async () => {
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
			const assembly = await HcpClientbuildsession({ repoRoot, overlay });
			expect(assembly.diagnostics).toEqual([]);
			expect(assembly.packageToolAddresses).toEqual(["tool:node_script"]);
			expect(packageToolKinds(assembly)).toEqual(["script:node"]);

			const result = await resolveProcessTool(assembly, "node_script").execute("tool-call", { value: "abc" });
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
			const assembly = await HcpClientbuildsession({ repoRoot, overlay });
			expect(assembly.diagnostics).toEqual([]);
			expect(assembly.packageToolAddresses).toEqual(["tool:python_echo"]);
			expect(packageToolKinds(assembly)).toEqual(["python"]);

			const result = await resolveProcessTool(assembly, "python_echo").execute("tool-call", { value: "xyz" });
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
				const assembly = await HcpClientbuildsession({ repoRoot, overlay });
				expect(assembly.diagnostics).toEqual([]);

				const result = await resolveProcessTool(assembly, "pixi_python").execute("tool-call", {
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
			const assembly = await HcpClientbuildsession({ repoRoot, overlay });

			expect(assembly.packageToolAddresses).toEqual([]);
			expect(assembly.diagnostics).toEqual([
				expect.objectContaining({
					code: "package_tool_environment_missing",
					packageId: "NoEnvDomain",
				}),
			]);
		});
	});

	it("derives package tools and capability overrides through one session HcpClient", async () => {
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
			const assembly = await HcpClientbuildsession({ repoRoot, overlay });
			expect(assembly.diagnostics).toEqual([]);

			const tool = assembly.hcp.resolveInstance<{ name: string }>("tool:echo_process");
			expect(tool?.name).toBe("echo_process");
			expect(assembly.packageToolAddresses).toEqual(["tool:echo_process"]);

			const resolved = assembly.hcp.resolveCapability("compaction");
			expect(resolved).toBeDefined();
			expect(assembly.hcp.resolve("capability:compaction")).toBe(assembly.hcp.resolveModule("compaction"));
			expect(packageToolNames(assembly)).toEqual(["echo_process"]);
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
			expect(overlay.components.some((component) => component.key === "skill:escaping-skill")).toBe(false);
			expect(overlay.diagnostics.some((diagnostic) => diagnostic.code === "package_harness_invalid")).toBe(true);
			expect(overlay.diagnostics.some((diagnostic) => diagnostic.code === "package_component_invalid")).toBe(true);
		});
	});

	it("rejects a package-local symlink that resolves outside the Package directory", async () => {
		await withTempRepo(async ({ repoRoot, packagesRoot }) => {
			const packageDir = join(packagesRoot, "SymlinkDomain");
			const outsideSkill = join(repoRoot, "outside-skill");
			await writeText(join(outsideSkill, "SKILL.md"), "# Outside");
			await writeText(
				join(packageDir, "package.toml"),
				`schema_version = "magenta.package.v1"
id = "SymlinkDomain"
name = "Symlink Domain"

[[components]]
kind = "skill"
name = "outside"
path = "linked-skill"
`,
			);
			await symlink(outsideSkill, join(packageDir, "linked-skill"), "dir");

			const overlay = await loadPackageOverlay({ repoRoot, selections: ["SymlinkDomain"] });

			expect(overlay.componentMap.has("skill:outside")).toBe(false);
			expect(overlay.diagnostics).toContainEqual(
				expect.objectContaining({
					code: "package_component_invalid",
					message: expect.stringContaining("escapes the package directory"),
				}),
			);
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
