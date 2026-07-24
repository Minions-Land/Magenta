import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { HcpMagnetResource } from "../.HCP/HcpMagnetTypes.ts";
import { HcpClientloadsinglepackage } from "../_magenta/packages/package-overlay-v2.ts";
import { ProcessRuntimeProvider } from "../runtime/magenta/process-runtime.ts";
import { ScriptRuntimeProvider } from "../runtime/magenta/script-runtime.ts";
import { SandboxProvider } from "../sandbox/magenta/sandbox.ts";
import { HcpClientbuildpackagesessionfortest, type HcpClientpackagetestbuildresult } from "./package-test-utils.ts";

async function writeText(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content, "utf-8");
}

async function writeLegacyPackage(
	packagesRoot: string,
	id: string,
	components: string,
): Promise<{ packageDir: string; overlay: Awaited<ReturnType<typeof HcpClientloadsinglepackage>> }> {
	const packageDir = join(packagesRoot, id);
	await writeText(
		join(packageDir, "package.toml"),
		`schema_version = "magenta.package.v1"
id = ${JSON.stringify(id)}
name = ${JSON.stringify(id)}
version = "1.0.0"
source = ${JSON.stringify(id)}
default_profiles = []

${components}`,
	);
	return { packageDir, overlay: await HcpClientloadsinglepackage(packageDir) };
}

