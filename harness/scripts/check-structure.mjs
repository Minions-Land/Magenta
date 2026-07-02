import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { harnessRoot, isInside, pathLabel, readToml, repoRoot } from "./lib/files.mjs";

const failures = [];
const warnings = [];
const notes = [];

const allowedTopLevel = new Set([
	"README.md",
	"assembly",
	"catalog",
	"compaction",
	"context",
	"docs",
	"env",
	"harness.toml",
	"hooks",
	"index.ts",
	"loop",
	"memory",
	"messages",
	"package.json",
	"policy",
	"prompt-templates",
	"runtime",
	"sandbox",
	"scripts",
	"session",
	"skills",
	"system-prompt",
	"test",
	"tools",
	"tsconfig.build.json",
	"tsconfig.json",
	"types",
	"utils",
	"vitest.config.ts",
]);

const ignoredOutputDirs = new Set(["dist", "node_modules"]);
const implementationSourceNames = new Set(["pi", "codex", "jcode", "claude-code", "magenta"]);
const deprecatedPackKinds = new Set(["hcp-process-pack", "sandbox-pack", "runtime-pack", "hook-pack", "policy-pack"]);
const foldedToolModuleNames = new Set([
	"ast-edit-plan",
	"ast-grep",
	"echo-json",
	"edit-hashline",
	"fuzzy-find",
	"glob",
	"read-anchored",
	"read-url",
]);
const sourceModuleDirs = [
	"assembly",
	"catalog",
	"compaction",
	"context",
	"env",
	"hooks",
	"loop",
	"memory",
	"messages",
	"policy",
	"prompt-templates",
	"runtime",
	"sandbox",
	"session",
	"skills",
	"system-prompt",
	"test",
	"tools",
	"types",
	"utils",
];

function fail(message) {
	failures.push(message);
}

function warn(message) {
	warnings.push(message);
}

function note(message) {
	notes.push(message);
}

function resolveInside(baseDir, ref, context) {
	if (typeof ref !== "string" || !ref.trim()) {
		fail(`${context} has an empty path`);
		return undefined;
	}
	const resolved = isAbsolute(ref) ? resolve(ref) : resolve(baseDir, ref);
	if (!isInside(harnessRoot, resolved)) {
		fail(`${context} escapes harness root: ${ref}`);
		return undefined;
	}
	return resolved;
}

function checkTopLevel() {
	for (const entry of readdirSync(harnessRoot, { withFileTypes: true })) {
		if (ignoredOutputDirs.has(entry.name)) {
			note(`ignoring local output directory ${pathLabel(join(harnessRoot, entry.name))}`);
			continue;
		}
		if (!allowedTopLevel.has(entry.name)) {
			fail(`unexpected top-level harness entry: ${entry.name}`);
		}
	}
}

function checkReadmes() {
	for (const dir of sourceModuleDirs) {
		const fullPath = join(harnessRoot, dir);
		if (!existsSync(fullPath)) {
			fail(`missing expected harness module directory: harness/${dir}`);
			continue;
		}
		const readme = join(fullPath, "README.md");
		if (!existsSync(readme)) fail(`missing README.md for harness/${dir}`);
	}
}

