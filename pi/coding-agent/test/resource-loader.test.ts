import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { HcpMagnetResource } from "@magenta/harness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { DefaultResourceLoader, type DefaultResourceLoaderOptions } from "../src/core/resource-loader.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { formatSkillsForPrompt, type Skill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";

function writeHarnessPackageFixture(repoRoot: string, packagesRoot = join(repoRoot, "packages")): void {
	const packageDir = join(packagesRoot, "TestDomain");
	const harnessDir = join(packageDir, "harness");
	const skillDir = join(packageDir, "skills", "test-domain");
	const hiddenSkillDir = join(packageDir, "skills", "hidden-domain");
	const promptDir = join(packageDir, "prompts");
	const themeDir = join(packageDir, "themes");
	const brandDir = join(packageDir, "brand");
	const systemPromptDir = join(packageDir, "system-prompt");
	const toolDir = join(harnessDir, "tools");
	mkdirSync(skillDir, { recursive: true });
	mkdirSync(hiddenSkillDir, { recursive: true });
	mkdirSync(promptDir, { recursive: true });
	mkdirSync(themeDir, { recursive: true });
	mkdirSync(brandDir, { recursive: true });
	mkdirSync(systemPromptDir, { recursive: true });
	mkdirSync(toolDir, { recursive: true });
	writeFileSync(
		join(packageDir, "package.toml"),
		`schema_version = "magenta.package.v1"
id = "TestDomain"
name = "Test Domain"
default_profiles = ["general"]

[[profiles]]
name = "general"
harness = "harness/harness.toml"
`,
	);
	writeFileSync(
		join(harnessDir, "harness.toml"),
		`[[components]]
kind = "skill"
name = "test-domain"
path = "../skills/test-domain"

[[components]]
kind = "skill"
name = "hidden-domain"
path = "../skills/hidden-domain"
include_in_context = false

[[components]]
kind = "prompt-template"
name = "package-prompt"
path = "../prompts/package-prompt.md"

[[components]]
kind = "theme"
name = "package-theme"
path = "../themes/package-theme.json"

[[components]]
kind = "brand"
name = "package-brand"
path = "../brand/BRAND.md"

[[components]]
kind = "tool"
name = "test_package_tool"
path = "tools/test-package-tool.toml"

[[components]]
kind = "system-prompt"
name = "system-prompt"
path = "../system-prompt/system-prompt.toml"

[[components]]
kind = "append-system-prompt"
name = "test-domain-append"
path = "../system-prompt/append-system-prompt.toml"
`,
	);
	writeFileSync(
		join(skillDir, "SKILL.md"),
		`---
name: test-domain
description: Test package skill.
---

# Test Domain
`,
	);
	writeFileSync(
		join(hiddenSkillDir, "SKILL.md"),
		`---
name: hidden-domain
description: Explicit-only package skill.
---

# Hidden Domain
`,
	);
	writeFileSync(
		join(promptDir, "package-prompt.md"),
		`---
description: Package prompt template.
---
Package prompt content.
`,
	);
	const packageTheme = JSON.parse(
		readFileSync(join(process.cwd(), "src", "modes", "interactive", "theme", "dark.json"), "utf-8"),
	);
	packageTheme.name = "package-theme";
	writeFileSync(join(themeDir, "package-theme.json"), JSON.stringify(packageTheme, null, 2));
	writeFileSync(join(brandDir, "BRAND.md"), "# Package Brand");
	writeFileSync(
		join(systemPromptDir, "system-prompt.toml"),
		`kind = "system-prompt"
name = "system-prompt"
description = "Test package system prompt."
source = "TestDomain"
content_path = "SYSTEM.md"
`,
	);
	writeFileSync(
		join(systemPromptDir, "append-system-prompt.toml"),
		`kind = "append-system-prompt"
name = "test-domain-append"
description = "Test package append prompt."
source = "TestDomain"
content_path = "APPEND_SYSTEM.md"
`,
	);
	writeFileSync(join(systemPromptDir, "SYSTEM.md"), "Package system prompt.");
	writeFileSync(join(systemPromptDir, "APPEND_SYSTEM.md"), "Package append prompt.");
	writeFileSync(
		join(toolDir, "test-package-tool.toml"),
		`kind = "tool"
name = "test_package_tool"
description = "Echo a package tool input."
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
}

function writePromptOrderPackage(
	repoRoot: string,
	id: string,
	systemName: string,
	systemContent: string,
	appendName: string,
	appendContent: string,
): void {
	const packageDir = join(repoRoot, "packages", id);
	const promptDir = join(packageDir, "system-prompt");
	mkdirSync(promptDir, { recursive: true });
	writeFileSync(
		join(packageDir, "package.toml"),
		`schema_version = "magenta.package.v1"
id = "${id}"
name = "${id}"

[[components]]
kind = "system-prompt"
name = "${systemName}"
path = "system-prompt/system.toml"

[[components]]
kind = "append-system-prompt"
name = "${appendName}"
path = "system-prompt/append.toml"
`,
	);
	writeFileSync(
		join(promptDir, "system.toml"),
		`kind = "system-prompt"
name = "${systemName}"
source = "${id}"
content_path = "SYSTEM.md"
`,
	);
	writeFileSync(
		join(promptDir, "append.toml"),
		`kind = "append-system-prompt"
name = "${appendName}"
source = "${id}"
content_path = "APPEND.md"
`,
	);
	writeFileSync(join(promptDir, "SYSTEM.md"), systemContent);
	writeFileSync(join(promptDir, "APPEND.md"), appendContent);
}

function writeMultiProfilePackageFixture(repoRoot: string): void {
	const packageDir = join(repoRoot, "packages", "MultiDomain");
	const generalDir = join(packageDir, "harness", "general");
	const extraDir = join(packageDir, "harness", "extra");
	mkdirSync(generalDir, { recursive: true });
	mkdirSync(extraDir, { recursive: true });
	writeFileSync(
		join(packageDir, "package.toml"),
		`schema_version = "magenta.package.v1"
id = "MultiDomain"
name = "Multi Domain"
default_profiles = []

[[profiles]]
name = "general"
harness = "harness/general/harness.toml"

[[profiles]]
name = "extra"
harness = "harness/extra/harness.toml"
`,
	);
	writeFileSync(
		join(generalDir, "harness.toml"),
		`[[components]]
kind = "tool"
name = "general_tool"
path = "general-tool.toml"
`,
	);
	writeFileSync(
		join(extraDir, "harness.toml"),
		`[[components]]
kind = "tool"
name = "extra_tool"
path = "extra-tool.toml"
`,
	);
	for (const [dir, toolName] of [
		[generalDir, "general_tool"],
		[extraDir, "extra_tool"],
	] as const) {
		writeFileSync(
			join(dir, `${toolName === "general_tool" ? "general" : "extra"}-tool.toml`),
			`kind = "tool"
name = "${toolName}"
description = "Echo ${toolName} input."
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
	}
}

function writeLateToolDescriptorDiagnosticPackage(repoRoot: string): void {
	const packageDir = join(repoRoot, "packages", "LateDiagnosticDomain");
	const moduleDir = join(packageDir, "tools", "late-tool");
	const sourceDir = join(moduleDir, "LateDiagnosticDomain");
	const outsideDescriptor = join(repoRoot, "outside-package-tool.toml");
	mkdirSync(sourceDir, { recursive: true });
	writeFileSync(
		join(packageDir, "package.toml"),
		`schema_version = "magenta.package.v2"
id = "LateDiagnosticDomain"
name = "Late Diagnostic Domain"
version = "1.0.0"
source = "LateDiagnosticDomain"

[[components]]
kind = "tool"
name = "late_tool"
source = "LateDiagnosticDomain"
path = "tools/late-tool/LateDiagnosticDomain"
`,
	);
	writeFileSync(
		join(moduleDir, "HcpServer.ts"),
		`export class HcpServer { readonly moduleName = "tools/late-tool"; }
`,
	);
	writeFileSync(
		join(sourceDir, "HcpMagnet.ts"),
		`export class HcpMagnet {
	static readonly module = "tools/late-tool";
	static readonly kind = "tool";
	static readonly source = "LateDiagnosticDomain";
	static async build(context: any) {
		const products = await context.settings.HcpClientbuildtools(
			{
				kind: "tool",
				name: "late_tool",
				source: "LateDiagnosticDomain",
				descriptorPath: ${JSON.stringify(outsideDescriptor)},
			},
			context,
		);
		const magnets = products.map((product: any) => new HcpMagnet(product));
		return magnets.length === 0 ? undefined : magnets.length === 1 ? magnets[0] : magnets;
	}
	readonly kind: string;
	readonly source = "LateDiagnosticDomain";
	constructor(private readonly product: any) { this.kind = product.kind; }
	toTool() { return this.product.toTool(); }
	async dispose() { await this.product.close?.(); }
}
`,
	);
	writeFileSync(
		outsideDescriptor,
		`kind = "tool"
name = "late_tool"
description = "Must be rejected before host product construction."
runtime = "process"
command = "node"
`,
	);
}

describe("DefaultResourceLoader", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `rl-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createLoader(options: Partial<DefaultResourceLoaderOptions> = {}): DefaultResourceLoader {
		return new DefaultResourceLoader({
			cwd,
			agentDir,
			includeBundledResources: false,
			...options,
		});
	}

	describe("reload", () => {
		it("should initialize with empty results before reload", () => {
			const loader = createLoader();

			expect(loader.getExtensions().extensions).toEqual([]);
			expect(loader.getSkills().skills).toEqual([]);
			expect(loader.getPrompts().prompts).toEqual([]);
			expect(loader.getThemes().themes).toEqual([]);
		});

		it("loads bundled LazyPI resources by default", async () => {
			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const extensionsResult = loader.getExtensions();
			const commandNames = new Set(
				extensionsResult.extensions.flatMap((extension) => [...extension.commands.keys()]),
			);
			const toolNames = new Set(
				extensionsResult.extensions.flatMap((extension) => [...extension.tools.keys()].map((name) => name)),
			);
			const skills = loader.getSkills().skills;
			const skillNames = new Set(skills.map((skill) => skill.name));

			expect(commandNames.size).toBe(0);
			expect(commandNames.has("side")).toBe(false);
			expect(commandNames.has("btw")).toBe(false);
			expect(commandNames.has("s")).toBe(false);
			expect(commandNames.has("events")).toBe(false);
			expect(toolNames.size).toBe(0);
			expect(toolNames.has("bg_shell")).toBe(false);
			expect(toolNames.has("sub_agent")).toBe(false);
			for (const name of ["paper-analysis", "pptx", "research-orchestration", "self-evo"]) {
				expect(skillNames.has(name)).toBe(true);
			}
			for (const skill of skills.filter((candidate) =>
				["paper-analysis", "pptx", "research-orchestration", "self-evo"].includes(candidate.name),
			)) {
				expect(skill.sourceInfo?.source).toBe("harness");
				expect(skill.sourceInfo?.baseDir).toContain("skills");
			}
			expect(loader.getAppendSystemPrompt().join("\n")).toContain("Background Work");

			for (const extension of extensionsResult.extensions) {
				if (extension.sourceInfo?.source === "bundled") {
					expect(extension.sourceInfo.baseDir).toContain("extensions");
				}
			}
		});

		it("skips bundled resources when disabled", async () => {
			const loader = createLoader();
			await loader.reload();

			const commandNames = new Set(
				loader.getExtensions().extensions.flatMap((extension) => [...extension.commands.keys()]),
			);
			const skillNames = new Set(loader.getSkills().skills.map((skill) => skill.name));

			expect(commandNames.has("side")).toBe(false);
			expect(commandNames.has("events")).toBe(false);
			expect(skillNames.has("paper-analysis")).toBe(false);
			expect(loader.getAppendSystemPrompt().join("\n")).not.toContain("Background Work");
		});

		it("loads selected harness package skills and tools from repo-local packages", async () => {
			writeHarnessPackageFixture(cwd);

			const loader = createLoader({ harnessPackages: ["TestDomain"] });
			await loader.reload();

			const packageTools = loader.getPackageTools();
			const packageTool = packageTools.tools.find((tool) => tool.name === "test_package_tool");
			const packageSkill = loader.getSkills().skills.find((skill) => skill.name === "test-domain");
			const hiddenPackageSkill = loader.getSkills().skills.find((skill) => skill.name === "hidden-domain");
			const packagePrompt = loader.getPrompts().prompts.find((prompt) => prompt.name === "package-prompt");
			const packageTheme = loader.getThemes().themes.find((theme) => theme.name === "package-theme");

			expect(loader.getPackageOverlay()?.packages.map((pkg) => pkg.id)).toEqual(["TestDomain"]);
			expect(packageTools.diagnostics).toEqual([]);
			expect(packageTool?.description).toBe("Echo a package tool input.");
			expect(packageSkill?.sourceInfo).toMatchObject({
				source: "harness:TestDomain:general",
				origin: "package",
			});
			expect(hiddenPackageSkill?.disableModelInvocation).toBe(true);
			expect(loader.resolveSkill("hidden-domain")).toBe(hiddenPackageSkill);
			expect(formatSkillsForPrompt(loader.getSkills().skills)).toContain("<name>test-domain</name>");
			expect(formatSkillsForPrompt(loader.getSkills().skills)).not.toContain("<name>hidden-domain</name>");
			expect(packagePrompt?.sourceInfo).toMatchObject({
				source: "harness:TestDomain:general",
				origin: "package",
			});
			expect(packageTheme?.sourceInfo).toMatchObject({
				source: "harness:TestDomain:general",
				origin: "package",
			});
			expect(loader.HcpClientgetsession()?.resolve("skill:test-domain")).toBe(
				loader.HcpClientgetsession()?.resolveModule("skills"),
			);
			expect(loader.HcpClientgetsession()?.resolveInstance<HcpMagnetResource>("brand:package-brand")).toMatchObject({
				kind: "brand",
				name: "package-brand",
				source: "TestDomain",
			});
			expect(loader.getSystemPrompt()).toBe("Package system prompt.");
			expect(loader.getAppendSystemPrompt()).toContain("Package append prompt.");
		});

		it("rejects Tool descriptor containment errors and preserves the previous Client", async () => {
			writeLateToolDescriptorDiagnosticPackage(cwd);
			const loader = createLoader();
			await loader.reload();
			const previousHcp = loader.HcpClientgetsession();
			loader.HcpClientsetharnesspackageselectors(["LateDiagnosticDomain"]);

			await expect(loader.reload()).rejects.toThrow(/descriptor is invalid.*escapes the package root/i);

			expect(loader.getPackageTools().tools).toEqual([]);
			expect(loader.HcpClientgetsession()).toBe(previousHcp);
			expect(loader.getPackageOverlay()).toBeUndefined();
		});

		it("loads selected harness package resources from an explicit external root", async () => {
			const packagesRoot = join(tempDir, "external-packages");
			writeHarnessPackageFixture(cwd, packagesRoot);

			const loader = createLoader({
				harnessPackages: ["TestDomain"],
				harnessPackagesRoot: packagesRoot,
			});
			await loader.reload();

			expect(loader.HcpClientgetharnesspackagesroot()).toBe(packagesRoot);
			expect(loader.getPackageOverlay()?.packagesRoot).toBe(packagesRoot);
			expect(loader.getPackageTools().tools.map((tool) => tool.name)).toEqual(["test_package_tool"]);
			expect(loader.getSkills().skills.some((skill) => skill.name === "test-domain")).toBe(true);
		});

		it("applies ResourceLoader disable switches after Package Resources assemble through HCP", async () => {
			writeHarnessPackageFixture(cwd);
			const loader = createLoader({
				harnessPackages: ["TestDomain"],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			});
			await loader.reload();

			expect(loader.getSkills().skills).toEqual([]);
			expect(loader.getPrompts().prompts).toEqual([]);
			expect(loader.getThemes().themes).toEqual([]);
			expect(loader.HcpClientgetsession()?.resolve("skill:test-domain")).toBeDefined();
			expect(loader.HcpClientgetsession()?.resolve("prompt-template:package-prompt")).toBeDefined();
			expect(loader.HcpClientgetsession()?.resolve("theme:package-theme")).toBeDefined();
			expect(loader.HcpClientgetsession()?.resolve("brand:package-brand")).toBeDefined();
		});

		it("uses package system prompts unless an explicit system prompt is provided", async () => {
			writeHarnessPackageFixture(cwd);
			const piDir = join(cwd, CONFIG_DIR_NAME);
			mkdirSync(piDir, { recursive: true });
			writeFileSync(join(piDir, "SYSTEM.md"), "Project system prompt.");

			const packagePromptLoader = createLoader({ harnessPackages: ["TestDomain"] });
			await packagePromptLoader.reload();
			expect(packagePromptLoader.getSystemPrompt()).toBe("Package system prompt.");

			const explicitPromptLoader = createLoader({
				harnessPackages: ["TestDomain"],
				systemPrompt: "Explicit system prompt.",
			});
			await explicitPromptLoader.reload();
			expect(explicitPromptLoader.getSystemPrompt()).toBe("Explicit system prompt.");
		});

		it("preserves last-writer replace order and append order across selected Packages", async () => {
			writePromptOrderPackage(cwd, "OrderA", "primary", "System A", "append-a", "Append A");
			writePromptOrderPackage(cwd, "OrderB", "secondary", "System B", "append-b", "Append B");
			writePromptOrderPackage(cwd, "OrderC", "primary", "System C", "append-c", "Append C");

			const loader = createLoader({ harnessPackages: ["OrderA", "OrderB", "OrderC"] });
			await loader.reload();

			expect(loader.getSystemPrompt()).toBe("System C");
			expect(loader.getAppendSystemPrompt()).toEqual(["Append A", "Append B", "Append C"]);
			expect(loader.getPackageOverlay()?.components.map((component) => component.key)).toEqual([
				"append-system-prompt:append-a",
				"system-prompt:secondary",
				"append-system-prompt:append-b",
				"system-prompt:primary",
				"append-system-prompt:append-c",
			]);
		});

		it("reports a missing Package system-prompt file instead of injecting its path as content", async () => {
			writeHarnessPackageFixture(cwd);
			const contentPath = join(cwd, "packages", "TestDomain", "system-prompt", "SYSTEM.md");
			rmSync(contentPath);

			const loader = createLoader({ harnessPackages: ["TestDomain"] });
			await loader.reload();

			expect(loader.getSystemPrompt()).toBeUndefined();
			expect(loader.getPackageTools().diagnostics).toContainEqual(
				expect.objectContaining({
					type: "error",
					path: contentPath,
					message: expect.stringContaining("Failed to read"),
				}),
			);
		});

		it("can change selected harness packages before reload", async () => {
			writeHarnessPackageFixture(cwd);

			const loader = createLoader();
			await loader.reload();

			expect(loader.HcpClientgetharnesspackageselectors()).toEqual([]);
			expect(loader.getPackageOverlay()).toBeUndefined();
			expect(loader.getPackageTools().tools).toEqual([]);

			loader.HcpClientsetharnesspackageselectors(["TestDomain", "TestDomain", " "]);
			await loader.reload();

			expect(loader.HcpClientgetharnesspackageselectors()).toEqual(["TestDomain"]);
			expect(loader.getPackageOverlay()?.packages.map((pkg) => pkg.id)).toEqual(["TestDomain"]);
			expect(loader.getPackageTools().tools.map((tool) => tool.name)).toEqual(["test_package_tool"]);

			loader.HcpClientsetharnesspackageselectors([]);
			await loader.reload();

			expect(loader.getPackageOverlay()).toBeUndefined();
			expect(loader.getPackageTools().tools).toEqual([]);
			expect(loader.getSkills().skills.some((skill) => skill.name === "test-domain")).toBe(false);
		});

		it("rejects malformed GitHub selectors instead of treating them as local package ids", async () => {
			const selector = "github:owner/repo/PackageWithoutVersion";
			const loader = createLoader();
			await loader.reload();
			const previousHcp = loader.HcpClientgetsession();
			loader.HcpClientsetharnesspackageselectors([selector]);

			await expect(loader.reload()).rejects.toThrow(`Invalid GitHub package selector: ${selector}`);

			expect(loader.HcpClientgetharnesspackageselectors()).toEqual([selector]);
			expect(loader.getPackageOverlay()).toBeUndefined();
			expect(loader.HcpClientgetsession()).toBe(previousHcp);
		});

		it("exposes a session HCP that resolves the compaction capability with and without a package", async () => {
			writeHarnessPackageFixture(cwd);

			// No package selected: default capability sources still apply, so the
			// session HCP must resolve `capability:compaction` (INV-1: the loop
			// consumer resolves the impl through ONE HcpClient, not a static import).
			const loader = createLoader();
			await loader.reload();

			const hcpNoPkg = loader.HcpClientgetsession();
			expect(hcpNoPkg, "session HCP should exist even with no package").toBeDefined();
			expect(hcpNoPkg?.resolve("skill:paper-analysis")).toBe(hcpNoPkg?.resolveModule("skills/paper-analysis"));
			const providerNoPkg = hcpNoPkg?.resolveCapability<{
				compact: unknown;
				prepareCompaction: unknown;
			}>("compaction");
			expect(typeof providerNoPkg?.compact, "compaction.compact should be a function").toBe("function");
			expect(typeof providerNoPkg?.prepareCompaction).toBe("function");

			// With a package selected: the session HCP is rebuilt layering defaults on
			// the assembled overlay HCP; compaction (a default source, not overridden
			// by the fixture) must still resolve, and package tools coexist.
			loader.HcpClientsetharnesspackageselectors(["TestDomain"]);
			await loader.reload();

			const hcpPkg = loader.HcpClientgetsession();
			expect(hcpPkg, "session HCP should exist with a package selected").toBeDefined();
			const providerPkg = hcpPkg?.resolveCapability<{ compact: unknown }>("compaction");
			expect(typeof providerPkg?.compact, "compaction resolves alongside a selected package").toBe("function");
			// The package overlay and any unoccupied defaults share the same Client.
			expect(loader.getPackageTools().tools.map((tool) => tool.name)).toEqual(["test_package_tool"]);
		});

		it("keeps the previous Client and resources when a late reload step fails", async () => {
			writeHarnessPackageFixture(cwd);
			let failSkills = false;
			const loader = createLoader({
				harnessPackages: ["TestDomain"],
				skillsOverride: (base) => {
					if (failSkills) throw new Error("late skill failure");
					return base;
				},
			});
			await loader.reload();
			const previousHcp = loader.HcpClientgetsession();
			const previousSkills = loader.getSkills().skills;
			const previousOverlay = loader.getPackageOverlay();
			expect(previousHcp?.resolveCapability("compaction")).toBeDefined();
			expect(loader.getPackageTools().tools.map((tool) => tool.name)).toEqual(["test_package_tool"]);
			expect(previousSkills.some((skill) => skill.name === "test-domain")).toBe(true);
			expect(loader.getSystemPrompt()).toBe("Package system prompt.");

			loader.HcpClientsetharnesspackageselectors([]);
			failSkills = true;
			await expect(loader.reload()).rejects.toThrow("late skill failure");

			expect(loader.HcpClientgetsession()).toBe(previousHcp);
			expect(loader.getSkills().skills).toBe(previousSkills);
			expect(loader.getPackageOverlay()).toBe(previousOverlay);
			expect(loader.HcpClientgetharnesspackageselectors()).toEqual([]);
			expect(loader.getPackageTools().tools.map((tool) => tool.name)).toEqual(["test_package_tool"]);
			expect(loader.getSystemPrompt()).toBe("Package system prompt.");
			expect(previousHcp?.resolveCapability("compaction")).toBeDefined();
			await loader.dispose();
		});

		it("prepares a candidate Client before publication and rolls it back on failure", async () => {
			const loader = createLoader();
			await loader.reload();
			const previousHcp = loader.HcpClientgetsession();
			expect(previousHcp?.resolveCapability("compaction")).toBeDefined();
			const candidates: Array<NonNullable<typeof previousHcp>> = [];

			await expect(
				loader.reload({
					HcpClientprepare: (candidate) => {
						candidates.push(candidate);
						expect(candidate).not.toBe(previousHcp);
						expect(loader.HcpClientgetsession()).toBe(previousHcp);
						throw new Error("host tool preparation failed");
					},
				}),
			).rejects.toThrow("host tool preparation failed");

			expect(candidates).toHaveLength(1);
			expect(candidates[0]?.addresses()).toEqual([]);
			expect(loader.HcpClientgetsession()).toBe(previousHcp);
			expect(previousHcp?.resolveCapability("compaction")).toBeDefined();
			await loader.dispose();
		});

		it("disposes user MCP products when a late reload step rejects the candidate", async () => {
			let failSkills = false;
			const loader = createLoader({
				skillsOverride: (base) => {
					if (failSkills) throw new Error("reject MCP candidate");
					return base;
				},
			});
			await loader.reload();
			const previousHcp = loader.HcpClientgetsession();
			const serverPath = join(agentDir, "rollback-mcp.cjs");
			const lifecycleMarker = join(agentDir, "rollback-mcp-lifecycle.txt");
			writeFileSync(
				serverPath,
				`const fs = require("node:fs");
const readline = require("node:readline");
const lifecycleMarker = ${JSON.stringify(lifecycleMarker)};
fs.appendFileSync(lifecycleMarker, "spawn\\n");
const lines = readline.createInterface({ input: process.stdin });
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
process.on("SIGTERM", () => { fs.appendFileSync(lifecycleMarker, "close\\n"); process.exit(0); });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send(message.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} } });
  if (message.method === "tools/list") send(message.id, { tools: [
    { name: "rollback_one", inputSchema: { type: "object" } },
    { name: "rollback_two", inputSchema: { type: "object" } }
  ] });
});
`,
			);
			writeFileSync(
				join(agentDir, "mcp-servers.json"),
				JSON.stringify({
					servers: [{ name: "rollback", command: process.execPath, args: [serverPath], name_prefix: "candidate" }],
				}),
			);

			failSkills = true;
			await expect(loader.reload()).rejects.toThrow("reject MCP candidate");

			expect(loader.HcpClientgetsession()).toBe(previousHcp);
			expect(loader.getUserMcpTools().tools).toEqual([]);
			expect(previousHcp?.resolve("tool:candidate_rollback_one")).toBeUndefined();
			expect(previousHcp?.resolve("tool:candidate_rollback_two")).toBeUndefined();
			expect(readFileSync(lifecycleMarker, "utf8")).toBe("spawn\nclose\n");
			await loader.dispose();
		});

		it("keeps dynamic Package and user MCP management state accurate across reload", async () => {
			writeHarnessPackageFixture(cwd);
			const serverPath = join(agentDir, "live-management-mcp.cjs");
			const firstCloseMarker = join(agentDir, "live-management-one-closed.txt");
			const secondCloseMarker = join(agentDir, "live-management-two-closed.txt");
			const firstReadyMarker = join(agentDir, "live-management-one-ready.txt");
			const secondReadyMarker = join(agentDir, "live-management-two-ready.txt");
			const configPath = join(agentDir, "mcp-servers.json");
			writeFileSync(
				serverPath,
				`const fs = require("node:fs");
