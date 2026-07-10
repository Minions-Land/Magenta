import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { findComponentSourceDirectories, findModuleSourceDirectories } from "./generate-hcp-sources.mjs";
import { harnessRoot, isInside, pathLabel, readToml, repoRoot } from "./lib/files.mjs";

const failures = [];
const warnings = [];
const notes = [];

const allowedTopLevel = new Set([
	"README.md",
	"README-harness.md",
	"HcpClient.ts",
	"_magenta",
	"catalog",
	"compaction",
	"context",
	"hooks",
	"memory",
	"multiagent",
	"policy",
	"prompt-templates",
	"runtime",
	"sandbox",
	"skills",
	"system-prompt",
	"tools",
	"docs",
	"eval",
	"eslint.config.mjs",
	"harness.toml",
	"index.ts",
	"package.json",
	"scripts",
	"test",
	"tsconfig.build.json",
	"tsconfig.json",
	"vitest.config.ts",
]);

const ignoredOutputDirs = new Set(["dist", "node_modules"]);
const implementationSourceNames = new Set(["pi", "codex", "jcode", "claude-code", "magenta", "descriptor"]);
const deprecatedPackKinds = new Set(["hcp-process-pack", "sandbox-pack", "runtime-pack", "hook-pack", "policy-pack"]);
const infrastructureRoots = [resolve(harnessRoot, ".HCP"), resolve(harnessRoot, "_magenta")];
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
	".HCP",
	"compaction",
	"context",
	"_magenta/env",
	"hooks",
	"memory",
	"_magenta/messages",
	"policy",
	"prompt-templates",
	"runtime",
	"sandbox",
	"_magenta/session",
	"skills",
	"system-prompt",
	"test",
	"tools",
	"_magenta/types",
	"_magenta/utils",
];
const capabilityModules = new Map();
const checkedRoleFiles = new Set();
const registeredComponentPaths = new Set();
const productionScanIgnoredDirs = new Set([".git", ".tmp", "coverage", "dist", "node_modules", "target"]);
const forbiddenHcpIdentifiers = new Set(["CapabilitySourceMagnet", "ModuleHcpServer"]);
const allowedHcpClientConstructor = resolve(harnessRoot, ".HCP", "assembly", "session-hcp.ts");
const sharedProcessToolsRoot = resolve(harnessRoot, "_magenta", "process-tools");
const sharedProcessToolsCommand = "../../../_magenta/process-tools/target/release/magenta-process-tools";

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
		// Dot-prefixed entries are local/tooling state (.git, ._magenta, editor dirs),
		// not part of the tracked source tree.
		if (entry.name.startsWith(".")) continue;
		if (!allowedTopLevel.has(entry.name)) {
			fail(`unexpected top-level harness entry: ${entry.name}`);
		}
	}
}

function checkReadmes() {
	for (const dir of sourceModuleDirs) {
		const fullPath = join(harnessRoot, dir);
		if (!existsSync(fullPath)) {
			fail(`missing expected harness module directory: ${dir}`);
			continue;
		}
		const readme = join(fullPath, "README.md");
		if (!existsSync(readme)) fail(`missing README.md for ${dir}`);
	}
}