function checkRegistry() {
	const index = readToml(join(harnessRoot, "harness.toml"));
	const components = Array.isArray(index.components) ? index.components : [];
	const catalogs = Array.isArray(index.catalogs) ? index.catalogs : [];
	const seen = new Set();

	for (const component of components) {
		const key = `${component.kind}:${component.name}`;
		if (seen.has(key)) fail(`duplicate component registration: ${key}`);
		seen.add(key);
		if (component.kind === "tool" && foldedToolModuleNames.has(component.name)) {
			fail(`component ${key} is a folded tool sub-operation; register the owning tool module instead`);
		}

		const componentPath = resolveInside(harnessRoot, component.path, `component ${key}`);
		if (!componentPath) continue;
		if (!existsSync(componentPath)) {
			fail(`component ${key} points to missing file: ${pathLabel(componentPath)}`);
			continue;
		}
		const spec = readToml(componentPath);
		if (deprecatedPackKinds.has(component.kind) || deprecatedPackKinds.has(spec.kind)) {
			fail(`component ${key} uses deprecated pack kind; register it as its Harness Module capability kind`);
		}
		if (typeof spec.kind === "string" && spec.kind !== component.kind) {
			fail(`component ${key} kind drift: index=${component.kind}, spec=${spec.kind}`);
		}
		if (typeof spec.name === "string" && spec.name !== component.name) {
			fail(`component ${key} name drift: index=${component.name}, spec=${spec.name}`);
		}
		checkComponentSourceDirectory(componentPath, spec, key);
	}

	for (const catalog of catalogs) {
		const catalogPath = resolveInside(harnessRoot, catalog.path, `catalog ${catalog.name}`);
		if (!catalogPath) continue;
		if (!existsSync(catalogPath)) {
			fail(`catalog ${catalog.name} points to missing file: ${pathLabel(catalogPath)}`);
			continue;
		}
		const spec = readToml(catalogPath);
		const catalogDir = dirname(catalogPath);
		if (spec.inventory?.path) {
			const inventoryPath = resolveInside(catalogDir, spec.inventory.path, `catalog ${catalog.name} inventory`);
			if (inventoryPath && !existsSync(inventoryPath)) {
				fail(`catalog ${catalog.name} inventory is missing: ${pathLabel(inventoryPath)}`);
			}
		} else {
			fail(`catalog ${catalog.name} is missing [inventory].path`);
		}
		if (spec.integration?.path) {
			const integrationPath = resolveInside(catalogDir, spec.integration.path, `catalog ${catalog.name} integration`);
			if (integrationPath && !existsSync(integrationPath)) {
				fail(`catalog ${catalog.name} integration map is missing: ${pathLabel(integrationPath)}`);
			}
		}
	}
}

function checkComponentSourceDirectory(componentPath, spec, key) {
	if (spec.kind === "contract") return;
	if (typeof spec.source !== "string" || !implementationSourceNames.has(spec.source)) return;
	const sourceDir = join(dirname(componentPath), spec.source);
	if (!existsSync(sourceDir)) {
		fail(`component ${key} declares source=${spec.source} but is missing ${pathLabel(sourceDir)}`);
	}
}

function checkRepoPackages() {
	const packagesRoot = join(repoRoot, "packages");
	if (!existsSync(packagesRoot)) {
		warn(`repo packages root is missing: ${pathLabel(packagesRoot)}`);
		return;
	}
	checkRepoPackageTemplates(packagesRoot);
	for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "templates") continue;
		const packageRoot = join(packagesRoot, entry.name);
		const manifestPath = join(packagesRoot, entry.name, "package.toml");
		if (!existsSync(manifestPath)) {
			warn(`package directory has no package.toml: packages/${entry.name}`);
			continue;
		}
		if (existsSync(join(packageRoot, "domain-harness"))) {
			fail(`package ${entry.name} must not contain domain-harness; use flat package-root skills/ and tools/`);
		}
		if (existsSync(join(packageRoot, "general")) || existsSync(join(packageRoot, "task"))) {
			fail(`package ${entry.name} must not use general/ or task/ wrappers; use flat package-root skills/ and tools/`);
		}
		if (existsSync(join(packageRoot, ".omics-runtime")) || existsSync(join(packageRoot, ".runtime"))) {
			fail(`package ${entry.name} must not keep hidden implementation roots; use package-root tools/<tool>/`);
		}
		if (existsSync(join(packageRoot, "general", "tools"))) {
			fail(`package ${entry.name} must not keep tools under general/tools; use package-root tools/<tool>/`);
		}
		if (existsSync(join(packageRoot, "general", ".omics-runtime"))) {
			fail(`package ${entry.name} must not keep implementation assets under general/.omics-runtime; use package-root tools/<tool>/`);
		}
		const taskRoot = join(packageRoot, "task");
		if (existsSync(taskRoot)) {
			for (const taskEntry of readdirSync(taskRoot, { withFileTypes: true })) {
				if (taskEntry.isDirectory() && existsSync(join(taskRoot, taskEntry.name, "tools"))) {
					fail(`package ${entry.name} task ${taskEntry.name} must not keep tools under task/${taskEntry.name}/tools; use package-root tools/<tool>/`);
				}
			}
		}
		const manifest = readToml(manifestPath);
		if (manifest.schema_version && manifest.schema_version !== "magenta.package.v1") {
			fail(`package ${entry.name} has unsupported schema_version: ${manifest.schema_version}`);
		}
		if (manifest.id && manifest.id !== entry.name) {
			warn(`package directory/name differ: dir=${entry.name}, id=${manifest.id}`);
		}
		for (const profile of Array.isArray(manifest.profiles) ? manifest.profiles : []) {
			if (!profile.harness) continue;
			const profileHarnessPath = resolve(packageRoot, profile.harness);
			if (!isInside(packageRoot, profileHarnessPath)) {
				fail(`package ${entry.name} profile ${profile.name ?? "<unnamed>"} harness escapes package: ${profile.harness}`);
			} else if (!existsSync(profileHarnessPath)) {
				fail(`package ${entry.name} profile ${profile.name ?? "<unnamed>"} harness is missing: ${pathLabel(profileHarnessPath)}`);
			}
		}
	}
}