const readline = require("node:readline");
const remoteTool = process.argv[2];
const closeMarker = process.argv[3];
const readyMarker = process.argv[4];
const lines = readline.createInterface({ input: process.stdin });
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
process.on("SIGTERM", () => { fs.writeFileSync(closeMarker, "closed"); process.exit(0); });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send(message.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} } });
  if (message.method === "tools/list") {
    fs.writeFileSync(readyMarker, "ready");
    send(message.id, { tools: [{ name: remoteTool, description: remoteTool, inputSchema: { type: "object" } }] });
  }
  if (message.method === "tools/call") send(message.id, { content: [{ type: "text", text: remoteTool + "-ok" }] });
});
`,
			);
			const writeMcpConfig = (remoteTool: string, closeMarker: string, readyMarker: string) => {
				writeFileSync(
					configPath,
					JSON.stringify({
						servers: [
							{
								name: "live",
								command: process.execPath,
								args: [serverPath, remoteTool, closeMarker, readyMarker],
								name_prefix: "live",
							},
						],
					}),
				);
			};

			let assertBeforePublication: (() => void) | undefined;
			const loader = createLoader({
				harnessPackages: ["TestDomain"],
				skillsOverride: (base) => {
					assertBeforePublication?.();
					return base;
				},
			});
			writeMcpConfig("one", firstCloseMarker, firstReadyMarker);
			await loader.reload();

			const firstHcp = loader.HcpClientgetsession()!;
			expect(readFileSync(firstReadyMarker, "utf8")).toBe("ready");
			const firstDescriptions = new Map(
				firstHcp.describeAll().map((description) => [description.target, description]),
			);
			expect(firstDescriptions.get("tool:test_package_tool")).toMatchObject({
				kind: "tool",
				metadata: { implementation: "process", source: "TestDomain" },
			});
			expect(firstDescriptions.get("tool:live_one")).toMatchObject({
				kind: "tool",
				metadata: {
					implementation: "mcp",
					source: "descriptor",
					provenance: { kind: "mcp", server: "live", remoteTool: "one" },
				},
			});
			expect(firstHcp.resolveModule("tools")?.describe().metadata?.slots).toEqual(
				expect.arrayContaining(["tool:test_package_tool", "tool:live_one"]),
			);
			await expect(loader.getUserMcpTools().tools[0]!.execute("live-one", {})).resolves.toMatchObject({
				content: [{ type: "text", text: "one-ok" }],
			});

			writeMcpConfig("two", secondCloseMarker, secondReadyMarker);
			let observedBeforePublication = false;
			assertBeforePublication = () => {
				observedBeforePublication = true;
				expect(readFileSync(secondReadyMarker, "utf8")).toBe("ready");
				expect(existsSync(firstCloseMarker)).toBe(false);
				expect(loader.HcpClientgetsession()).toBe(firstHcp);
				expect(loader.getUserMcpTools().tools.map((tool) => tool.name)).toEqual(["live_one"]);
				expect(firstHcp.resolveInstance("tool:live_one")).toBeDefined();
			};
			await loader.reload();
			assertBeforePublication = undefined;

			expect(observedBeforePublication).toBe(true);
			expect(readFileSync(firstCloseMarker, "utf8")).toBe("closed");
			const secondHcp = loader.HcpClientgetsession()!;
			expect(secondHcp).not.toBe(firstHcp);
			expect(secondHcp.resolve("tool:live_one")).toBeUndefined();
			expect(secondHcp.describeAll().map((description) => description.target)).toEqual(
				expect.arrayContaining(["tool:test_package_tool", "tool:live_two"]),
			);
			expect(secondHcp.resolveModule("tools")?.describe().metadata?.slots).toEqual(
				expect.arrayContaining(["tool:test_package_tool", "tool:live_two"]),
			);
			await expect(loader.getUserMcpTools().tools[0]!.execute("live-two", {})).resolves.toMatchObject({
				content: [{ type: "text", text: "two-ok" }],
			});

			writeFileSync(configPath, JSON.stringify({ servers: [] }));
			await loader.reload();

			expect(readFileSync(secondCloseMarker, "utf8")).toBe("closed");
			expect(loader.getUserMcpTools().tools).toEqual([]);
			expect(loader.HcpClientgetsession()?.resolve("tool:live_two")).toBeUndefined();
			expect(loader.HcpClientgetsession()?.resolve("tool:test_package_tool")).toBeDefined();
			await loader.dispose();
		});

		it("serializes concurrent reloads", async () => {
			const loader = createLoader();
			const order: string[] = [];
			let releaseFirst!: () => void;
			let markFirstEntered!: () => void;
			const firstGate = new Promise<void>((resolve) => {
				releaseFirst = resolve;
			});
			const firstEntered = new Promise<void>((resolve) => {
				markFirstEntered = resolve;
			});
			const first = loader.reload({
				resolveProjectTrust: async () => {
					order.push("first:start");
					markFirstEntered();
					await firstGate;
					order.push("first:end");
					return true;
				},
			});
			await firstEntered;
			const second = loader.reload({
				resolveProjectTrust: async () => {
					order.push("second");
					return true;
				},
			});
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(order).toEqual(["first:start"]);

			releaseFirst();
			await Promise.all([first, second]);
			expect(order).toEqual(["first:start", "first:end", "second"]);
			await loader.dispose();
		});

		it("loads multiple per-profile selectors for one package additively", async () => {
			writeMultiProfilePackageFixture(cwd);

			const loader = createLoader();
			await loader.reload();

			// Selecting only the extra profile loads just that profile's tool.
			loader.HcpClientsetharnesspackageselectors(["MultiDomain:extra"]);
			await loader.reload();
			expect(
				loader
					.getPackageTools()
					.tools.map((tool) => tool.name)
					.sort(),
			).toEqual(["extra_tool"]);

			// Adding a second per-profile selector for the same package is additive:
			// both profiles' tools load together (the menu's per-row toggles rely on this).
			loader.HcpClientsetharnesspackageselectors(["MultiDomain:extra", "MultiDomain:general"]);
			await loader.reload();
			expect(
				loader
					.getPackageTools()
					.tools.map((tool) => tool.name)
					.sort(),
			).toEqual(["extra_tool", "general_tool"]);
		});

		it("should discover skills from agentDir", async () => {
			const skillsDir = join(agentDir, "skills");
			mkdirSync(skillsDir, { recursive: true });
			writeFileSync(
				join(skillsDir, "test-skill.md"),
				`---
