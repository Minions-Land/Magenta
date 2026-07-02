import { existsSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { harnessRoot, isInside, pathLabel, readJson, readToml, repoRoot } from "./lib/files.mjs";

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

function loadRegistryInspect() {
	const indexPath = join(harnessRoot, "harness.toml");
	const index = readToml(indexPath);
	const componentRefs = asArray(index.components);
	const catalogRefs = asArray(index.catalogs);
	const diagnostics = [];

	const components = componentRefs.map((ref) => {
		const componentPath = resolvePath(harnessRoot, ref.path);
		let spec = {};
		if (!componentPath || !existsSync(componentPath)) {
			diagnostics.push({ type: "error", message: `missing component file for ${ref.kind}:${ref.name}`, path: componentPath });
		} else {
			spec = readToml(componentPath);
		}
		return {
			kind: spec.kind ?? ref.kind,
			name: spec.name ?? ref.name,
			description: spec.description ?? ref.description,
			path: componentPath ? pathLabel(componentPath) : undefined,
		};
	});

	const catalogs = catalogRefs.map((ref) => {
		const catalogPath = resolvePath(harnessRoot, ref.path);
		if (!catalogPath || !existsSync(catalogPath)) {
			diagnostics.push({ type: "error", message: `missing catalog file for ${ref.name}`, path: catalogPath });
			return { name: ref.name, path: catalogPath ? pathLabel(catalogPath) : undefined };
		}

		const spec = readToml(catalogPath);
		const catalogDir = dirname(catalogPath);
		const inventoryPath = resolvePath(catalogDir, spec.inventory?.path);
		const integrationPath = resolvePath(catalogDir, spec.integration?.path);
		const inventory = inventoryPath && existsSync(inventoryPath) ? readJson(inventoryPath) : undefined;
		const integration = integrationPath && existsSync(integrationPath) ? readJson(integrationPath) : undefined;
		if (!inventory) diagnostics.push({ type: "error", message: `missing catalog inventory for ${ref.name}`, path: inventoryPath });

		const integrationEntries = Object.values(integration?.entries ?? {});
		const inventoryComponents = flattenInventoryComponents(inventory);
		return {
			name: spec.name ?? ref.name,
			description: spec.description ?? ref.description,
			path: pathLabel(catalogPath),
			inventory: inventoryPath
				? {
						path: pathLabel(inventoryPath),
						componentCount: inventory?.summary?.component_count ?? inventoryComponents.length,
						moduleCount: inventory?.summary?.module_count ?? Object.keys(inventory?.modules ?? {}).length,
						byKind: inventory?.summary?.by_kind ?? countBy(inventoryComponents, (component) => component.kind),
					}
				: undefined,
			integration: integrationPath
				? {
						path: pathLabel(integrationPath),
						entryCount: integrationEntries.length,
						byState: countBy(integrationEntries, (entry) => entry.state),
					}
				: undefined,
		};
	});

	return {
		name: index.name,
		description: index.description,
		componentCount: components.length,
		componentsByKind: countBy(components, (component) => component.kind),
		components,
		catalogs,
		diagnostics,
	};
}

function flattenInventoryComponents(inventory) {
	const modules = asObject(inventory?.modules);
	if (!modules) return [];
	return Object.values(modules).flatMap((module) => asArray(module.components));
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
		const profiles = asArray(manifest.profiles).map((profile) =>
			loadPackageProfile({ packageDir, packageId: manifest.id ?? entry.name, profile, diagnostics }),
		);
		const allComponents = [...rootComponents, ...profiles.flatMap((profile) => profile.components)].filter(Boolean);
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

function loadPackageProfile({ packageDir, packageId, profile, diagnostics }) {
	const profileName = profile.name ?? "<unnamed>";
	const harnessPath = resolvePath(packageDir, profile.harness);
	if (!harnessPath) {
		diagnostics.push({ type: "warning", packageId, profile: profileName, message: "profile has no harness path" });
		return { name: profileName, description: profile.description, path: undefined, components: [] };
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
		path: resolvedPath ? pathLabel(resolvedPath) : undefined,
		absPath: resolvedPath,
		sourcePath: pathLabel(sourcePath),
	};
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
	console.log(`Harness inspect: ${report.registry.name ?? "unnamed"}`);
	console.log(`Components: ${report.registry.componentCount} (${formatCounts(report.registry.componentsByKind)})`);
	if (report.registry.catalogs.length > 0) {
		console.log("Catalogs:");
		for (const catalog of report.registry.catalogs) {
			const inventory = catalog.inventory;
			const integration = catalog.integration;
			console.log(
				`  - ${catalog.name}: ${inventory?.componentCount ?? 0} entries, ${inventory?.moduleCount ?? 0} modules` +
					(integration ? `; migration ${formatCounts(integration.byState)}` : ""),
			);
		}
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

	const diagnostics = [...report.registry.diagnostics, ...report.packages.diagnostics];
	if (diagnostics.length > 0) {
		console.log("Diagnostics:");
		for (const diagnostic of diagnostics) {
			console.log(`  - ${diagnostic.type}: ${diagnostic.message}${diagnostic.path ? ` (${pathLabel(diagnostic.path)})` : ""}`);
		}
	}
}

const report = {
	registry: loadRegistryInspect(),
	packages: loadPackagesInspect(),
};

if (jsonOutput) {
	console.log(JSON.stringify(report, null, 2));
} else {
	printHuman(report);
}