function checkRepoPackageTemplates(packagesRoot) {
	const templatesRoot = join(packagesRoot, "templates");
	if (!existsSync(templatesRoot)) return;
	if (existsSync(join(templatesRoot, "domain-package"))) {
		fail("packages/templates/domain-package is invalid; use packages/templates/harness-package");
	}
	if (!existsSync(join(templatesRoot, "harness-package"))) {
		fail("packages/templates/harness-package is missing");
	}
	if (existsSync(join(templatesRoot, "harness-package", ".runtime"))) {
		fail("packages/templates/harness-package/.runtime is invalid; template implementations belong under tools/<tool>/");
	}
	if (
		existsSync(join(templatesRoot, "harness-package", "general")) ||
		existsSync(join(templatesRoot, "harness-package", "task"))
	) {
		fail("packages/templates/harness-package must be flat; use package-root skills/ and tools/");
	}
}

function checkSupportLayout() {
	for (const name of ["mcp", "template"]) {
		const dir = join(harnessRoot, name);
		if (existsSync(dir)) {
			fail(`harness/${name} is invalid as a top-level placeholder; support-only material must live under docs/ or scripts/`);
		}
	}
	if (existsSync(join(harnessRoot, "skills", "bundled"))) {
		fail("harness/skills/bundled is invalid; bundled skills are owned by the pi source at harness/skills/pi/bundled");
	}
}

function checkToolLayout() {
	const processDir = join(harnessRoot, "tools", "process");
	if (existsSync(processDir)) {
		fail("harness/tools/process is invalid; process-backed implementations must live under tools/<tool>/<source>/");
	}
	const supportDir = join(harnessRoot, "tools", "support");
	if (existsSync(supportDir)) {
		fail("harness/tools/support is invalid; shared utility code must live under harness/utils/<source>/");
	}
	for (const name of foldedToolModuleNames) {
		const dir = join(harnessRoot, "tools", name);
		if (existsSync(dir)) {
			fail(`harness/tools/${name} is a folded tool sub-operation; keep it under the owning tool source directory`);
		}
	}
	const toolsRoot = join(harnessRoot, "tools");
	for (const entry of readdirSync(toolsRoot, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		const descriptorPath = join(toolsRoot, entry.name, `${entry.name}.toml`);
		if (!existsSync(descriptorPath)) {
			fail(`harness/tools/${entry.name} is not a valid tool slot; missing tools/${entry.name}/${entry.name}.toml`);
		}
	}
}

function checkGeneratedNoise() {
	const generated = [
		join(harnessRoot, "dist"),
		join(harnessRoot, "node_modules"),
		join(harnessRoot, "memory", "dist"),
	];
	const toolsRoot = join(harnessRoot, "tools");
	if (existsSync(toolsRoot)) {
		for (const entry of readdirSync(toolsRoot, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			generated.push(join(toolsRoot, entry.name, "magenta", "process-tools", "target"));
		}
	}
	for (const path of generated) {
		if (existsSync(path)) {
			const stat = statSync(path);
			if (stat.isDirectory()) note(`local generated directory present and ignored by structure check: ${pathLabel(path)}`);
		}
	}
}

checkTopLevel();
checkReadmes();
checkRegistry();
checkRepoPackages();
checkSupportLayout();
checkToolLayout();
checkGeneratedNoise();

for (const message of notes) console.log(`note: ${message}`);
for (const message of warnings) console.warn(`warning: ${message}`);

if (failures.length > 0) {
	console.error("Harness structure check failed:");
	for (const message of failures) console.error(`  - ${message}`);
	process.exit(1);
}

console.log("Harness structure check passed.");
