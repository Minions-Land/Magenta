import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { HcpMagnetBuildContext, HcpMagnetResource } from "../.HCP/HcpMagnetTypes.ts";
import { HcpClientpackageinputfromoverlay } from "../_magenta/packages/hcp-client-components.ts";
import {
	HcpClientdiscoverharnesspackages,
	HcpClientgetharnesspackagesroot,
	HcpClientloadpackageoverlay,
	HcpClientloadsinglepackage,
	HcpClientparsepackageselector,
} from "../_magenta/packages/package-overlay-v2.ts";
import type { ProcessExecInput } from "../runtime/HcpServer.ts";
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
		expect(HcpClientparsepackageselector("AutOmicScience")).toEqual({ packageId: "AutOmicScience" });
		expect(HcpClientparsepackageselector("AutOmicScience:scrna,spatial")).toEqual({
			packageId: "AutOmicScience",
			profiles: ["scrna", "spatial"],
		});
	});

	it("rejects local selectors with traversal, separators, drive roots, or UNC roots", async () => {
		const packagesRoot = await mkdtemp(join(tmpdir(), "pkg-v2-selector-strict-"));
		const outsideRoot = await mkdtemp(join(tmpdir(), "pkg-v2-selector-outside-"));
		try {
			await writeFixturePackage(outsideRoot, {
				id: "EscapedDomain",
				source: "EscapedDomain",
				components: [],
			});
			await symlink(join(outsideRoot, "EscapedDomain"), join(packagesRoot, "LinkedDomain"));

			const overlay = await HcpClientloadpackageoverlay({
				packagesRoot,
				selections: ["../", "nested\\EscapedDomain", "C:\\EscapedDomain", "\\\\server\\share", "LinkedDomain"],
			});

			expect(overlay.components).toEqual([]);
			expect(
				overlay.diagnostics.filter((diagnostic) => diagnostic.code === "package_selector_invalid"),
			).toHaveLength(5);
		} finally {
			await Promise.all([
				rm(packagesRoot, { recursive: true, force: true }),
				rm(outsideRoot, { recursive: true, force: true }),
			]);
		}
	});

	it("rejects a local selector when its directory and manifest ids differ", async () => {
		const packagesRoot = await mkdtemp(join(tmpdir(), "pkg-v2-selector-id-"));
		try {
			const packageDir = await writeFixturePackage(packagesRoot, {
				id: "ManifestDomain",
				source: "ManifestDomain",
				components: [],
			});
			await symlink(packageDir, join(packagesRoot, "SelectedDomain"));

			const overlay = await HcpClientloadpackageoverlay({ packagesRoot, selections: ["SelectedDomain"] });
			expect(overlay.packages).toEqual([]);
			expect(overlay.diagnostics).toContainEqual(
				expect.objectContaining({
					code: "package_manifest_id_mismatch",
					packageId: "SelectedDomain",
				}),
			);
		} finally {
			await rm(packagesRoot, { recursive: true, force: true });
		}
	});

	it("resolves the default packages root under the repo", () => {
		expect(HcpClientgetharnesspackagesroot("/repo")).toBe("/repo/packages");
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
			const result = await HcpClientdiscoverharnesspackages({ packagesRoot });
			expect(result.packagesRoot).toBe(packagesRoot);
			expect(result.packages.map((p) => p.id)).toEqual(["AlphaDomain"]);
			expect(result.packages[0]?.manifest.components.length).toBe(2);
			expect(result.packages[0]?.manifest.profiles.map((p) => p.name)).toEqual(["core"]);
			expect(result.diagnostics).toEqual([]);
		} finally {
			await rm(packagesRoot, { recursive: true, force: true });
		}
	});

	it("keeps malformed manifests out of discovery and reports the directory basename", async () => {
		const packagesRoot = await mkdtemp(join(tmpdir(), "pkg-v2-discover-invalid-"));
		try {
			const brokenTomlDir = join(packagesRoot, "BrokenTomlDomain");
			const brokenShapeDir = join(packagesRoot, "BrokenShapeDomain");
			const mismatchedIdDir = join(packagesRoot, "DirectoryDomain");
			await Promise.all([
				mkdir(brokenTomlDir, { recursive: true }),
				mkdir(brokenShapeDir, { recursive: true }),
				mkdir(mismatchedIdDir, { recursive: true }),
			]);
			await writeFile(join(brokenTomlDir, "package.toml"), "[[not valid", "utf-8");
			await writeFile(
				join(brokenShapeDir, "package.toml"),
				`schema_version = "magenta.package.v2"
id = "BrokenShapeDomain"
name = "Broken Shape Domain"
version = "1.0.0"
source = "BrokenShapeDomain"
profiles = "not-an-array"
`,
				"utf-8",
			);
			await writeFile(
				join(mismatchedIdDir, "package.toml"),
				`schema_version = "magenta.package.v2"
id = "ManifestDomain"
name = "Manifest Domain"
version = "1.0.0"
source = "ManifestDomain"
`,
				"utf-8",
			);

			const result = await HcpClientdiscoverharnesspackages({ packagesRoot });
			expect(result.packages).toEqual([]);
			expect(result.diagnostics).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						code: "package_manifest_parse_failed",
						packageId: "BrokenTomlDomain",
					}),
					expect.objectContaining({
						code: "package_manifest_invalid",
						packageId: "BrokenShapeDomain",
						message: expect.stringContaining("profiles must be an array"),
					}),
					expect.objectContaining({
						code: "package_manifest_id_mismatch",
						packageId: "DirectoryDomain",
					}),
				]),
			);
		} finally {
			await rm(packagesRoot, { recursive: true, force: true });
		}
	});

	it("returns diagnostics instead of throwing for malformed v2 collection and component shapes", async () => {
		const packagesRoot = await mkdtemp(join(tmpdir(), "pkg-v2-manifest-shapes-"));
		try {
			const invalidBodies = [
				'default_profiles = "general"',
				'profiles = "general"',
				'components = "tool"',
				`[[components]]
kind = 42
name = "broken"
source = "BrokenComponentDomain"
path = "tools/broken/BrokenComponentDomain"`,
			];
			for (const [index, invalidBody] of invalidBodies.entries()) {
				const packageId =
					index === invalidBodies.length - 1 ? "BrokenComponentDomain" : `BrokenShapeDomain${index}`;
				const packageDir = join(packagesRoot, packageId);
				await mkdir(packageDir, { recursive: true });
				await writeFile(
					join(packageDir, "package.toml"),
					`schema_version = "magenta.package.v2"
id = "${packageId}"
name = "${packageId}"
version = "1.0.0"
source = "${packageId}"
${invalidBody}
`,
					"utf-8",
				);

				const overlay = await HcpClientloadsinglepackage(packageDir);
				expect(overlay.components, packageId).toEqual([]);
				expect(overlay.packages, packageId).toEqual([]);
				expect(overlay.diagnostics, packageId).toContainEqual(
					expect.objectContaining({ code: "package_manifest_invalid", packageId }),
				);
			}
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
			const overlay = await HcpClientloadpackageoverlay({ packagesRoot, selections: ["BetaDomain"] });
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
			// Package components retain their real owning Module identities.
			expect(tool?.module).toBe("tools/echo");
			expect(overlay.components.find((c) => c.kind === "skill")?.module).toBe("skills/workflow");
		} finally {
			await rm(packagesRoot, { recursive: true, force: true });
		}
	});

	it("reloads edited local HcpMagnet and HcpServer role files in the same process", async () => {
		const packagesRoot = await mkdtemp(join(tmpdir(), "pkg-v2-role-reload-"));
		try {
			const packageDir = await writeFixturePackage(packagesRoot, {
				id: "ReloadDomain",
				source: "ReloadDomain",
				components: [{ kind: "skill", item: "guide", name: "guide", source: "ReloadDomain" }],
			});
			const magnetPath = join(packageDir, "skills", "guide", "ReloadDomain", "HcpMagnet.ts");
			const serverPath = join(packageDir, "skills", "guide", "HcpServer.ts");
			const first = await HcpClientloadsinglepackage(packageDir);
			const context: HcpMagnetBuildContext = {
				repoRoot: packagesRoot,
				kind: "skill",
				name: "guide",
				source: "ReloadDomain",
			};
			const firstProduct = (await first.components[0]!.HcpMagnet.build(context)) as {
				toResource(): HcpMagnetResource;
			};
			expect(firstProduct.toResource().name).toBe("guide");

			await writeFile(
				magnetPath,
				(await readFile(magnetPath, "utf8")).replace('name: "guide",', 'name: "guide-reloaded",'),
				"utf8",
			);
			await writeFile(
				serverPath,
				(await readFile(serverPath, "utf8")).replace("Package Module skills/guide", "Reloaded skills/guide"),
				"utf8",
			);

			const second = await HcpClientloadsinglepackage(packageDir);
			const secondProduct = (await second.components[0]!.HcpMagnet.build(context)) as {
				toResource(): HcpMagnetResource;
			};
			expect(secondProduct.toResource().name).toBe("guide-reloaded");
			expect(new second.components[0]!.HcpServer!().description).toBe("Reloaded skills/guide");
		} finally {
			await rm(packagesRoot, { recursive: true, force: true });
		}
	});

	it("maps v2 capability declarations onto canonical hook, context, and runtime slots", async () => {
		const packagesRoot = await mkdtemp(join(tmpdir(), "pkg-v2-capability-slots-"));
		try {
			const packageDir = join(packagesRoot, "CapabilityDomain");
			const declarations = [
				{ kind: "hook", name: "hooks", slot: "hook", module: "hooks" },
				{ kind: "context", name: "workspace", slot: "context", module: "context" },
				{ kind: "runtime", name: "process", slot: "runtime:process", module: "runtime" },
			] as const;
			for (const declaration of declarations) {
				const sourceDir = join(packageDir, declaration.module, "CapabilityDomain");
				await mkdir(sourceDir, { recursive: true });
				await writeFile(
					join(sourceDir, "HcpMagnet.ts"),
					`export class HcpMagnet {
	static readonly module = ${JSON.stringify(declaration.module)};
	static readonly kind = ${JSON.stringify(declaration.kind)};
	static readonly source = "CapabilityDomain";
	static async build(context: unknown) { await Promise.resolve(); return new HcpMagnet(context); }
	readonly kind = ${JSON.stringify(`capability:${declaration.kind}`)};
	readonly source = "CapabilityDomain";
	constructor(private readonly context: unknown) {}
	toCapability() { return { kind: ${JSON.stringify(declaration.kind)}, name: ${JSON.stringify(declaration.name)}, source: this.source, instance: this.context }; }
}
`,
				);
				await writeFile(
					join(packageDir, declaration.module, "HcpServer.ts"),
					`export class HcpServer { readonly moduleName = ${JSON.stringify(declaration.module)}; }
`,
				);
			}
			await writeFile(
				join(packageDir, "package.toml"),
				`schema_version = "magenta.package.v2"
id = "CapabilityDomain"
name = "CapabilityDomain"
version = "1.0.0"
source = "CapabilityDomain"

${declarations
	.map(
		(declaration) => `[[components]]
kind = ${JSON.stringify(declaration.kind)}
name = ${JSON.stringify(declaration.name)}
source = "CapabilityDomain"
slot = ${JSON.stringify(declaration.slot)}
path = ${JSON.stringify(`${declaration.module}/CapabilityDomain`)}
`,
	)
	.join("\n")}`,
			);

			const overlay = await HcpClientloadsinglepackage(packageDir);
			expect(overlay.diagnostics.filter((diagnostic) => diagnostic.type === "error")).toEqual([]);
			expect(
				overlay.components.map((component) => ({
					kind: component.kind,
					module: component.module,
					product: component.product,
					slot: component.slot,
				})),
			).toEqual([
				{ kind: "hook", module: "hooks", product: "capability", slot: "hook" },
				{ kind: "context", module: "context", product: "capability", slot: "context" },
				{ kind: "runtime", module: "runtime", product: "capability", slot: "runtime:process" },
			]);
		} finally {
			await rm(packagesRoot, { recursive: true, force: true });
		}
	});

	it("diagnoses unknown v2 kinds and duplicate same-source declarations", async () => {
		const packagesRoot = await mkdtemp(join(tmpdir(), "pkg-v2-declaration-errors-"));
		try {
			const packageDir = await writeFixturePackage(packagesRoot, {
				id: "DeclarationDomain",
				source: "DeclarationDomain",
				components: [{ kind: "skill", item: "guide", name: "guide", source: "DeclarationDomain" }],
			});
			const manifestPath = join(packageDir, "package.toml");
			await writeFile(
				manifestPath,
				`${await readFile(manifestPath, "utf-8")}
[[components]]
kind = "skill"
name = "guide"
source = "DeclarationDomain"
path = "skills/guide/DeclarationDomain"

[[components]]
kind = "mystery"
name = "unknown"
source = "DeclarationDomain"
path = "skills/guide/DeclarationDomain"
`,
			);

			const overlay = await HcpClientloadsinglepackage(packageDir);
			expect(overlay.components.map((component) => component.key)).toEqual(["skill:guide"]);
			expect(overlay.diagnostics).toContainEqual(
				expect.objectContaining({
					code: "package_component_invalid",
					message: expect.stringContaining("declared more than once"),
				}),
			);
			expect(overlay.diagnostics).toContainEqual(
				expect.objectContaining({
					code: "package_component_invalid",
					message: expect.stringContaining('unsupported package component kind "mystery"'),
				}),
			);
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

			const full = await HcpClientloadpackageoverlay({ packagesRoot, selections: ["GammaDomain"] });
			expect(full.components.map((c) => c.name).sort()).toEqual(["GammaDomain", "sc", "shared", "sp"]);

			const scOnly = await HcpClientloadpackageoverlay({ packagesRoot, selections: ["GammaDomain:single-cell"] });
			expect(scOnly.components.map((c) => c.name).sort()).toEqual(["GammaDomain", "sc", "shared"]);
			expect(scOnly.components.map((c) => c.name)).not.toContain("sp");
		} finally {
			await rm(packagesRoot, { recursive: true, force: true });
		}
	});

	it("honors default profiles, wildcard selection, inheritance, and invalid profile diagnostics", async () => {
		const packagesRoot = await mkdtemp(join(tmpdir(), "pkg-v2-profile-contract-"));
		try {
			const packageDir = await writeFixturePackage(packagesRoot, {
				id: "ProfileDomain",
				source: "ProfileDomain",
				defaultProfiles: ["child"],
				profiles: [{ name: "base" }, { name: "child", extends: ["base"] }, { name: "other" }],
				components: [
					{ kind: "skill", item: "shared", name: "shared", source: "ProfileDomain" },
					{ kind: "skill", item: "base", name: "base", source: "ProfileDomain", profiles: ["base"] },
					{ kind: "skill", item: "child", name: "child", source: "ProfileDomain", profiles: ["child"] },
					{ kind: "skill", item: "other", name: "other", source: "ProfileDomain", profiles: ["other"] },
				],
			});

			const defaults = await HcpClientloadsinglepackage(packageDir);
			expect(defaults.components.map((component) => component.name).sort()).toEqual(["base", "child", "shared"]);
			const wildcard = await HcpClientloadsinglepackage(packageDir, ["*"]);
			expect(wildcard.components.map((component) => component.name).sort()).toEqual([
				"base",
				"child",
				"other",
				"shared",
			]);
			const missing = await HcpClientloadsinglepackage(packageDir, ["missing"]);
			expect(missing.diagnostics.some((diagnostic) => diagnostic.code === "package_profile_missing")).toBe(true);

			const manifestPath = join(packageDir, "package.toml");
			const manifest = await readFile(manifestPath, "utf-8");
			await writeFile(
				manifestPath,
				manifest
					.replace('extends = ["base"]', 'extends = ["base"]\n')
					.replace(
						'[[profiles]]\nname = "base"\nextends = []',
						'[[profiles]]\nname = "base"\nextends = ["child"]',
					),
				"utf-8",
			);
			const cyclic = await HcpClientloadsinglepackage(packageDir, ["child"]);
			expect(cyclic.diagnostics.some((diagnostic) => diagnostic.code === "package_profile_cycle")).toBe(true);
			expect(cyclic.components.map((component) => component.name)).toEqual(["shared"]);
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
			const overlay = await HcpClientloadpackageoverlay({ packagesRoot, selections: ["DeltaDomain"] });
			const packageTool = overlay.components.find((component) => component.product === "tool");
			expect(packageTool).toMatchObject({ module: "tools/echo", source: "DeltaDomain" });
			expect((packageTool?.HcpMagnet as unknown as { name?: string }).name).toBe("HcpMagnet");
			expect(
				typeof (packageTool?.HcpMagnet as unknown as { prototype?: { toTool?: unknown } }).prototype?.toTool,
			).toBe("function");
			expect(
				(packageTool?.HcpMagnet as unknown as { prototype?: { toCapability?: unknown; toResource?: unknown } })
					.prototype,
			).not.toMatchObject({ toCapability: expect.any(Function), toResource: expect.any(Function) });
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
			const overlay = await HcpClientloadpackageoverlay({ packagesRoot, selections: ["EpsilonDomain"] });
			assembly = await HcpClientbuildpackagesessionfortest({ repoRoot: packagesRoot, overlay });

			expect(assembly.diagnostics.filter((d) => "type" in d && d.type === "error")).toEqual([]);
			expect(assembly.packageResourceAddresses).toContain("skill:guide");
			expect(assembly.packageResourceAddresses).toContain("brand:EpsilonDomain");
			const skill = assembly.hcp.resolveInstance<HcpMagnetResource>("skill:guide");
			expect(skill?.metadata).toMatchObject({
				origin: "package",
				packageId: "EpsilonDomain",
				includeInContext: true,
			});
			const systemPrompt = assembly.hcp.resolveInstance<HcpMagnetResource>("system-prompt:system-prompt");
			expect(systemPrompt?.contentPath).toContain("system-prompt/EpsilonDomain/SYSTEM.md");
			expect(systemPrompt?.metadata).toMatchObject({ origin: "package", packageId: "EpsilonDomain" });
		} finally {
			await assembly?.hcp.dispose();
			await rm(packagesRoot, { recursive: true, force: true });
		}
	});

	it("requires each package Magnet to have one matching product method and a real owning HcpServer", async () => {
		const packagesRoot = await mkdtemp(join(tmpdir(), "pkg-v2-role-shape-"));
		try {
			const missingServerDir = await writeFixturePackage(packagesRoot, {
				id: "MissingServerDomain",
				source: "MissingServerDomain",
				components: [{ kind: "skill", item: "guide", name: "guide", source: "MissingServerDomain" }],
			});
			await rm(join(missingServerDir, "skills", "guide", "HcpServer.ts"));
			const missingServer = await HcpClientloadsinglepackage(missingServerDir);
			expect(missingServer.components).toEqual([]);
			expect(missingServer.diagnostics.some((diagnostic) => diagnostic.code === "server_not_found")).toBe(true);

			// Use a fresh package path so the first import observes the intentionally invalid class.
			const invalidProductDir = await writeFixturePackage(packagesRoot, {
				id: "InvalidProductDomain",
				source: "InvalidProductDomain",
				components: [{ kind: "skill", item: "guide", name: "guide", source: "InvalidProductDomain" }],
			});
			const magnetPath = join(invalidProductDir, "skills", "guide", "InvalidProductDomain", "HcpMagnet.ts");
			const magnet = await readFile(magnetPath, "utf-8");
			await writeFile(
				magnetPath,
				magnet.replace("\ttoResource() {", "\ttoTool() { return {}; }\n\n\ttoResource() {"),
			);
			const invalidProduct = await HcpClientloadsinglepackage(invalidProductDir);
			expect(invalidProduct.components).toEqual([]);
			expect(
				invalidProduct.diagnostics.some((diagnostic) => diagnostic.code === "magnet_product_shape_invalid"),
			).toBe(true);
		} finally {
			await rm(packagesRoot, { recursive: true, force: true });
		}
	});

	it("rejects absolute, traversal, symlink escape, and module-identity drift before dynamic import", async () => {
		const packagesRoot = await mkdtemp(join(tmpdir(), "pkg-v2-containment-"));
		try {
			const packageDir = join(packagesRoot, "ContainedDomain");
			const outside = join(packagesRoot, "outside");
			await mkdir(packageDir, { recursive: true });
			await mkdir(outside, { recursive: true });
			await writeFile(join(outside, "HcpMagnet.ts"), "throw new Error('must not import');\n");
			await symlink(outside, join(packageDir, "escaped-infra"));
			await writeFile(
				join(packageDir, "package.toml"),
				`schema_version = "magenta.package.v2"
id = "ContainedDomain"
name = "ContainedDomain"
version = "1.0.0"
source = "ContainedDomain"

[[components]]
kind = "skill"
name = "traversal"
source = "ContainedDomain"
path = "../outside"

[[components]]
kind = "env"
name = "windows-absolute"
source = "ContainedDomain"
path = "C:\\\\Windows\\\\system.ini"

[[components]]
kind = "env-lock"
name = "symlink-escape"
source = "ContainedDomain"
path = "escaped-infra"
`,
				"utf-8",
			);
			const escaped = await HcpClientloadsinglepackage(packageDir);
			expect(escaped.components).toEqual([]);
			expect(escaped.infrastructure).toEqual([]);
			expect(
				escaped.diagnostics.filter((diagnostic) => diagnostic.code === "package_component_path_invalid"),
			).toHaveLength(3);

			const driftRoot = await writeFixturePackage(packagesRoot, {
				id: "DriftDomain",
				source: "DriftDomain",
				components: [{ kind: "skill", item: "guide", name: "guide", source: "DriftDomain" }],
			});
			const magnetPath = join(driftRoot, "skills", "guide", "DriftDomain", "HcpMagnet.ts");
			const magnet = await readFile(magnetPath, "utf-8");
			await writeFile(magnetPath, magnet.replace('module = "skills/guide"', 'module = "../outside"'));
			const drift = await HcpClientloadsinglepackage(driftRoot);
			expect(drift.components).toEqual([]);
			expect(drift.diagnostics.some((diagnostic) => diagnostic.code === "magnet_module_mismatch")).toBe(true);
		} finally {
			await rm(packagesRoot, { recursive: true, force: true });
		}
	});

	it("reports an error when a declared component has no HcpMagnet.ts", async () => {
		const packagesRoot = await mkdtemp(join(tmpdir(), "pkg-v2-missing-"));
		try {
			const pkgDir = join(packagesRoot, "BrokenDomain");
			await mkdir(join(pkgDir, "skills", "ghost", "BrokenDomain"), { recursive: true });
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
			const overlay = await HcpClientloadsinglepackage(pkgDir);
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
			const overlay = await HcpClientloadsinglepackage(pkgDir);
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
			const overlay = await HcpClientloadpackageoverlay({
				packagesRoot,
				selections: ["FirstDomain", "SecondDomain"],
			});
			expect(overlay.components.map((c) => c.name).sort()).toEqual(["guide", "helper"]);
		} finally {
			await rm(packagesRoot, { recursive: true, force: true });
		}
	});

	it("keeps each package root and infrastructure declaration while assembling tools from multiple roots", async () => {
		const packagesRoot = await mkdtemp(join(tmpdir(), "pkg-v2-multi-root-"));
		let assembly: HcpClientpackagetestbuildresult | undefined;
		try {
			await writeFixturePackage(packagesRoot, {
				id: "FirstTools",
				source: "FirstTools",
				components: [
					{
						kind: "tool",
						item: "first",
						name: "first_tool",
						source: "FirstTools",
						descriptorToml: PROCESS_ECHO_TOML.replaceAll("echo_tool", "first_tool"),
					},
				],
			});
			await writeFixturePackage(packagesRoot, {
				id: "SecondTools",
				source: "SecondTools",
				components: [
					{
						kind: "tool",
						item: "second",
						name: "second_tool",
						source: "SecondTools",
						descriptorToml: PROCESS_ECHO_TOML.replaceAll("echo_tool", "second_tool"),
					},
				],
				infrastructure: [
					{
						kind: "python-runtime",
						name: "python_fixture",
						source: "SecondTools",
						path: "tools/second/python/python_fixture/__init__.py",
					},
					{ kind: "env", name: "pixi", source: "SecondTools", path: "tools/second/pixi.toml" },
				],
			});
			const overlay = await HcpClientloadpackageoverlay({ packagesRoot, selections: ["FirstTools", "SecondTools"] });
			expect(new Set(overlay.components.map((component) => component.packageRoot))).toEqual(
				new Set([
					await realpath(join(packagesRoot, "FirstTools")),
					await realpath(join(packagesRoot, "SecondTools")),
				]),
			);
			expect(overlay.infrastructure.map((component) => `${component.kind}:${component.name}`).sort()).toEqual([
				"env:pixi",
				"python-runtime:python_fixture",
			]);
			const input = await HcpClientpackageinputfromoverlay(overlay);
			const second = input.components.find((component) => component.name === "second_tool");
			const settings = second?.settings as { HcpClientbuildtools?: unknown } | undefined;
			expect(typeof settings?.HcpClientbuildtools).toBe("function");
			assembly = await HcpClientbuildpackagesessionfortest({ repoRoot: packagesRoot, overlay });
			expect(assembly.packageToolAddresses.sort()).toEqual(["tool:first_tool", "tool:second_tool"]);
		} finally {
			await assembly?.hcp.dispose();
			await rm(packagesRoot, { recursive: true, force: true });
		}
	});

	it("isolates tool infrastructure by package root when local and remote packages share an id", async () => {
		const firstPackagesRoot = await mkdtemp(join(tmpdir(), "pkg-v2-same-id-first-"));
		const secondPackagesRoot = await mkdtemp(join(tmpdir(), "pkg-v2-same-id-second-"));
		try {
			const pythonToolDescriptor = (name: string) => `kind = "tool"
name = "${name}"
description = "${name}"
runtime = "python_fixture"
python_bin = "python"
module = "fixture"

[parameters]
type = "object"
additionalProperties = true
`;
			const firstPackageRoot = await writeFixturePackage(firstPackagesRoot, {
				id: "SharedTools",
				source: "FirstSource",
				components: [
					{
						kind: "tool",
						item: "first",
						name: "first_tool",
						source: "FirstSource",
						descriptorToml: pythonToolDescriptor("first_tool"),
					},
				],
				infrastructure: [
					{
						kind: "python-runtime",
						name: "python_fixture",
						source: "FirstSource",
						path: "python/first/python_fixture/__init__.py",
					},
				],
			});
			const secondPackageRoot = await writeFixturePackage(secondPackagesRoot, {
				id: "SharedTools",
				source: "SecondSource",
				components: [
					{
						kind: "tool",
						item: "second",
						name: "second_tool",
						source: "SecondSource",
						descriptorToml: pythonToolDescriptor("second_tool"),
					},
				],
				infrastructure: [
					{
						kind: "python-runtime",
						name: "python_fixture",
						source: "SecondSource",
						path: "python/second/python_fixture/__init__.py",
					},
				],
			});

			const overlay = await HcpClientloadpackageoverlay({
				packagesRoot: firstPackagesRoot,
				selections: [
					{ packageId: "SharedTools", packageRoot: firstPackageRoot },
					{ packageId: "SharedTools", packageRoot: secondPackageRoot },
				],
			});
			const input = await HcpClientpackageinputfromoverlay(overlay);
			const invocations = new Map<string, ProcessExecInput>();
			const buildContext = {
				repoRoot: firstPackagesRoot,
				resolveCapability: (name: string) => {
					if (name === "runtime:process") {
						return {
							exec: async (invocation: ProcessExecInput) => {
								invocations.set(invocation.tool?.name ?? "unknown", invocation);
								return {
									stdout: "ok",
									stderr: "",
									status: 0,
									truncated: { stdout: false, stderr: false },
									policy: {
										workspace_root: firstPackagesRoot,
										process_cwd: firstPackagesRoot,
										fs_read: [],
										fs_write: [],
										network: "deny",
										network_allowlist: [],
										max_wall_seconds: 0,
										max_memory_mb: 0,
										backend: "none",
										resolved_backend: "none" as const,
										os_enforced: false as const,
										backend_reason: "test",
									},
								};
							},
						};
					}
					if (name === "sandbox") {
						return {
							resolve: () => ({
								selection: {
									profile: "restricted",
									reason: {
										read_only: true,
										destructive: false,
										trusted: false,
										network_read: false,
										workspace_write: false,
									},
								},
								profile: {
									kind: "sandbox",
									name: "restricted",
									description: "test",
									fs_read: [],
									fs_write: [],
									network: "deny",
									network_allowlist: [],
									max_memory_mb: 0,
									max_wall_seconds: 0,
									env_allowlist: ["PATH", "PYTHONPATH"],
									backend: "none",
								},
							}),
						};
					}
					return undefined;
				},
			} as unknown as HcpMagnetBuildContext;

			for (const component of input.components.filter((candidate) => candidate.product === "tool")) {
				const build = (
					component.settings as {
						HcpClientbuildtools: (
							descriptor: { kind: "tool"; name: string; source: string; descriptorPath: string },
							context: HcpMagnetBuildContext,
						) => Promise<Array<{ toTool(): AgentTool }>>;
					}
				).HcpClientbuildtools;
				const item = component.name === "first_tool" ? "first" : "second";
				const products = await build(
					{
						kind: "tool",
						name: component.name,
						source: component.source,
						descriptorPath: join(component.descriptorPath, `${item}.toml`),
					},
					buildContext,
				);
				expect(products).toHaveLength(1);
				await products[0]!.toTool().execute("call", {});
			}

			expect(invocations.get("first_tool")?.env_overrides?.PYTHONPATH).toContain(
				join(await realpath(firstPackageRoot), "python", "first", "python_fixture"),
			);
			expect(invocations.get("second_tool")?.env_overrides?.PYTHONPATH).toContain(
				join(await realpath(secondPackageRoot), "python", "second", "python_fixture"),
			);
		} finally {
			await Promise.all([
				rm(firstPackagesRoot, { recursive: true, force: true }),
				rm(secondPackagesRoot, { recursive: true, force: true }),
			]);
		}
	});
});