name: test-skill
description: A test skill
---
Skill content here.`,
			);

			const loader = createLoader();
			await loader.reload();

			const { skills } = loader.getSkills();
			expect(skills.some((s) => s.name === "test-skill")).toBe(true);
		});

		it("should ignore extra markdown files in auto-discovered skill dirs", async () => {
			const skillDir = join(agentDir, "skills", "pi-skills", "browser-tools");
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(
				join(skillDir, "SKILL.md"),
				`---
name: browser-tools
description: Browser tools
---
Skill content here.`,
			);
			writeFileSync(join(skillDir, "EFFICIENCY.md"), "No frontmatter here");

			const loader = createLoader();
			await loader.reload();

			const { skills, diagnostics } = loader.getSkills();
			expect(skills.some((s) => s.name === "browser-tools")).toBe(true);
			expect(diagnostics.some((d) => d.path?.endsWith("EFFICIENCY.md"))).toBe(false);
		});

		it("should discover prompts from agentDir", async () => {
			const promptsDir = join(agentDir, "prompts");
			mkdirSync(promptsDir, { recursive: true });
			writeFileSync(
				join(promptsDir, "test-prompt.md"),
				`---
description: A test prompt
---
Prompt content.`,
			);

			const loader = createLoader();
			await loader.reload();

			const { prompts } = loader.getPrompts();
			expect(prompts.some((p) => p.name === "test-prompt")).toBe(true);
		});

		it("should prefer project resources over user on name collisions", async () => {
			const userPromptsDir = join(agentDir, "prompts");
			const projectPromptsDir = join(cwd, CONFIG_DIR_NAME, "prompts");
			mkdirSync(userPromptsDir, { recursive: true });
			mkdirSync(projectPromptsDir, { recursive: true });
			const userPromptPath = join(userPromptsDir, "commit.md");
			const projectPromptPath = join(projectPromptsDir, "commit.md");
			writeFileSync(userPromptPath, "User prompt");
			writeFileSync(projectPromptPath, "Project prompt");

			const userSkillDir = join(agentDir, "skills", "collision-skill");
			const projectSkillDir = join(cwd, CONFIG_DIR_NAME, "skills", "collision-skill");
			mkdirSync(userSkillDir, { recursive: true });
			mkdirSync(projectSkillDir, { recursive: true });
			const userSkillPath = join(userSkillDir, "SKILL.md");
			const projectSkillPath = join(projectSkillDir, "SKILL.md");
			writeFileSync(
				userSkillPath,
				`---