function checkRegistry() {
	const index = readToml(join(harnessRoot, "harness.toml"));
	const modules = Array.isArray(index.modules) ? index.modules : [];
	const components = Array.isArray(index.components) ? index.components : [];
	const catalogs = Array.isArray(index.catalogs) ? index.catalogs : [];
	const seen = new Set();

	for (const module of modules) {
		const key = `${module.kind}:${module.name}`;
		if (seen.has(key)) fail(`duplicate module registration: ${key}`);
		seen.add(key);
		const moduleDir = resolveInside(harnessRoot, module.path, `module ${key}`);
		if (!moduleDir) continue;
		if (!existsSync(moduleDir)) {
			fail(`module ${key} points to missing directory: ${pathLabel(moduleDir)}`);
			continue;
		}
		if (infrastructureRoots.some((root) => isInside(root, moduleDir))) {
			fail(`module ${key} registers infrastructure/shared code at ${pathLabel(moduleDir)}`);
			continue;
		}
		checkRoleFile(join(moduleDir, "HcpServer.ts"), "HcpServer", `registered Harness Module ${key}`);
		for (const source of declaredSourceNames(module, key, { allowEmpty: true })) {
			const sourceDirectories = findModuleSourceDirectories(harnessRoot, moduleDir, module, source);
			if (sourceDirectories.length === 0) {
				fail(`module ${key} declares source=${source} but no matching source directory exists under ${pathLabel(moduleDir)}`);
				continue;
			}
			for (const sourceDir of sourceDirectories) {
				checkRoleFile(join(sourceDir, "HcpMagnet.ts"), "HcpMagnet", `registered Harness Module ${key}:${source}`);
			}
		}
	}

	for (const component of components) {
		const key = `${component.kind}:${component.name}`;
		if (seen.has(key)) fail(`duplicate component registration: ${key}`);
		seen.add(key);
		if (component.kind === "tool" && foldedToolModuleNames.has(component.name)) {
			fail(`component ${key} is a folded tool sub-operation; register the owning tool module instead`);
		}

		const componentPath = resolveInside(harnessRoot, component.path, `component ${key}`);
		if (!componentPath) continue;
		registeredComponentPaths.add(componentPath);
		if (!existsSync(componentPath)) {
			fail(`component ${key} points to missing file: ${pathLabel(componentPath)}`);
			continue;
		}
		if (infrastructureRoots.some((root) => isInside(root, componentPath))) {
			fail(
				`component ${key} registers infrastructure/shared code at ${pathLabel(componentPath)}; ` +
					"only real Harness Modules with HcpServer.ts and source HcpMagnet.ts belong in harness.toml",
			);
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
		checkLegacyMagnetReferences(spec, key);
		registerHarnessModule(componentPath, spec, key);
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

function checkCapabilityDescriptors() {
	for (const descriptorPath of collectFiles(harnessRoot, (entry) => entry.name.endsWith(".toml"))) {
		const spec = readToml(descriptorPath);
		if (!spec.assumption || typeof spec.assumption !== "object" || Array.isArray(spec.assumption)) continue;
		if (registeredComponentPaths.has(descriptorPath)) continue;

		const key = `${spec.kind ?? "<unknown>"}:${spec.name ?? basename(descriptorPath, ".toml")}`;
		fail(`capability descriptor ${pathLabel(descriptorPath)} (${key}) is not registered in harness.toml`);
		checkComponentSourceDirectory(descriptorPath, spec, key);
		checkLegacyMagnetReferences(spec, key);
		registerHarnessModule(descriptorPath, spec, key);
	}
}

function checkLegacyMagnetReferences(value, context) {
	if (typeof value === "string") {
		if (/(^|\/)magnet\.ts$/.test(value)) {
			fail(`${context} references retired magnet.ts path: ${value}; use HcpMagnet.ts`);
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const entry of value) checkLegacyMagnetReferences(entry, context);
		return;
	}
	if (!value || typeof value !== "object") return;
	for (const entry of Object.values(value)) checkLegacyMagnetReferences(entry, context);
}

function registerHarnessModule(componentPath, spec, key) {
	const moduleDir = dirname(componentPath);
	let module = capabilityModules.get(moduleDir);
	if (!module) {
		module = { contexts: [], sources: new Map() };
		capabilityModules.set(moduleDir, module);
	}
	module.contexts.push(key);

	for (const source of declaredSourceNames(spec, key)) {
		let sourceDirectories = module.sources.get(source);
		if (!sourceDirectories) {
			sourceDirectories = new Set();
			module.sources.set(source, sourceDirectories);
		}
		for (const sourceDirectory of findComponentSourceDirectories(harnessRoot, componentPath, spec, source)) {
			sourceDirectories.add(sourceDirectory);
		}
	}
}

function declaredSourceNames(spec, key, { allowEmpty = false } = {}) {
	const selected = typeof spec.source === "string" && spec.source.trim() ? spec.source : undefined;
	const explicit = Array.isArray(spec.sources) ? spec.sources : [];
	const sources = explicit.length > 0 ? explicit : selected ? [selected] : [];
	if (!allowEmpty && sources.length === 0) {
		fail(`component ${key} is missing its source`);
		return [];
	}
	if (new Set(sources).size !== sources.length) fail(`component ${key} declares duplicate sources`);
	if (selected && explicit.length > 0 && !explicit.includes(selected)) {
		fail(`component ${key} selected source=${selected} is missing from sources`);
	}
	return sources.filter((source) => {
		if (typeof source === "string" && implementationSourceNames.has(source)) return true;
		fail(
			`component ${key} declares invalid source=${String(source)}; expected one of ` +
				`${[...implementationSourceNames].join(", ")}`,
		);
		return false;
	});
}

function checkComponentSourceDirectory(componentPath, spec, key) {
	for (const source of declaredSourceNames(spec, key)) {
		const sourceDirectories = findComponentSourceDirectories(harnessRoot, componentPath, spec, source);
		if (sourceDirectories.length === 0) {
			fail(
				`component ${key} declares source=${source} but no matching source directory exists under ` +
					pathLabel(dirname(componentPath)),
			);
		}
	}
}

function checkCapabilityModuleRoles() {
	for (const [moduleDir, module] of capabilityModules) {
		const moduleName = basename(moduleDir);
		checkRoleFile(
			join(moduleDir, "HcpServer.ts"),
			"HcpServer",
			`capability module ${moduleName} (${module.contexts.join(", ")})`,
		);

		for (const [source, sourceDirectories] of module.sources) {
			if (sourceDirectories.size === 0) {
				// checkComponentSourceDirectory emits the component-specific path error.
				continue;
			}
			for (const sourceDir of sourceDirectories) {
				checkRoleFile(
					join(sourceDir, "HcpMagnet.ts"),
					"HcpMagnet",
					`capability source ${moduleName}:${source}`,
				);
			}
		}
	}
}

function checkPackageBoundary() {
	const packagesRoot = join(repoRoot, "packages");
	const templateRoot = join(packagesRoot, "templates", "harness-package");
	for (const filePath of [join(packagesRoot, "README.md"), join(templateRoot, "README.md")]) {
		if (!existsSync(filePath)) fail(`package integration boundary is missing: ${pathLabel(filePath)}`);
	}
	if (!existsSync(packagesRoot)) return;
	for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
		if (entry.name !== "README.md" && entry.name !== "templates") {
			fail(`concrete domain packages belong in MagentaPackages: ${pathLabel(join(packagesRoot, entry.name))}`);
		}
	}
}

function checkSupportLayout() {
	// Support-only material must live under docs/ or scripts/, not as a
	// top-level placeholder directory.
	for (const name of ["template"]) {
		const dir = join(harnessRoot, name);
		if (existsSync(dir)) {
			fail(`harness/${name} is invalid as a top-level placeholder; support-only material must live under docs/ or scripts/`);
		}
	}
	if (existsSync(join(harnessRoot, "skills", "bundled"))) {
		fail("HarnessComponentProtocol/skills/bundled is invalid; harness-native skills live at HarnessComponentProtocol/skills/<capability>/<source>/SKILL.md");
	}
	if (existsSync(join(harnessRoot, "skills", "pi", "bundled"))) {
		fail("HarnessComponentProtocol/skills/pi/bundled is retired; move skills to HarnessComponentProtocol/skills/<capability>/<source>/SKILL.md");
	}
}

function checkToolLayout() {
	const toolsRoot = join(harnessRoot, "tools");
	if (!existsSync(toolsRoot)) {
		fail("missing HarnessComponentProtocol/tools directory");
		return;
	}
	const processDir = join(toolsRoot, "process");
	if (existsSync(processDir)) {
		fail("HarnessComponentProtocol/tools/process is invalid; process-backed implementations must live under HarnessComponentProtocol/tools/<tool>/<source>/");
	}
	const supportDir = join(toolsRoot, "support");
	if (existsSync(supportDir)) {
		fail("HarnessComponentProtocol/tools/support is invalid; shared utility code must live under _magenta/utils/<source>/");
	}
	for (const name of foldedToolModuleNames) {
		const dir = join(toolsRoot, name);
		if (existsSync(dir)) {
			fail(`HarnessComponentProtocol/tools/${name} is a folded tool sub-operation; keep it under the owning tool source directory`);
		}
	}
	for (const entry of readdirSync(toolsRoot, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		if (implementationSourceNames.has(entry.name)) {
			checkRoleFile(
				join(toolsRoot, entry.name, "HcpMagnet.ts"),
				"HcpMagnet",
				`tools root source ${entry.name}`,
			);
			continue;
		}
		const descriptorPath = join(toolsRoot, entry.name, `${entry.name}.toml`);
		if (!existsSync(descriptorPath)) {
			fail(`HarnessComponentProtocol/tools/${entry.name} is not a valid tool slot; missing HarnessComponentProtocol/tools/${entry.name}/${entry.name}.toml`);
		}
		const moduleDir = join(toolsRoot, entry.name);
		for (const source of readdirSync(moduleDir, { withFileTypes: true })) {
			if (!source.isDirectory()) continue;
			const duplicateProcessTools = join(moduleDir, source.name, "process-tools");
			if (existsSync(duplicateProcessTools)) {
				fail(
					`${pathLabel(duplicateProcessTools)} duplicates the shared Magenta process runtime; ` +
						"keep the single Rust crate under _magenta/process-tools",
				);
			}
		}
	}

	for (const required of ["Cargo.toml", "Cargo.lock", "src/main.rs"]) {
		if (!existsSync(join(sharedProcessToolsRoot, required))) {
			fail(`missing shared Magenta process runtime file: ${pathLabel(join(sharedProcessToolsRoot, required))}`);
		}
	}
	for (const manifestPath of collectFiles(toolsRoot, (candidate) => candidate.name.endsWith(".toml"))) {
		const command = readToml(manifestPath).command;
		if (typeof command !== "string" || !command.includes("magenta-process-tools")) continue;
		if (command !== sharedProcessToolsCommand) {
			fail(
				`${pathLabel(manifestPath)} must use the shared Magenta process runtime command ${sharedProcessToolsCommand}`,
			);
		}
	}
}

function sourceFile(source, fileName) {
	return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
}

export function hasNamedClassExport(source, className, fileName = `${className}.ts`) {
	const file = sourceFile(source, fileName);
	return file.statements.some((statement) => {
		if (!ts.isClassDeclaration(statement) || statement.name?.text !== className) return false;
		const modifiers = statement.modifiers ?? [];
		const isExported = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
		const isDefault = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
		return isExported && !isDefault;
	});
}

export function inspectHcpSyntax(source, fileName = "source.ts") {
	const file = sourceFile(source, fileName);
	const forbiddenIdentifiers = new Map();
	const hcpClientConstructions = [];
	const interfaceDeclarations = [];
	const implementsClauses = [];
	const toHcpServerMembers = [];

	function location(node) {
		const position = file.getLineAndCharacterOfPosition(node.getStart(file));
		return { line: position.line + 1, column: position.character + 1 };
	}

	function visit(node) {
		if (ts.isIdentifier(node) && forbiddenHcpIdentifiers.has(node.text) && !forbiddenIdentifiers.has(node.text)) {
			forbiddenIdentifiers.set(node.text, location(node));
		}
		if (ts.isInterfaceDeclaration(node)) {
			interfaceDeclarations.push({ name: node.name.text, ...location(node) });
		}
		if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
			for (const clause of node.heritageClauses ?? []) {
				if (clause.token === ts.SyntaxKind.ImplementsKeyword) {
					implementsClauses.push({ className: node.name?.text ?? "<anonymous>", ...location(clause) });
				}
			}
		}
		if (
			(ts.isMethodDeclaration(node) ||
				ts.isPropertyDeclaration(node) ||
				ts.isGetAccessorDeclaration(node) ||
				ts.isSetAccessorDeclaration(node)) &&
			((ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && node.name.text === "toHcpServer")
		) {
			toHcpServerMembers.push(location(node.name));
		}
		if (
			ts.isNewExpression(node) &&
			((ts.isIdentifier(node.expression) && node.expression.text === "HcpClient") ||
				(ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "HcpClient"))
		) {
			hcpClientConstructions.push(location(node));
		}
		ts.forEachChild(node, visit);
	}

	visit(file);
	return {
		forbiddenIdentifiers: [...forbiddenIdentifiers].map(([name, at]) => ({ name, ...at })),
		hcpClientConstructions,
		interfaceDeclarations,
		implementsClauses,
		toHcpServerMembers,
	};
}

function checkRoleFile(filePath, className, context) {
	if (checkedRoleFiles.has(filePath)) return;
	checkedRoleFiles.add(filePath);
	if (!existsSync(filePath)) {
		fail(`${context} is missing ${pathLabel(filePath)}; expected a named export class ${className}`);
		return;
	}
	const source = readFileSync(filePath, "utf8");
	if (!hasNamedClassExport(source, className, filePath)) {
		fail(`${pathLabel(filePath)} must export named class ${className}`);
	}
}

function isTestSource(filePath) {
	const parts = relative(repoRoot, filePath).split(/[\\/]/);
	if (parts.some((part) => part === "test" || part === "tests" || part === "__tests__")) return true;
	return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(basename(filePath));
}

function collectFiles(root, predicate) {
	const files = [];

	function scan(directory) {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				if (!productionScanIgnoredDirs.has(entry.name) && !["test", "tests", "__tests__"].includes(entry.name)) {
					scan(join(directory, entry.name));
				}
				continue;
			}
			if (!entry.isFile() || !predicate(entry)) continue;
			const filePath = join(directory, entry.name);
			files.push(filePath);
		}
	}

	scan(root);
	return files;
}

function collectProductionSourceFiles(root) {
	return collectFiles(root, (entry) => /\.[cm]?[jt]sx?$/.test(entry.name)).filter(
		(filePath) => !isTestSource(filePath),
	);
}

function checkExistingRoleFiles() {
	for (const filePath of collectProductionSourceFiles(harnessRoot)) {
		if (basename(filePath) === "HcpServer.ts") checkRoleFile(filePath, "HcpServer", "HCP server role");
		if (basename(filePath) === "HcpMagnet.ts") checkRoleFile(filePath, "HcpMagnet", "HCP magnet role");
	}
}

function checkHarnessClassOnlyTypes() {
	for (const filePath of collectProductionSourceFiles(harnessRoot)) {
		const isMagnetRole = basename(filePath) === "HcpMagnet.ts";
		const source = readFileSync(filePath, "utf8");
		if (!isMagnetRole && !source.includes("interface") && !source.includes("implements")) continue;

		const inspection = inspectHcpSyntax(source, filePath);
		for (const declaration of inspection.interfaceDeclarations) {
			fail(`forbidden production interface ${declaration.name} at ${pathLabel(filePath)}:${declaration.line}`);
		}
		for (const clause of inspection.implementsClauses) {
			fail(`forbidden production implements clause on ${clause.className} at ${pathLabel(filePath)}:${clause.line}`);
		}
		if (isMagnetRole) {
			for (const member of inspection.toHcpServerMembers) {
				fail(`source HcpMagnet must not define toHcpServer at ${pathLabel(filePath)}:${member.line}`);
			}
		}
	}
}

function checkRetiredHcpLayout() {
	if (existsSync(join(harnessRoot, ".HCP", "magnet"))) {
		fail("retired HarnessComponentProtocol/.HCP/magnet directory must not exist");
	}
	if (existsSync(join(harnessRoot, ".HCP", "transport", "HcpServer.ts"))) {
		fail("HarnessComponentProtocol/.HCP/transport is infrastructure and must not own HcpServer.ts");
	}
	if (existsSync(join(harnessRoot, ".HCP", "hcp-process"))) {
		fail("HarnessComponentProtocol/.HCP/hcp-process is retired; HcpMagnetProcess is injectable transport plumbing, not a Module");
	}
}

function HcpStructureinfrastructureboundaries() {
	const generatedAssembly = resolve(harnessRoot, ".HCP", "assembly", "sources.generated.ts");
	for (const filePath of collectProductionSourceFiles(resolve(harnessRoot, ".HCP"))) {
		if (filePath === generatedAssembly) continue;
		const source = readFileSync(filePath, "utf8");
		if (/\bfrom\s+["'][^"']*\/Hcp(?:Server|Magnet)\.ts["']/.test(source)) {
			fail(
				`${pathLabel(filePath)} directly imports a concrete HCP role; ` +
					"only .HCP/assembly/sources.generated.ts may import HcpServer.ts or HcpMagnet.ts",
			);
		}
	}

	for (const filePath of collectFiles(
		resolve(harnessRoot, "_magenta"),
		(entry) => entry.name.endsWith(".toml") && entry.name !== "Cargo.toml",
	)) {
		fail(`${pathLabel(filePath)} must not exist; _magenta is host support code, not a Harness Module registry`);
	}

	for (const root of infrastructureRoots) {
		for (const role of ["HcpServer.ts", "HcpMagnet.ts"]) {
			for (const filePath of collectFiles(root, (entry) => entry.name === role)) {
				fail(`${pathLabel(filePath)} must not exist; HCP infrastructure cannot own ${role}`);
			}
		}
	}
}

function checkHcpFinalState() {
	for (const filePath of collectProductionSourceFiles(repoRoot)) {
		if (basename(filePath) === "magnet.ts") {
			fail(`retired production role file ${pathLabel(filePath)} must be named HcpMagnet.ts`);
		}

		const source = readFileSync(filePath, "utf8");
		if (![...forbiddenHcpIdentifiers, "HcpClient"].some((identifier) => source.includes(identifier))) continue;
		const inspection = inspectHcpSyntax(source, filePath);
		for (const identifier of inspection.forbiddenIdentifiers) {
			fail(`forbidden production identifier ${identifier.name} at ${pathLabel(filePath)}:${identifier.line}`);
		}
		if (filePath !== allowedHcpClientConstructor) {
			for (const construction of inspection.hcpClientConstructions) {
				fail(
					`new HcpClient() is only allowed in HarnessComponentProtocol/.HCP/assembly/session-hcp.ts; ` +
						`found ${pathLabel(filePath)}:${construction.line}`,
				);
			}
		}
	}
}

function checkGeneratedNoise() {
	const generated = [
		join(harnessRoot, "dist"),
		join(harnessRoot, "node_modules"),
		join(harnessRoot, "memory", "dist"),
	];
	generated.push(join(sharedProcessToolsRoot, "target"));
	for (const path of generated) {
		if (existsSync(path)) {
			const stat = statSync(path);
			if (stat.isDirectory()) note(`local generated directory present and ignored by structure check: ${pathLabel(path)}`);
		}
	}
}

function checkHcpCoreFiles() {
	const hcpClientFiles = [
		join(harnessRoot, "HcpClient.ts"),
		join(harnessRoot, ".HCP", "HcpServerTypes.ts"),
		join(harnessRoot, ".HCP", "HcpMagnetTypes.ts"),
	];

	for (const filePath of hcpClientFiles) {
		if (!existsSync(filePath)) {
			fail(`expected HCP core file missing: ${pathLabel(filePath)}`);
		}
	}
}

export function runStructureCheck() {
	checkTopLevel();
	checkReadmes();
	checkRegistry();
	checkCapabilityDescriptors();
	checkCapabilityModuleRoles();
	checkExistingRoleFiles();
	checkHarnessClassOnlyTypes();
	checkRetiredHcpLayout();
	HcpStructureinfrastructureboundaries();
	checkPackageBoundary();
	checkSupportLayout();
	checkToolLayout();
	checkHcpCoreFiles();
	checkHcpFinalState();
	checkGeneratedNoise();

	for (const message of notes) console.log(`note: ${message}`);
	for (const message of warnings) console.warn(`warning: ${message}`);

	if (failures.length > 0) {
		console.error("Harness structure check failed:");
		for (const message of failures) console.error(`  - ${message}`);
		return false;
	}

	console.log("Harness structure check passed.");
	return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (!runStructureCheck()) process.exitCode = 1;
}