describe("package v1 compatibility", () => {
	it.each([
		{ label: "an omitted schema version", schemaVersion: "" },
		{ label: "an explicit v1 schema", schemaVersion: 'schema_version = "magenta.package.v1"\n' },
	])("routes $label before applying strict v2 collection validation", async ({ schemaVersion }) => {
		const packagesRoot = await mkdtemp(join(tmpdir(), "pkg-v1-shape-routing-"));
		try {
			const packageDir = join(packagesRoot, "LegacyShape");
			await writeText(
				join(packageDir, "package.toml"),
				`${schemaVersion}id = "LegacyShape"
name = "LegacyShape"
version = "1.0.0"
source = "LegacyShape"
default_profiles = "general"

[[profiles]]
name = "general"

[components]
prompt = [{ name = "legacy-prompt", path = "prompts/legacy-prompt.md" }]
`,
			);
			await writeText(join(packageDir, "prompts", "legacy-prompt.md"), "Legacy prompt.\n");

			const overlay = await HcpClientloadsinglepackage(packageDir);
			expect(overlay.diagnostics.filter((diagnostic) => diagnostic.type === "error")).toEqual([]);
			expect(overlay.componentMap.has("prompt-template:legacy-prompt")).toBe(true);
			expect(overlay.profiles.map((profile) => profile.name)).toEqual(["general"]);
		} finally {
			await rm(packagesRoot, { recursive: true, force: true });
		}
	});

	it("preserves python-runtime and env infrastructure for tools and maps prompt to prompt-template", async () => {
		const packagesRoot = await mkdtemp(join(tmpdir(), "pkg-v1-infrastructure-"));
		let assembly: HcpClientpackagetestbuildresult | undefined;
		try {
			const { packageDir } = await writeLegacyPackage(
				packagesRoot,
				"LegacyInfrastructure",
				`[[components]]
kind = "tool"
name = "python_echo"
path = "tools/python-echo.toml"

[[components]]
kind = "python-runtime"
name = "fixture_runtime"
path = "runtime/fixture_runtime/__init__.py"

[[components]]
kind = "env"
name = "pixi"
path = "pixi.toml"

[[components]]
kind = "prompt"
name = "legacy-prompt"
path = "prompts/legacy-prompt.md"
`,
			);
			await writeText(
				join(packageDir, "tools", "python-echo.toml"),
				`kind = "tool"
name = "python_echo"
description = "Python package fixture."
runtime = "fixture_runtime"
module = "fixture_runtime"
module_path = "runtime"

[parameters]
type = "object"
`,
			);
			await writeText(join(packageDir, "runtime", "fixture_runtime", "__init__.py"), "");
			await writeText(join(packageDir, "pixi.toml"), '[workspace]\nname = "fixture"\n');
			await writeText(join(packageDir, "prompts", "legacy-prompt.md"), "Legacy prompt.\n");

			const overlay = await HcpClientloadsinglepackage(packageDir);
			expect(overlay.diagnostics.filter((diagnostic) => diagnostic.type === "error")).toEqual([]);
			expect(overlay.infrastructure.map((component) => `${component.kind}:${component.name}`).sort()).toEqual([
				"env:pixi",
				"python-runtime:fixture_runtime",
			]);
			const prompt = overlay.components.find(
				(component) => component.kind === "prompt-template" && component.name === "legacy-prompt",
			);
			expect(prompt).toBeDefined();
			expect(overlay.componentMap.has("prompt-template:legacy-prompt")).toBe(true);
			expect(overlay.componentMap.has("prompt:legacy-prompt")).toBe(false);

			assembly = await HcpClientbuildpackagesessionfortest({ repoRoot: packagesRoot, overlay });
			expect(assembly.packageToolAddresses).toContain("tool:python_echo");
			expect(assembly.hcp.resolveInstance<AgentTool>("tool:python_echo")?.name).toBe("python_echo");
			expect(assembly.packageResourceAddresses).toContain("prompt-template:legacy-prompt");
			expect(assembly.hcp.resolveInstance<HcpMagnetResource>("prompt-template:legacy-prompt")).toMatchObject({
				kind: "prompt-template",
				name: "legacy-prompt",
				contentPath: join(packageDir, "prompts", "legacy-prompt.md"),
			});
		} finally {
			await assembly?.hcp.dispose();
			await rm(packagesRoot, { recursive: true, force: true });
		}
	});

	it("keeps a v1 runtime process override while filling the other default runtime slot", async () => {
		const packagesRoot = await mkdtemp(join(tmpdir(), "pkg-v1-runtime-process-"));
		let assembly: HcpClientpackagetestbuildresult | undefined;
		try {
			const { overlay } = await writeLegacyPackage(
				packagesRoot,
				"RuntimeProcess",
				`[[components]]
kind = "runtime"
name = "process"
source = "magenta"
`,
			);
			assembly = await HcpClientbuildpackagesessionfortest({ repoRoot: packagesRoot, overlay });

			expect(assembly.diagnostics).toEqual([]);
			expect(assembly.hcp.resolveCapability("runtime:process")).toBeInstanceOf(ProcessRuntimeProvider);
			expect(assembly.hcp.resolveCapability("runtime:script-runtimes")).toBeInstanceOf(ScriptRuntimeProvider);
			expect(assembly.hcp.resolve("capability:runtime:process")).toBe(assembly.hcp.resolveModule("runtime"));
			expect(assembly.hcp.resolve("capability:runtime:script-runtimes")).toBe(assembly.hcp.resolveModule("runtime"));
			expect(assembly.hcp.resolveModule("runtime")?.describe().metadata?.slots).toEqual([
				"runtime:process",
				"runtime:script-runtimes",
			]);
		} finally {
			await assembly?.hcp.dispose();
			await rm(packagesRoot, { recursive: true, force: true });
		}
	});

	it("matches a v1 script runtime override to its exact canonical slot", async () => {
		const packagesRoot = await mkdtemp(join(tmpdir(), "pkg-v1-runtime-script-"));
		let assembly: HcpClientpackagetestbuildresult | undefined;
		try {
			const { overlay } = await writeLegacyPackage(
				packagesRoot,
				"RuntimeScript",
				`[[components]]
kind = "runtime"
name = "script-runtimes"
source = "magenta"
`,
			);
			assembly = await HcpClientbuildpackagesessionfortest({ repoRoot: packagesRoot, overlay });

			expect(assembly.diagnostics).toEqual([]);
			expect(assembly.hcp.resolveCapability("runtime:process")).toBeInstanceOf(ProcessRuntimeProvider);
			expect(assembly.hcp.resolveCapability("runtime:script-runtimes")).toBeInstanceOf(ScriptRuntimeProvider);
		} finally {
			await assembly?.hcp.dispose();
			await rm(packagesRoot, { recursive: true, force: true });
		}
	});

	it("rejects a v1 runtime name without a matching HCP capability slot", async () => {
		const packagesRoot = await mkdtemp(join(tmpdir(), "pkg-v1-runtime-unknown-"));
		let assembly: HcpClientpackagetestbuildresult | undefined;
		try {
			const { overlay } = await writeLegacyPackage(
				packagesRoot,
				"RuntimeUnknown",
				`[[components]]
kind = "runtime"
name = "unknown-runtime"
source = "magenta"
`,
			);
			assembly = await HcpClientbuildpackagesessionfortest({ repoRoot: packagesRoot, overlay });

			expect(assembly.diagnostics).toContainEqual(
				expect.objectContaining({
					code: "package_component_invalid",
					message: expect.stringContaining("runtime:unknown-runtime"),
				}),
			);
			expect(assembly.hcp.resolveCapability("runtime:process")).toBeInstanceOf(ProcessRuntimeProvider);
		} finally {
			await assembly?.hcp.dispose();
			await rm(packagesRoot, { recursive: true, force: true });
		}
	});

	it("fills default capability slots when v1 sandbox and runtime overrides are broken", async () => {
		const packagesRoot = await mkdtemp(join(tmpdir(), "pkg-v1-runtime-fallback-"));
		let assembly: HcpClientpackagetestbuildresult | undefined;
		try {
			const { packageDir } = await writeLegacyPackage(
				packagesRoot,
				"RuntimeFallback",
				`[[components]]
kind = "sandbox"
name = "sandbox"
source = "magenta"
path = "sandbox/broken.toml"

[[components]]
kind = "runtime"
name = "process"
source = "missing"
`,
			);
			await writeText(join(packageDir, "sandbox", "broken.toml"), 'kind = "sandbox"\nname = "broken"\n');
			const overlay = await HcpClientloadsinglepackage(packageDir);
			assembly = await HcpClientbuildpackagesessionfortest({ repoRoot: packagesRoot, overlay });

			expect(assembly.diagnostics).toContainEqual(
				expect.objectContaining({
					code: "component_build_failed",
					module: "sandbox",
					message: expect.stringContaining("declares no profiles"),
				}),
			);
			expect(assembly.diagnostics).toContainEqual(
				expect.objectContaining({
					code: "package_component_invalid",
					message: expect.stringContaining("selects unavailable source missing"),
				}),
			);
			expect(assembly.diagnostics).not.toContainEqual(
				expect.objectContaining({ code: "component_dependency_missing" }),
			);
			expect(assembly.hcp.resolveCapability("sandbox")).toBeInstanceOf(SandboxProvider);
			expect(assembly.hcp.resolveCapability("runtime:process")).toBeInstanceOf(ProcessRuntimeProvider);
			expect(assembly.hcp.resolveCapability("runtime:script-runtimes")).toBeInstanceOf(ScriptRuntimeProvider);
			expect(assembly.hcp.resolveCapability("hook")).toBeUndefined();
			expect(assembly.hcp.resolveCapability("memory")).toBeUndefined();
			expect(assembly.hcp.resolveCapability("policy")).toBeUndefined();
		} finally {
			await assembly?.hcp.dispose();
			await rm(packagesRoot, { recursive: true, force: true });
		}
	});
});