name: collision-skill
description: user
---
User skill`,
			);
			writeFileSync(
				projectSkillPath,
				`---
name: collision-skill
description: project
---
Project skill`,
			);

			const baseTheme = JSON.parse(
				readFileSync(join(process.cwd(), "src", "modes", "interactive", "theme", "dark.json"), "utf-8"),
			) as { name: string; vars?: Record<string, string> };
			baseTheme.name = "collision-theme";
			const userThemePath = join(agentDir, "themes", "collision.json");
			const projectThemePath = join(cwd, CONFIG_DIR_NAME, "themes", "collision.json");
			mkdirSync(join(agentDir, "themes"), { recursive: true });
			mkdirSync(join(cwd, CONFIG_DIR_NAME, "themes"), { recursive: true });
			writeFileSync(userThemePath, JSON.stringify(baseTheme, null, 2));
			if (baseTheme.vars) {
				baseTheme.vars.accent = "#ff00ff";
			}
			writeFileSync(projectThemePath, JSON.stringify(baseTheme, null, 2));

			const loader = createLoader();
			await loader.reload();

			const prompt = loader.getPrompts().prompts.find((p) => p.name === "commit");
			expect(prompt?.filePath).toBe(projectPromptPath);

			const skill = loader.getSkills().skills.find((s) => s.name === "collision-skill");
			expect(skill?.filePath).toBe(projectSkillPath);

			const theme = loader.getThemes().themes.find((t) => t.name === "collision-theme");
			expect(theme?.sourcePath).toBe(projectThemePath);
		});

		it("should load symlinked user and project extensions once", async () => {
			const sharedExtDir = join(tempDir, "shared-extensions");
			mkdirSync(sharedExtDir, { recursive: true });
			writeFileSync(
				join(sharedExtDir, "shared.ts"),
				`export default function(pi) {
	pi.registerCommand("shared", {
		description: "shared command",
		handler: async () => {},
	});
}`,
			);

			mkdirSync(agentDir, { recursive: true });
			mkdirSync(join(cwd, CONFIG_DIR_NAME), { recursive: true });
			symlinkSync(sharedExtDir, join(agentDir, "extensions"), "dir");
			symlinkSync(sharedExtDir, join(cwd, CONFIG_DIR_NAME, "extensions"), "dir");

			const loader = createLoader();
			await loader.reload();

			const extensionsResult = loader.getExtensions();
			expect(extensionsResult.extensions).toHaveLength(1);
			expect(extensionsResult.errors).toEqual([]);

			// mergePaths processes project paths before user paths, so the project
			// alias is the canonical survivor.
			expect(extensionsResult.extensions[0].path).toBe(join(cwd, CONFIG_DIR_NAME, "extensions", "shared.ts"));
		});

		it("should load user extensions before trust and reuse them after trust resolves", async () => {
			const userExtDir = join(agentDir, "extensions");
			const projectExtDir = join(cwd, CONFIG_DIR_NAME, "extensions");
			mkdirSync(userExtDir, { recursive: true });
			mkdirSync(projectExtDir, { recursive: true });
			const loadCountKey = `__piTrustPreloadCount_${Date.now()}_${Math.random().toString(36).slice(2)}`;
			const globalState = globalThis as typeof globalThis & Record<string, number | undefined>;

			writeFileSync(
				join(userExtDir, "user.ts"),
				`globalThis[${JSON.stringify(loadCountKey)}] = (globalThis[${JSON.stringify(loadCountKey)}] ?? 0) + 1;
