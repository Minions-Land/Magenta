import { existsSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { collectHcpSources } from "./generate-hcp-sources.mjs";
import { isInside, pathLabel, readToml, repoRoot } from "./lib/files.mjs";

const args = process.argv.slice(2);
const jsonOutput = args.includes("--json");
const scriptRuntimeNames = new Set(["shell", "python", "node", "r", "julia"]);

function asArray(value) {
	return Array.isArray(value) ? value : [];
}

function asObject(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function countBy(items, keyFn) {
	const counts = {};
	for (const item of items) {
		const key = keyFn(item) ?? "unknown";
		counts[key] = (counts[key] ?? 0) + 1;
	}
	return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function resolvePath(baseDir, ref) {
	if (typeof ref !== "string" || !ref) return undefined;
	return isAbsolute(ref) ? resolve(ref) : resolve(baseDir, ref);
}

function loadHcpInspect() {
	const collected = collectHcpSources();
	const harness = readToml(collected.harnessTomlPath);
	const components = collected.entries.map((entry) => ({
		module: entry.module,
		kind: entry.kind,
		name: entry.name,
		product: entry.product,
		source: entry.source,
		selected: entry.selected,
		autoload: entry.autoload,
		hotSwappable: entry.hotSwappable,
		descriptorPath: entry.descriptorPath,
		...(entry.slot === undefined ? {} : { slot: entry.slot }),
		requires: entry.requires,
		HcpMagnet: pathLabel(entry.path),
	}));
	const componentsByModule = new Map();
	for (const component of components) {
		const moduleComponents = componentsByModule.get(component.module) ?? [];
		moduleComponents.push(component);
		componentsByModule.set(component.module, moduleComponents);
	}
	const modules = collected.servers.map((server) => ({
		name: server.module,
		HcpServer: pathLabel(server.path),
		components: componentsByModule.get(server.module) ?? [],
	}));

	return {
		name: harness.name,
		description: harness.description,
		harnessToml: pathLabel(collected.harnessTomlPath),
		HcpServerCount: collected.servers.length,
		HcpMagnetClassCount: collected.magnets.length,
		componentCount: components.length,
		selectedComponentCount: components.filter((component) => component.selected).length,
		componentsByKind: countBy(components, (component) => component.kind),
		componentsByProduct: countBy(components, (component) => component.product),
		componentsBySource: countBy(components, (component) => component.source),
		components,
		modules,
	};
}

function parseComponents(table) {
	const raw = table.components;
	if (Array.isArray(raw)) {
		return raw.filter((entry) => asObject(entry)).map((entry) => ({ ...entry }));
	}
	if (asObject(raw)) {
		return Object.entries(raw).flatMap(([kind, entries]) =>
			asArray(entries)
				.filter((entry) => asObject(entry))
				.map((entry) => ({ ...entry, kind: entry.kind ?? kind })),
		);
	}
	return [];
}

function loadPackagesInspect() {
	const packagesRoot = join(repoRoot, "packages");
	const diagnostics = [];
	const packages = [];
	if (!existsSync(packagesRoot)) {
		return { root: pathLabel(packagesRoot), packages, diagnostics: [{ type: "warning", message: "packages root missing" }] };
	}

	for (const entry of readdirSync(packagesRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "templates") continue;
		const packageDir = join(packagesRoot, entry.name);
		const manifestPath = join(packageDir, "package.toml");
		if (!existsSync(manifestPath)) continue;
		const manifest = readToml(manifestPath);
		const rootComponents = parseComponents(manifest).map((component) =>
			resolvePackageComponent(component, packageDir, packageDir, manifestPath, diagnostics),
		);
		const allProfiles = asArray(manifest.profiles);
		const profiles = allProfiles.map((profile) =>
			loadPackageProfile({ packageDir, packageId: manifest.id ?? entry.name, profile, diagnostics, allProfiles, rootComponents }),
		);
		// Only additive (harness sub-manifest) profiles contribute NEW components; tag-based
		// profiles are views into rootComponents and would double-count if re-added.
		const allComponents = [
			...rootComponents,
			...profiles.filter((profile) => profile.additive).flatMap((profile) => profile.components),
		].filter(Boolean);
		const runtimeKeys = new Set(allComponents.map((component) => `${component.kind}:${component.name}`));
		const tools = allComponents
			.filter((component) => component.kind === "tool")
			.map((component) => classifyPackageTool(component, runtimeKeys, diagnostics));

		packages.push({
			id: manifest.id ?? entry.name,
			name: manifest.name ?? manifest.id ?? entry.name,
			kind: manifest.kind,
			domain: manifest.domain,
			path: pathLabel(manifestPath),
			defaultProfiles: asArray(manifest.default_profiles),
			profileCount: profiles.length,
			profiles: profiles.map((profile) => ({
				name: profile.name,
				description: profile.description,
				path: profile.path,
				componentCount: profile.components.length,
				componentsByKind: countBy(profile.components, (component) => component.kind),
			})),
			componentCount: allComponents.length,
			componentsByKind: countBy(allComponents, (component) => component.kind),
			tools,
		});
	}

	return { root: pathLabel(packagesRoot), packages, diagnostics };
}

function loadPackageProfile({ packageDir, packageId, profile, diagnostics, allProfiles = [], rootComponents = [] }) {
	const profileName = profile.name ?? "<unnamed>";
	if (!profile.harness) {
		// Tag-based profile: its members are the root components whose `profiles` tag falls in
		// this profile's extends-closure (mirrors componentMatchesProfiles in package-overlay.ts).
		// These are a VIEW into rootComponents (additive:false) — not extra components — so they
		// must not be re-added to the package's allComponents total.
		const closure = profileClosure(profileName, allProfiles);
		const components = rootComponents
			.filter(Boolean)
			.filter((component) => asArray(component.profiles).some((tag) => closure.has(tag)));
		if (components.length === 0) {
			diagnostics.push({
				type: "warning",
				packageId,
				profile: profileName,
				message: "profile gates no components (no harness sub-manifest and no tagged root components)",
			});
		}
		return { name: profileName, description: profile.description, path: undefined, components, additive: false };
	}
	const harnessPath = resolvePath(packageDir, profile.harness);
	if (!harnessPath) {
		diagnostics.push({ type: "warning", packageId, profile: profileName, message: "profile has no harness path" });
		return { name: profileName, description: profile.description, path: undefined, components: [], additive: true };
	}
	if (!isInside(packageDir, harnessPath)) {
		diagnostics.push({ type: "error", packageId, profile: profileName, message: `profile harness escapes package: ${profile.harness}` });
		return { name: profileName, description: profile.description, path: pathLabel(harnessPath), components: [] };
	}
	if (!existsSync(harnessPath)) {
		diagnostics.push({ type: "error", packageId, profile: profileName, message: "profile harness is missing", path: harnessPath });
		return { name: profileName, description: profile.description, path: pathLabel(harnessPath), components: [] };
	}
	const table = readToml(harnessPath);
	const components = parseComponents(table)
		.map((component) => resolvePackageComponent(component, packageDir, dirname(harnessPath), harnessPath, diagnostics, profileName))
		.filter(Boolean);
	return {
		name: profileName,
		description: profile.description,
		path: pathLabel(harnessPath),
		components,
		additive: true,
	};
}

function resolvePackageComponent(component, packageDir, baseDir, sourcePath, diagnostics, profile) {
	const resolvedPath = component.path ? resolvePath(baseDir, component.path) : undefined;
	if (resolvedPath && !isInside(packageDir, resolvedPath)) {
		diagnostics.push({
			type: "error",
			profile,
			message: `component ${component.kind}:${component.name} escapes package`,
			path: pathLabel(resolvedPath),
		});
		return undefined;
	}
	if (resolvedPath && !existsSync(resolvedPath)) {
		diagnostics.push({
			type: "error",
			profile,
			message: `component ${component.kind}:${component.name} path is missing`,
			path: pathLabel(resolvedPath),
		});
	}
	return {
		kind: component.kind,
		name: component.name,
		description: component.description,
		profile,
		profiles: asArray(component.profiles),
		path: resolvedPath ? pathLabel(resolvedPath) : undefined,
		absPath: resolvedPath,
		sourcePath: pathLabel(sourcePath),
	};
}

/** Transitive `extends` closure of a profile — mirrors expandProfileClosure in package-overlay.ts. */
function profileClosure(profileName, allProfiles) {
	const closure = new Set();
	const visit = (name) => {
		if (closure.has(name)) return;
		closure.add(name);
		const parent = allProfiles.find((candidate) => (candidate.name ?? "") === name);
		for (const grandparent of asArray(parent?.extends)) visit(grandparent);
	};
	visit(profileName);
	return closure;
}

function classifyPackageTool(component, runtimeKeys, diagnostics) {
	if (!component.absPath || !existsSync(component.absPath)) {
		return { ...toolSummary(component), executable: false, reason: "descriptor_missing" };
	}
	const descriptor = readToml(component.absPath);
	const runtime = descriptor.runtime ?? descriptor.magnet ?? descriptor.kind;
	const summary = {
		...toolSummary(component),
		runtime,
		operation: descriptor.operation,
		readOnly: descriptor.read_only === true,
		destructive: descriptor.destructive === true,
	};

	if (descriptor.execution === "declarative") {
		return { ...summary, executable: false, adapter: "declarative", reason: "declarative_descriptor" };
	}
	if (!runtime) {
		diagnostics.push({ type: "error", message: `tool ${component.name} has no runtime`, path: component.path });
		return { ...summary, executable: false, reason: "runtime_missing" };
	}
	if (runtime === "process") {
		return { ...summary, executable: Boolean(descriptor.command), adapter: "process", reason: descriptor.command ? undefined : "command_missing" };
	}
	if (runtime === "mcp") {
		const command = descriptor.command;
		if (typeof command !== "string" || command.length === 0) {
			return { ...summary, executable: false, adapter: "mcp", reason: "command_missing" };
		}
		// Mirror resolveMcpCommand: absolute stays, a path resolves against the
		// repo root, a bare name is looked up on PATH at spawn time. We can only
		// verify on-disk presence for the first two; a bare name is assumed
		// resolvable and reported executable.
		const isPath = command.includes("/") || command.includes("\\");
		const resolved = isPath ? resolve(repoRoot, command) : command;
		const present = !isPath || existsSync(resolved);
		return {
			...summary,
			executable: present,
			adapter: "mcp",
			reason: present ? undefined : "mcp_binary_missing",
		};
	}
	const runtimeName = typeof runtime === "string" && runtime.startsWith("runtime://") ? runtime.slice("runtime://".length) : runtime;
	if (scriptRuntimeNames.has(runtimeName)) {
		const hasCode = typeof descriptor.code === "string" || typeof descriptor.script === "string";
		const scriptPath = descriptor.script_path ?? descriptor.scriptPath;
		const hasScriptPath = typeof scriptPath === "string" && existsSync(resolve(dirname(component.absPath), scriptPath));
		return {
			...summary,
			executable: hasCode || hasScriptPath,
			adapter: `script:${runtimeName}`,
			reason: hasCode || hasScriptPath ? undefined : "script_missing",
		};
	}
	if (runtimeKeys.has(`python-runtime:${runtime}`)) {
		return { ...summary, executable: true, adapter: "python-runtime" };
	}
	if (runtimeKeys.has(`runtime:${runtime}`) || runtimeKeys.has(`process-runtime:${runtime}`)) {
		return { ...summary, executable: false, adapter: "runtime", reason: "runtime_adapter_not_supported" };
	}
	return { ...summary, executable: false, reason: "runtime_component_missing" };
}

function toolSummary(component) {
	return {
		name: component.name,
		profile: component.profile,
		description: component.description,
		path: component.path,
	};
}

function formatCounts(counts) {
	return Object.entries(counts)
		.map(([key, count]) => `${key}:${count}`)
		.join(", ");
}

function printHuman(report) {
	console.log(`Harness inspect: ${report.hcp.name ?? "unnamed"}`);
	console.log(`HcpServers: ${report.hcp.HcpServerCount}`);
	console.log(`HcpMagnet classes: ${report.hcp.HcpMagnetClassCount}`);
	console.log(
		`Components: ${report.hcp.componentCount} (${formatCounts(report.hcp.componentsByKind)}); ` +
			`${report.hcp.selectedComponentCount} selected`,
	);
	console.log("Modules:");
	for (const module of report.hcp.modules) {
		const sources = [...new Set(module.components.map((component) => component.source))].join(", ") || "none";
		console.log(`  - ${module.name}: ${module.components.length} component rows; Sources ${sources}; HcpServer ${module.HcpServer}`);
	}

	console.log(`Packages root: ${report.packages.root}`);
	if (report.packages.packages.length === 0) {
		console.log("Packages: none");
	} else {
		console.log("Packages:");
		for (const pkg of report.packages.packages) {
			console.log(
				`  - ${pkg.id}: ${pkg.componentCount} components (${formatCounts(pkg.componentsByKind)}); default profiles ${pkg.defaultProfiles.join(", ") || "none"}`,
			);
			for (const profile of pkg.profiles) {
				console.log(`      profile ${profile.name}: ${profile.componentCount} components (${formatCounts(profile.componentsByKind)})`);
			}
			for (const tool of pkg.tools) {
				const state = tool.executable ? `executable via ${tool.adapter}` : `not executable: ${tool.reason}`;
				console.log(`      tool ${tool.name}${tool.profile ? ` [${tool.profile}]` : ""}: ${state}`);
			}
		}
	}

	const diagnostics = report.packages.diagnostics;
	if (diagnostics.length > 0) {
		console.log("Diagnostics:");
		for (const diagnostic of diagnostics) {
			console.log(`  - ${diagnostic.type}: ${diagnostic.message}${diagnostic.path ? ` (${pathLabel(diagnostic.path)})` : ""}`);
		}
	}
}

const report = {
	hcp: loadHcpInspect(),
	packages: loadPackagesInspect(),
};

if (jsonOutput) {
	console.log(JSON.stringify(report, null, 2));
} else {
	printHuman(report);
}