export default function(pi) {
	pi.on("project_trust", () => ({ trusted: "yes" }));
	pi.registerCommand("user-trust", {
		description: "user trust",
		handler: async () => {},
	});
}`,
			);
			writeFileSync(
				join(projectExtDir, "project.ts"),
				`export default function(pi) {
	pi.registerCommand("project-trusted", {
		description: "project trusted",
		handler: async () => {},
	});
}`,
			);

			const loader = createLoader();
			await loader.reload({
				resolveProjectTrust: async ({ extensionsResult }) => {
					expect(extensionsResult.extensions.map((extension) => extension.path)).toEqual([
						join(userExtDir, "user.ts"),
					]);
					return true;
				},
			});

			const extensionsResult = loader.getExtensions();
			expect(extensionsResult.extensions.map((extension) => extension.path)).toEqual([
				join(cwd, CONFIG_DIR_NAME, "extensions", "project.ts"),
				join(userExtDir, "user.ts"),
			]);
			expect(globalState[loadCountKey]).toBe(1);
		});

		it("should keep both extensions loaded when command names collide", async () => {
			const userExtDir = join(agentDir, "extensions");
			const projectExtDir = join(cwd, CONFIG_DIR_NAME, "extensions");
			mkdirSync(userExtDir, { recursive: true });
			mkdirSync(projectExtDir, { recursive: true });

			writeFileSync(
				join(projectExtDir, "project.ts"),
				`export default function(pi) {
	pi.registerCommand("deploy", {
		description: "project deploy",
		handler: async () => {},
	});
	pi.registerCommand("project-only", {
		description: "project only",
		handler: async () => {},
	});
}`,
			);

			writeFileSync(
				join(userExtDir, "user.ts"),
				`export default function(pi) {
	pi.registerCommand("deploy", {
		description: "user deploy",
		handler: async () => {},
	});
	pi.registerCommand("user-only", {
		description: "user only",
		handler: async () => {},
	});
}`,
			);

			const loader = createLoader();
			await loader.reload();

			const extensionsResult = loader.getExtensions();
			expect(extensionsResult.extensions).toHaveLength(2);
			expect(extensionsResult.errors.some((e) => e.error.includes('Command "/deploy" conflicts'))).toBe(false);

			const sessionManager = SessionManager.inMemory();
			const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
			const modelRegistry = ModelRegistry.create(authStorage);
			const runner = new ExtensionRunner(
				extensionsResult.extensions,
				extensionsResult.runtime,
				cwd,
				sessionManager,
				modelRegistry,
			);

			expect(runner.getCommand("deploy:1")?.description).toBe("project deploy");
			expect(runner.getCommand("deploy:2")?.description).toBe("user deploy");
			expect(runner.getCommand("project-only")?.description).toBe("project only");
			expect(runner.getCommand("user-only")?.description).toBe("user only");

			const commands = runner.getRegisteredCommands();
			expect(commands.map((command) => command.invocationName)).toEqual([
				"deploy:1",
				"project-only",
				"deploy:2",
				"user-only",
			]);
		});

		it("should honor overrides for auto-discovered resources", async () => {
			const settingsManager = SettingsManager.inMemory();
			settingsManager.setExtensionPaths(["-extensions/disabled.ts"]);
			settingsManager.setSkillPaths(["-skills/skip-skill"]);
			settingsManager.setPromptTemplatePaths(["-prompts/skip.md"]);
			settingsManager.setThemePaths(["-themes/skip.json"]);

			const extensionsDir = join(agentDir, "extensions");
			mkdirSync(extensionsDir, { recursive: true });
			writeFileSync(join(extensionsDir, "disabled.ts"), "export default function() {}");

			const skillDir = join(agentDir, "skills", "skip-skill");
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(
				join(skillDir, "SKILL.md"),
				`---
name: skip-skill
description: Skip me
---
Content`,
			);

			const promptsDir = join(agentDir, "prompts");
			mkdirSync(promptsDir, { recursive: true });
			writeFileSync(join(promptsDir, "skip.md"), "Skip prompt");

			const themesDir = join(agentDir, "themes");
			mkdirSync(themesDir, { recursive: true });
			writeFileSync(join(themesDir, "skip.json"), "{}");

			const loader = createLoader({ settingsManager });
			await loader.reload();

			const { extensions } = loader.getExtensions();
			const { skills } = loader.getSkills();
			const { prompts } = loader.getPrompts();
			const { themes } = loader.getThemes();

			expect(extensions.some((e) => e.path.endsWith("disabled.ts"))).toBe(false);
			expect(skills.some((s) => s.name === "skip-skill")).toBe(false);
			expect(prompts.some((p) => p.name === "skip")).toBe(false);
			expect(themes.some((t) => t.sourcePath?.endsWith("skip.json"))).toBe(false);
		});

		it("should discover AGENTS.md context files", async () => {
			writeFileSync(join(cwd, "AGENTS.md"), "# Project Guidelines\n\nBe helpful.");

			const loader = createLoader();
			await loader.reload();

			const { agentsFiles } = loader.getAgentsFiles();
			expect(agentsFiles.some((f) => f.path.includes("AGENTS.md"))).toBe(true);
		});

		it("should skip AGENTS.md and CLAUDE.md discovery when noContextFiles is true", async () => {
			writeFileSync(join(cwd, "AGENTS.md"), "# Project Guidelines\n\nBe helpful.");
			writeFileSync(join(cwd, "CLAUDE.md"), "# Claude Guidelines\n\nBe helpful.");

			const loader = createLoader({ noContextFiles: true });
			await loader.reload();

			const { agentsFiles } = loader.getAgentsFiles();
			expect(agentsFiles).toEqual([]);
		});

		it("should discover SYSTEM.md from the project config directory", async () => {
			const piDir = join(cwd, CONFIG_DIR_NAME);
			mkdirSync(piDir, { recursive: true });
			writeFileSync(join(piDir, "SYSTEM.md"), "You are a helpful assistant.");

			const loader = createLoader();
			await loader.reload();

			expect(loader.getSystemPrompt()).toBe("You are a helpful assistant.");
		});

		it("should skip project resources that require trust when project is not trusted", async () => {
			const piDir = join(cwd, CONFIG_DIR_NAME);
			const extensionsDir = join(piDir, "extensions");
			const skillDir = join(piDir, "skills", "project-skill");
			const promptsDir = join(piDir, "prompts");
			const themesDir = join(piDir, "themes");
			mkdirSync(extensionsDir, { recursive: true });
			mkdirSync(skillDir, { recursive: true });
			mkdirSync(promptsDir, { recursive: true });
			mkdirSync(themesDir, { recursive: true });
			writeFileSync(join(piDir, "SYSTEM.md"), "Project system prompt.");
			writeFileSync(join(agentDir, "SYSTEM.md"), "Global system prompt.");
			writeFileSync(join(agentDir, "AGENTS.md"), "Global instructions");
			writeFileSync(join(cwd, "AGENTS.md"), "Project instructions");
			writeFileSync(join(extensionsDir, "project.ts"), `throw new Error("should not load");`);
			writeFileSync(
				join(skillDir, "SKILL.md"),
				`---
name: project-skill
description: Project skill
---
Project skill content`,
			);
			writeFileSync(join(promptsDir, "project.md"), "Project prompt");
			const themeData = JSON.parse(
				readFileSync(join(process.cwd(), "src", "modes", "interactive", "theme", "dark.json"), "utf-8"),
			) as { name: string };
			themeData.name = "project-theme";
			writeFileSync(join(themesDir, "project.json"), JSON.stringify(themeData, null, 2));
			const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });

			const loader = createLoader({ settingsManager });
			await loader.reload();

			expect(loader.getSystemPrompt()).toBe("Global system prompt.");
			expect(loader.getAgentsFiles().agentsFiles.some((file) => file.path === join(agentDir, "AGENTS.md"))).toBe(
				true,
			);
			expect(loader.getAgentsFiles().agentsFiles.some((file) => file.path === join(cwd, "AGENTS.md"))).toBe(true);
			expect(loader.getExtensions().extensions).toHaveLength(0);
			expect(loader.getExtensions().errors).toEqual([]);
			expect(loader.getSkills().skills.some((skill) => skill.name === "project-skill")).toBe(false);
			expect(loader.getPrompts().prompts.some((prompt) => prompt.name === "project")).toBe(false);
			expect(loader.getThemes().themes.some((theme) => theme.name === "project-theme")).toBe(false);
		});

		it("should discover APPEND_SYSTEM.md", async () => {
			const piDir = join(cwd, CONFIG_DIR_NAME);
			mkdirSync(piDir, { recursive: true });
			writeFileSync(join(piDir, "APPEND_SYSTEM.md"), "Additional instructions.");

			const loader = createLoader();
			await loader.reload();

			expect(loader.getAppendSystemPrompt()).toContain("Additional instructions.");
		});
	});

	describe("extendResources", () => {
		it("should load skills and prompts with extension metadata", async () => {
			const extraSkillDir = join(tempDir, "extra-skills", "extra-skill");
			mkdirSync(extraSkillDir, { recursive: true });
			const skillPath = join(extraSkillDir, "SKILL.md");
			writeFileSync(
				skillPath,
				`---
name: extra-skill
description: Extra skill
---
Extra content`,
			);

			const extraPromptDir = join(tempDir, "extra-prompts");
			mkdirSync(extraPromptDir, { recursive: true });
			const promptPath = join(extraPromptDir, "extra.md");
			writeFileSync(
				promptPath,
				`---
description: Extra prompt
---
Extra prompt content`,
			);

			const loader = createLoader();
			await loader.reload();

			await loader.extendResources({
				skillPaths: [
					{
						path: extraSkillDir,
						metadata: {
							source: "extension:extra",
							scope: "temporary",
							origin: "top-level",
							baseDir: extraSkillDir,
						},
					},
				],
				promptPaths: [
					{
						path: promptPath,
						metadata: {
							source: "extension:extra",
							scope: "temporary",
							origin: "top-level",
							baseDir: extraPromptDir,
						},
					},
				],
			});

			const { skills } = loader.getSkills();
			const loadedSkill = skills.find((skill) => skill.name === "extra-skill");
			expect(loadedSkill).toBeDefined();
			expect(loadedSkill?.sourceInfo?.source).toBe("extension:extra");
			expect(loadedSkill?.sourceInfo?.path).toBe(skillPath);

			const { prompts } = loader.getPrompts();
			const loadedPrompt = prompts.find((prompt) => prompt.name === "extra");
			expect(loadedPrompt).toBeDefined();
			expect(loadedPrompt?.sourceInfo?.source).toBe("extension:extra");
			expect(loadedPrompt?.sourceInfo?.path).toBe(promptPath);
		});

		it("should load extension resources returned as file URLs", async () => {
			const extraSkillDir = join(tempDir, "extra skills", "file-url-skill");
			mkdirSync(extraSkillDir, { recursive: true });
			const skillPath = join(extraSkillDir, "SKILL.md");
			writeFileSync(
				skillPath,
				`---
name: file-url-skill
description: File URL skill
---
Extra content`,
			);

			const loader = createLoader();
			await loader.reload();

			await loader.extendResources({
				skillPaths: [
					{
						path: pathToFileURL(extraSkillDir).href,
						metadata: {
							source: "extension:file-url",
							scope: "temporary",
							origin: "top-level",
							baseDir: extraSkillDir,
						},
					},
				],
			});

			const { skills, diagnostics } = loader.getSkills();
			expect(diagnostics).toEqual([]);
			const loadedSkill = skills.find((skill) => skill.name === "file-url-skill");
			expect(loadedSkill).toBeDefined();
			expect(loadedSkill?.filePath).toBe(skillPath);
			expect(loadedSkill?.sourceInfo?.source).toBe("extension:file-url");
		});
	});

	describe("noSkills option", () => {
		it("should skip skill discovery when noSkills is true", async () => {
			const skillsDir = join(agentDir, "skills");
			mkdirSync(skillsDir, { recursive: true });
			writeFileSync(
				join(skillsDir, "test-skill.md"),
				`---
name: test-skill
description: A test skill
---
Content`,
			);

			const loader = createLoader({ noSkills: true });
			await loader.reload();

			const { skills } = loader.getSkills();
			expect(skills).toEqual([]);
			// noSkills is a ResourceLoader visibility policy; inert HCP Resources remain manageable.
			expect(loader.HcpClientgetsession()?.resolve("skill:paper-analysis")).toBeDefined();
		});

		it("should still load additional skill paths when noSkills is true", async () => {
			const customSkillDir = join(tempDir, "custom-skills");
			mkdirSync(customSkillDir, { recursive: true });
			writeFileSync(
				join(customSkillDir, "custom.md"),
				`---
name: custom
description: Custom skill
---
Content`,
			);

			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				includeBundledResources: false,
				noSkills: true,
				additionalSkillPaths: [customSkillDir],
			});
			await loader.reload();

			const { skills } = loader.getSkills();
			expect(skills.some((s) => s.name === "custom")).toBe(true);
		});
	});

	describe("override functions", () => {
		it("should apply skillsOverride", async () => {
			const injectedSkill: Skill = {
				name: "injected",
				description: "Injected skill",
				content: "Injected skill",
				filePath: "/fake/path",
				baseDir: "/fake",
				sourceInfo: createSyntheticSourceInfo("/fake/path", { source: "custom" }),
				disableModelInvocation: false,
			};
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				includeBundledResources: false,
				skillsOverride: () => ({
					skills: [injectedSkill],
					diagnostics: [],
				}),
			});
			await loader.reload();

			const { skills } = loader.getSkills();
			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("injected");
		});

		it("should apply systemPromptOverride", async () => {
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				includeBundledResources: false,
				systemPromptOverride: () => "Custom system prompt",
			});
			await loader.reload();

			expect(loader.getSystemPrompt()).toBe("Custom system prompt");
		});
	});

	describe("extension conflict detection", () => {
		it("should detect tool conflicts between extensions", async () => {
			// Create two extensions that register the same tool
			const ext1Dir = join(agentDir, "extensions", "ext1");
			const ext2Dir = join(agentDir, "extensions", "ext2");
			mkdirSync(ext1Dir, { recursive: true });
			mkdirSync(ext2Dir, { recursive: true });

			writeFileSync(
				join(ext1Dir, "index.ts"),
				`
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "duplicate-tool",
    description: "First",
    parameters: Type.Object({}),
    execute: async () => ({ result: "1" }),
  });
}`,
			);

			writeFileSync(
				join(ext2Dir, "index.ts"),
				`
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "duplicate-tool",
    description: "Second",
    parameters: Type.Object({}),
    execute: async () => ({ result: "2" }),
  });
}`,
			);

			const loader = createLoader();
			await loader.reload();

			const { errors } = loader.getExtensions();
			expect(errors.some((e) => e.error.includes("duplicate-tool") && e.error.includes("conflicts"))).toBe(true);
		});

		it("should prefer explicit CLI extensions over discovered extensions when commands and tools conflict", async () => {
			const globalExtDir = join(agentDir, "extensions");
			mkdirSync(globalExtDir, { recursive: true });
			const explicitExtPath = join(tempDir, "explicit-extension.ts");

			writeFileSync(
				join(globalExtDir, "global.ts"),
				`
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "duplicate-tool",
    description: "global tool",
    parameters: Type.Object({}),
    execute: async () => ({ result: "global" }),
  });
  pi.registerCommand("deploy", {
    description: "global command",
    handler: async () => {},
  });
}`,
			);

			writeFileSync(
				explicitExtPath,
				`
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "duplicate-tool",
    description: "explicit tool",
    parameters: Type.Object({}),
    execute: async () => ({ result: "explicit" }),
  });
  pi.registerCommand("deploy", {
    description: "explicit command",
    handler: async () => {},
  });
}`,
			);

			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				includeBundledResources: false,
				additionalExtensionPaths: [explicitExtPath],
			});
			await loader.reload();

			const extensionsResult = loader.getExtensions();
			expect(extensionsResult.extensions[0]?.path).toBe(explicitExtPath);

			const sessionManager = SessionManager.inMemory();
			const authStorage = AuthStorage.create(join(tempDir, "auth-explicit.json"));
			const modelRegistry = ModelRegistry.create(authStorage);
			const runner = new ExtensionRunner(
				extensionsResult.extensions,
				extensionsResult.runtime,
				cwd,
				sessionManager,
				modelRegistry,
			);

			expect(runner.getCommand("deploy:1")?.description).toBe("explicit command");
			expect(runner.getCommand("deploy:2")?.description).toBe("global command");
			expect(runner.getToolDefinition("duplicate-tool")?.description).toBe("explicit tool");
		});
	});

	describe("skill namespacing", () => {
		function writeSkillDir(dir: string, name: string, description: string): string {
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, "SKILL.md"),
				`---\nname: ${name}\ndescription: ${description}\n---\nBody for ${name}.`,
			);
			return dir;
		}

		it("assigns each skill a `<source>:<name>` qualifiedName", async () => {
			writeSkillDir(join(tempDir, "skills-a", "solo"), "solo", "Solo skill");
			const loader = createLoader({ additionalSkillPaths: [join(tempDir, "skills-a", "solo")] });
			await loader.reload();

			const skill = loader.getSkills().skills.find((s) => s.name === "solo");
			expect(skill).toBeDefined();
			expect(skill?.qualifiedName).toBe(`${skill?.sourceInfo.source}:solo`);
		});

		it("resolves skills by bare name and by qualified name", async () => {
			writeSkillDir(join(tempDir, "skills-a", "solo"), "solo", "Solo skill");
			const loader = createLoader({ additionalSkillPaths: [join(tempDir, "skills-a", "solo")] });
			await loader.reload();

			const bare = loader.resolveSkill("solo");
			expect(bare?.name).toBe("solo");
			expect(loader.resolveSkill(bare?.qualifiedName ?? "")?.name).toBe("solo");
			expect(loader.resolveSkill("does-not-exist")).toBeUndefined();
		});

		it("keeps only the winner model-visible on a bare-name collision", async () => {
			const winnerDir = writeSkillDir(join(tempDir, "skills-a", "dup"), "dup", "Winner");
			const loserDir = writeSkillDir(join(tempDir, "skills-b", "dup"), "dup", "Loser");
			const loader = createLoader({ additionalSkillPaths: [winnerDir, loserDir] });
			await loader.reload();

			// Only the winner (first loaded) is model-visible, and a bare-name lookup returns it.
			const visible = loader.getSkills().skills.filter((s) => s.name === "dup");
			expect(visible).toHaveLength(1);
			const winner = loader.resolveSkill("dup");
			expect(winner?.filePath).toBe(join(winnerDir, "SKILL.md"));
			// Same-source special case: both are filesystem skills carrying source "local", so they share
			// the qualified name "local:dup" and the winner shadows the loser under it too. Cross-source
			// collisions stay separable — see "namespaces a package skill vs a same-named local skill".
			expect(loader.resolveSkill("local:dup")?.filePath).toBe(join(winnerDir, "SKILL.md"));
		});

		it("namespaces a package skill vs a same-named local skill (both stay reachable)", async () => {
			// The package fixture contributes a skill named "test-domain" with source
			// "harness:TestDomain:general". Add a filesystem-local skill of the same bare name.
			writeHarnessPackageFixture(cwd);
			const localDir = writeSkillDir(join(tempDir, "skills-local", "test-domain"), "test-domain", "Local override");
			const loader = createLoader({ harnessPackages: ["TestDomain"], additionalSkillPaths: [localDir] });
			await loader.reload();

			// Exactly one "test-domain" is model-visible (deduped), but the loser is not discarded.
			const visible = loader.getSkills().skills.filter((s) => s.name === "test-domain");
			expect(visible).toHaveLength(1);

			// The two contenders have distinct sources, hence distinct qualified names, so BOTH are
			// reachable by their qualified names regardless of which one won the bare-name slot.
			const pkg = loader.resolveSkill("harness:TestDomain:general:test-domain");
			const local = loader.resolveSkill("local:test-domain");
			expect(pkg).toBeDefined();
			expect(local).toBeDefined();
			expect(pkg?.filePath).not.toBe(local?.filePath);
			expect(local?.filePath).toBe(join(localDir, "SKILL.md"));

			// A bare-name lookup lands on the model-visible winner.
			expect(loader.resolveSkill("test-domain")?.filePath).toBe(visible[0].filePath);
		});
	});

	describe("skill hot-reload", () => {
		function writeSkill(dir: string, name: string, description: string): void {
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, "SKILL.md"),
				`---\nname: ${name}\ndescription: ${description}\n---\nBody for ${name}.`,
			);
		}

		async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<boolean> {
			const start = performance.now();
			while (performance.now() - start < timeoutMs) {
				if (predicate()) return true;
				await new Promise((r) => setTimeout(r, 25));
			}
			return predicate();
		}

		it("does not watch when watchSkills is disabled", async () => {
			const skillDir = join(tempDir, "skills", "watched");
			writeSkill(skillDir, "watched", "Original");
			const loader = createLoader({ additionalSkillPaths: [skillDir] });
			await loader.reload();
			// onSkillsReloaded is exposed, but the event never fires without a watcher.
			let fired = false;
			loader.onSkillsReloaded(() => {
				fired = true;
			});
			writeSkill(join(tempDir, "skills", "added"), "added", "New skill");
			const appeared = await waitFor(() => loader.getSkills().skills.some((s) => s.name === "added"), 400);
			expect(appeared).toBe(false);
			expect(fired).toBe(false);
			loader.dispose();
		});

		it("reloads skills and notifies subscribers when a watched dir changes", async () => {
			const skillDir = join(tempDir, "skills", "watched");
			writeSkill(skillDir, "watched", "Original description");
			const loader = createLoader({ additionalSkillPaths: [skillDir], watchSkills: true });
			await loader.reload();
			expect(loader.getSkills().skills.find((s) => s.name === "watched")?.description).toBe("Original description");

			let notified = 0;
			loader.onSkillsReloaded(() => {
				notified++;
			});

			// Edit the existing skill in place; the watcher on its parent dir should pick it up.
			writeSkill(skillDir, "watched", "Updated description");
			const updated = await waitFor(
				() => loader.getSkills().skills.find((s) => s.name === "watched")?.description === "Updated description",
			);
			expect(updated).toBe(true);
			expect(notified).toBeGreaterThanOrEqual(1);
			loader.dispose();
		});

		it("preserves Package visibility and source metadata across skill hot-reload", async () => {
			writeHarnessPackageFixture(cwd);
			const loader = createLoader({ harnessPackages: ["TestDomain"], watchSkills: true });
			await loader.reload();

			const initial = loader.getSkills().skills.find((skill) => skill.name === "hidden-domain");
			expect(initial?.disableModelInvocation).toBe(true);
			expect(initial?.sourceInfo?.source).toBe("harness:TestDomain:general");

			const skillFile = join(cwd, "packages", "TestDomain", "skills", "hidden-domain", "SKILL.md");
			writeFileSync(
				skillFile,
				"---\nname: hidden-domain\ndescription: Updated explicit-only package skill.\n---\n\n# Hidden Domain\n",
			);
			const updated = await waitFor(
				() =>
					loader.getSkills().skills.find((skill) => skill.name === "hidden-domain")?.description ===
					"Updated explicit-only package skill.",
			);

			expect(updated).toBe(true);
			const reloaded = loader.getSkills().skills.find((skill) => skill.name === "hidden-domain");
			expect(reloaded?.disableModelInvocation).toBe(true);
			expect(reloaded?.sourceInfo?.source).toBe("harness:TestDomain:general");
			expect(formatSkillsForPrompt(loader.getSkills().skills)).not.toContain("<name>hidden-domain</name>");
			await loader.dispose();
		});

		it("stops firing after dispose", async () => {
			const skillDir = join(tempDir, "skills", "watched");
			writeSkill(skillDir, "watched", "Original");
			const loader = createLoader({ additionalSkillPaths: [skillDir], watchSkills: true });
			await loader.reload();
			let notified = 0;
			loader.onSkillsReloaded(() => {
				notified++;
			});
			loader.dispose();
			writeSkill(skillDir, "watched", "Changed after dispose");
			// Give any lingering watcher a chance to (incorrectly) fire.
			await new Promise((r) => setTimeout(r, 400));
			expect(notified).toBe(0);
		});
	});
});
