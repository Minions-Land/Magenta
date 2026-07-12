import { existsSync, realpathSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { parseToml, type TomlTable, type TomlValue } from "../utils/pi/toml.ts";
import type { HcpClientpackagetooldiagnosticcode } from "./tool-diagnostic.ts";

export const HcpClientpackagemanifestfilev1 = "package.toml";
export const HcpClientpackageschemaversionv1 = "magenta.package.v1";

export type HcpClientharnesspackagekindv1 = "domain" | "brand" | "harness" | string;

export type HcpClientpackagev1diagnosticcode =
	| "packages_root_missing"
	| "package_manifest_missing"
	| "package_manifest_read_failed"
	| "package_manifest_invalid"
	| "package_profile_missing"
	| "package_profile_cycle"
	| "package_harness_missing"
	| "package_harness_read_failed"
	| "package_harness_invalid"
	| "package_component_missing"
	| "package_component_invalid"
	| "package_bundle_invalid"
	| "package_bundle_target_missing"
	| "package_bundle_applied"
	| "package_bundle_conflict"
	| HcpClientpackagetooldiagnosticcode;

export type HcpClientpackagev1diagnostic = {
	type: "warning" | "error";
	code: HcpClientpackagev1diagnosticcode;
	message: string;
	path?: string;
	packageId?: string;
	profile?: string;
};

export type HcpClientharnesspackageprofilev1 = {
	name: string;
	description?: string;
	extends: string[];
	harness?: string;
};

export type HcpClientharnesspackagemanifestv1 = {
	schemaVersion?: string;
	id: string;
	name: string;
	description?: string;
	kind?: HcpClientharnesspackagekindv1;
	domain?: string;
	defaultProfiles: string[];
	profiles: HcpClientharnesspackageprofilev1[];
	components: HcpClientpackagecomponentrefv1[];
	raw: TomlTable;
};

export type HcpClientharnesspackagev1 = {
	id: string;
	dir: string;
	manifestPath: string;
	manifest: HcpClientharnesspackagemanifestv1;
	diagnostics: HcpClientpackagev1diagnostic[];
};

export type HcpClientpackagecomponentrefv1 = {
	kind: string;
	name: string;
	description?: string;
	path?: string;
	includeInContext?: boolean;
	source?: string;
	/**
	 * Profile tags gating this root component. Empty/absent = untagged = a
	 * package-wide essential that always loads. When non-empty, the component
	 * loads only if a tag intersects the selected profile closure (see
	 * {@link HcpClientlegacycomponentmatchesprofiles}).
	 */
	profiles?: string[];
	bundles: HcpClientpackagecomponentbundlev1[];
	raw: TomlTable;
};

export type HcpClientpackageresolvedcomponentv1 = HcpClientpackagecomponentrefv1 & {
	packageId: string;
	packageDir: string;
	profile?: string;
	key: string;
	baseDir: string;
	path?: string;
	sourcePath: string;
};

export type HcpClientpackagecomponentbundlev1 = {
	kind: string;
	name?: string;
	source: string;
	raw: string;
};

export type HcpClientpackagecomponentoverridev1 = {
	key: string;
	replaced: HcpClientpackageresolvedcomponentv1;
	replacement: HcpClientpackageresolvedcomponentv1;
};

export type HcpClientpackageprofileselectionv1 = {
	packageId: string;
	profiles?: string[];
};

export type HcpClientpackageoverlayv1 = {
	repoRoot: string;
	packagesRoot: string;
	selections: HcpClientpackageprofileselectionv1[];
	packages: HcpClientharnesspackagev1[];
	components: HcpClientpackageresolvedcomponentv1[];
	componentMap: Map<string, HcpClientpackageresolvedcomponentv1>;
	overrides: HcpClientpackagecomponentoverridev1[];
	diagnostics: HcpClientpackagev1diagnostic[];
};

/**
 * Progress reading emitted while the session assembler walks package entries.
 * `index` is 0-based and `total` is the selected component count.
 */
export type HcpClientpackageassemblyprogressv1 = {
	phase: "start" | "assembled";
	index: number;
	total: number;
	component: HcpClientpackageresolvedcomponentv1;
};

export type HcpClientdiscoverharnesspackagesresultv1 = {
	repoRoot: string;
	packagesRoot: string;
	packages: HcpClientharnesspackagev1[];
	diagnostics: HcpClientpackagev1diagnostic[];
};

export type HcpClientdiscoverharnesspackagesoptionsv1 = {
	repoRoot?: string;
	packagesRoot?: string;
};

export type HcpClientloadpackageoverlayoptionsv1 = {
	repoRoot?: string;
	packagesRoot?: string;
	selections: Array<string | HcpClientpackageprofileselectionv1>;
	includeDefaultProfiles?: boolean;
};

type HcpClientloadedprofilev1 = {
	name: string;
	components: HcpClientpackageresolvedcomponentv1[];
	diagnostics: HcpClientpackagev1diagnostic[];
};

export function HcpClientgetharnesspackagesrootv1(repoRoot: string = process.cwd()): string {
	return resolve(repoRoot, "packages");
}

export function HcpClientparsepackageselectorv1(selector: string): HcpClientpackageprofileselectionv1 {
	const trimmed = selector.trim();
	const separator = trimmed.indexOf(":");
	if (separator === -1) return { packageId: trimmed };
	const packageId = trimmed.slice(0, separator).trim();
	const profiles = trimmed
		.slice(separator + 1)
		.split(",")
		.map((profile) => profile.trim())
		.filter(Boolean);
	return profiles.length > 0 ? { packageId, profiles } : { packageId };
}

export async function HcpClientdiscoverharnesspackagesv1(
	options: HcpClientdiscoverharnesspackagesoptionsv1 = {},
): Promise<HcpClientdiscoverharnesspackagesresultv1> {
	const repoRoot = resolve(options.repoRoot ?? process.cwd());
	const root = resolve(options.packagesRoot ?? HcpClientgetharnesspackagesrootv1(repoRoot));
	const diagnostics: HcpClientpackagev1diagnostic[] = [];
	const packages: HcpClientharnesspackagev1[] = [];

	const rootInfo = await HcpClientlegacystatifexists(root);
	if (!rootInfo) {
		diagnostics.push({
			type: "warning",
			code: "packages_root_missing",
			message: `Packages root does not exist: ${root}`,
			path: root,
		});
		return { repoRoot, packagesRoot: root, packages, diagnostics };
	}
	if (!rootInfo.isDirectory()) {
		diagnostics.push({
			type: "error",
			code: "packages_root_missing",
			message: `Packages root is not a directory: ${root}`,
			path: root,
		});
		return { repoRoot, packagesRoot: root, packages, diagnostics };
	}

	for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		const manifestPath = resolve(root, entry.name, HcpClientpackagemanifestfilev1);
		if (!existsSync(manifestPath)) continue;
		const loaded = await HcpClientloadharnesspackagemanifestv1(manifestPath);
		packages.push(loaded.package);
		diagnostics.push(...loaded.package.diagnostics);
	}

	return { repoRoot, packagesRoot: root, packages, diagnostics };
}

async function HcpClientloadharnesspackagemanifestv1(
	manifestPath: string,
): Promise<{ package: HcpClientharnesspackagev1; diagnostics: HcpClientpackagev1diagnostic[] }> {
	const resolvedManifestPath = resolve(manifestPath);
	const packageDir = dirname(resolvedManifestPath);
	const fallbackId = basename(packageDir);
	const diagnostics: HcpClientpackagev1diagnostic[] = [];
	let raw: TomlTable = {};

	try {
		raw = parseToml(await readFile(resolvedManifestPath, "utf-8"));
	} catch (error) {
		diagnostics.push({
			type: "error",
			code: "package_manifest_read_failed",
			message: `Unable to read package manifest ${resolvedManifestPath}: ${HcpClientlegacyformatunknownerror(error)}`,
			path: resolvedManifestPath,
		});
	}

	const id = HcpClientlegacyasstring(raw.id) ?? fallbackId;
	const name = HcpClientlegacyasstring(raw.name) ?? id;
	const manifest: HcpClientharnesspackagemanifestv1 = {
		schemaVersion: HcpClientlegacyasstring(raw.schema_version),
		id,
		name,
		description: HcpClientlegacyasstring(raw.description),
		kind: HcpClientlegacyasstring(raw.kind),
		domain: HcpClientlegacyasstring(raw.domain),
		defaultProfiles: HcpClientlegacyasstringarray(raw.default_profiles),
		profiles: HcpClientlegacyparseprofiles(raw.profiles, resolvedManifestPath, id, diagnostics),
		components: HcpClientlegacyparsecomponents(raw, id, undefined, resolvedManifestPath, diagnostics),
		raw,
	};

	if (!manifest.id) {
		diagnostics.push({
			type: "error",
			code: "package_manifest_invalid",
			message: "Package manifest must declare id or live in a named package directory.",
			path: resolvedManifestPath,
			packageId: id,
		});
	}
	if (manifest.schemaVersion && manifest.schemaVersion !== HcpClientpackageschemaversionv1) {
		diagnostics.push({
			type: "warning",
			code: "package_manifest_invalid",
			message: `Unsupported package schema_version ${manifest.schemaVersion}; expected ${HcpClientpackageschemaversionv1}.`,
			path: resolvedManifestPath,
			packageId: id,
		});
	}

	const loadedPackage = {
		id,
		dir: packageDir,
		manifestPath: resolvedManifestPath,
		manifest,
		diagnostics,
	};
	return { package: loadedPackage, diagnostics };
}

export async function HcpClientloadpackageoverlayv1(
	options: HcpClientloadpackageoverlayoptionsv1,
): Promise<HcpClientpackageoverlayv1> {
	const repoRoot = resolve(options.repoRoot ?? process.cwd());
	const packagesRoot = resolve(options.packagesRoot ?? HcpClientgetharnesspackagesrootv1(repoRoot));
	const includeDefaultProfiles = options.includeDefaultProfiles ?? true;
	const discovery = await HcpClientdiscoverharnesspackagesv1({ repoRoot, packagesRoot });
	const packageMap = new Map(discovery.packages.map((pkg) => [pkg.id, pkg]));
	const selections = options.selections.map((selection) =>
		typeof selection === "string" ? HcpClientparsepackageselectorv1(selection) : selection,
	);
	const diagnostics: HcpClientpackagev1diagnostic[] = [...discovery.diagnostics];
	const selectedPackages: HcpClientharnesspackagev1[] = [];
	const components: HcpClientpackageresolvedcomponentv1[] = [];

	for (const selection of selections) {
		const pkg = packageMap.get(selection.packageId);
		if (!pkg) {
			diagnostics.push({
				type: "error",
				code: "package_manifest_missing",
				message: `Selected package was not found: ${selection.packageId}`,
				path: resolve(packagesRoot, selection.packageId, HcpClientpackagemanifestfilev1),
				packageId: selection.packageId,
			});
			continue;
		}

		selectedPackages.push(pkg);
		const profileNames = HcpClientlegacyresolveselectedprofilenames(pkg, selection.profiles, includeDefaultProfiles);
		const selectedProfileClosure = HcpClientlegacyexpandprofileclosure(pkg, profileNames);
		components.push(...HcpClientlegacyresolvepackagerootcomponents(pkg, selectedProfileClosure, diagnostics));
		const loadedProfiles = new Set<string>();

		for (const profileName of profileNames) {
			const loaded = await HcpClientlegacyloadprofile(pkg, profileName, [], loadedProfiles);
			components.push(...loaded.components);
			diagnostics.push(...loaded.diagnostics);
		}
	}

	const { componentMap, overrides } = HcpClientlegacyoverlaycomponentmap(components);
	const resolvedComponents = await HcpClientlegacyapplycomponentbundles([...componentMap.values()], diagnostics);
	const resolvedComponentMap = new Map(resolvedComponents.map((component) => [component.key, component]));
	return {
		repoRoot,
		packagesRoot,
		selections,
		packages: selectedPackages,
		components: resolvedComponents,
		componentMap: resolvedComponentMap,
		overrides,
		diagnostics,
	};
}

function HcpClientlegacyresolveselectedprofilenames(
	pkg: HcpClientharnesspackagev1,
	selectedProfiles: string[] | undefined,
	includeDefaultProfiles: boolean,
): string[] {
	if (selectedProfiles?.includes("*") || selectedProfiles?.includes("all")) {
		return HcpClientlegacyunique(pkg.manifest.profiles.map((profile) => profile.name));
	}
	const profiles = selectedProfiles?.length ? selectedProfiles : pkg.manifest.defaultProfiles;
	return HcpClientlegacyunique([...(includeDefaultProfiles ? pkg.manifest.defaultProfiles : []), ...profiles]);
}

/**
 * Transitive `extends` closure of the selected profile names. Selecting a
 * profile pulls in every profile it extends (e.g. `all` extends the topic
 * profiles), so a component tagged with any profile in the closure matches.
 */
function HcpClientlegacyexpandprofileclosure(pkg: HcpClientharnesspackagev1, names: string[]): Set<string> {
	const closure = new Set<string>();
	const visit = (name: string): void => {
		if (closure.has(name)) return;
		closure.add(name);
		const profile = pkg.manifest.profiles.find((candidate) => candidate.name === name);
		for (const parent of profile?.extends ?? []) visit(parent);
	};
	for (const name of names) visit(name);
	return closure;
}

/**
 * A root component loads when it is untagged (a package-wide essential), or when
 * no profile narrowing is in effect (empty closure = load everything, the
 * backward-compatible default), or when one of its `profiles` tags is in the
 * selected profile closure.
 */
function HcpClientlegacycomponentmatchesprofiles(
	component: HcpClientpackagecomponentrefv1,
	closure: Set<string>,
): boolean {
	if (!component.profiles || component.profiles.length === 0) return true;
	if (closure.size === 0) return true;
	return component.profiles.some((tag) => closure.has(tag));
}

function HcpClientlegacyresolvepackagerootcomponents(
	pkg: HcpClientharnesspackagev1,
	selectedProfileClosure: Set<string>,
	diagnostics: HcpClientpackagev1diagnostic[],
): HcpClientpackageresolvedcomponentv1[] {
	return pkg.manifest.components
		.filter((component) => HcpClientlegacycomponentmatchesprofiles(component, selectedProfileClosure))
		.map((component) =>
			HcpClientlegacyresolvecomponent(component, pkg, undefined, pkg.dir, pkg.manifestPath, diagnostics),
		)
		.filter((component): component is HcpClientpackageresolvedcomponentv1 => Boolean(component));
}

async function HcpClientlegacyloadprofile(
	pkg: HcpClientharnesspackagev1,
	profileName: string,
	stack: string[],
	loadedProfiles: Set<string>,
): Promise<HcpClientloadedprofilev1> {
	if (loadedProfiles.has(profileName)) return { name: profileName, components: [], diagnostics: [] };
	const diagnostics: HcpClientpackagev1diagnostic[] = [];
	const profile = pkg.manifest.profiles.find((candidate) => candidate.name === profileName);
	if (!profile) {
		return {
			name: profileName,
			components: [],
			diagnostics: [
				{
					type: "error",
					code: "package_profile_missing",
					message: `Package ${pkg.id} does not declare profile ${profileName}.`,
					path: pkg.manifestPath,
					packageId: pkg.id,
					profile: profileName,
				},
			],
		};
	}
	if (stack.includes(profileName)) {
		return {
			name: profileName,
			components: [],
			diagnostics: [
				{
					type: "error",
					code: "package_profile_cycle",
					message: `Package ${pkg.id} has cyclic profile inheritance: ${[...stack, profileName].join(" -> ")}.`,
					path: pkg.manifestPath,
					packageId: pkg.id,
					profile: profileName,
				},
			],
		};
	}

	const components: HcpClientpackageresolvedcomponentv1[] = [];
	for (const parentProfile of profile.extends) {
		const loaded = await HcpClientlegacyloadprofile(pkg, parentProfile, [...stack, profileName], loadedProfiles);
		components.push(...loaded.components);
		diagnostics.push(...loaded.diagnostics);
	}

	if (!profile.harness) {
		loadedProfiles.add(profileName);
		return { name: profileName, components, diagnostics };
	}

	const harnessPath = HcpClientlegacyresolvepackagelocalreference({
		reference: profile.harness,
		packageDir: pkg.dir,
		baseDir: pkg.dir,
		sourcePath: pkg.manifestPath,
		packageId: pkg.id,
		profile: profileName,
		diagnostics,
		invalidCode: "package_harness_invalid",
		referenceKind: "profile harness",
	});
	if (!harnessPath) return { name: profileName, components, diagnostics };

	const info = await HcpClientlegacystatifexists(harnessPath);
	if (!info || !info.isFile()) {
		diagnostics.push({
			type: "error",
			code: "package_harness_missing",
			message: `Package ${pkg.id} profile ${profileName} harness file is missing: ${harnessPath}`,
			path: harnessPath,
			packageId: pkg.id,
			profile: profileName,
		});
		return { name: profileName, components, diagnostics };
	}

	let table: TomlTable;
	try {
		table = parseToml(await readFile(harnessPath, "utf-8"));
	} catch (error) {
		diagnostics.push({
			type: "error",
			code: "package_harness_read_failed",
			message: `Unable to read package harness ${harnessPath}: ${HcpClientlegacyformatunknownerror(error)}`,
			path: harnessPath,
			packageId: pkg.id,
			profile: profileName,
		});
		return { name: profileName, components, diagnostics };
	}

	const refs = HcpClientlegacyparsecomponents(table, pkg.id, profileName, harnessPath, diagnostics);
	for (const ref of refs) {
		const component = HcpClientlegacyresolvecomponent(
			ref,
			pkg,
			profileName,
			dirname(harnessPath),
			harnessPath,
			diagnostics,
		);
		if (component) components.push(component);
	}
	loadedProfiles.add(profileName);
	return { name: profileName, components, diagnostics };
}

function HcpClientlegacyparseprofiles(
	value: TomlValue | undefined,
	path: string,
	packageId: string,
	diagnostics: HcpClientpackagev1diagnostic[],
): HcpClientharnesspackageprofilev1[] {
	if (!Array.isArray(value)) return [];
	const profiles: HcpClientharnesspackageprofilev1[] = [];
	for (const item of value) {
		if (!HcpClientlegacyistomltable(item)) continue;
		const name = HcpClientlegacyasstring(item.name);
		if (!name) {
			diagnostics.push({
				type: "error",
				code: "package_manifest_invalid",
				message: "Package profile entries must declare name.",
				path,
				packageId,
			});
			continue;
		}
		profiles.push({
			name,
			description: HcpClientlegacyasstring(item.description),
			extends: HcpClientlegacyasstringarray(item.extends),
			harness: HcpClientlegacyasstring(item.harness) ?? HcpClientlegacyasstring(item.path),
		});
	}
	return profiles;
}

function HcpClientlegacyparsecomponents(
	table: TomlTable,
	packageId: string,
	profile: string | undefined,
	sourcePath: string,
	diagnostics: HcpClientpackagev1diagnostic[],
): HcpClientpackagecomponentrefv1[] {
	const components = table.components;
	if (Array.isArray(components)) {
		return components
			.filter(HcpClientlegacyistomltable)
			.map((entry) =>
				HcpClientlegacyparsecomponententry(
					entry,
					HcpClientlegacyasstring(entry.kind),
					packageId,
					profile,
					sourcePath,
					diagnostics,
				),
			)
			.filter((entry): entry is HcpClientpackagecomponentrefv1 => Boolean(entry));
	}
	if (HcpClientlegacyistomltable(components)) {
		const refs: HcpClientpackagecomponentrefv1[] = [];
		for (const [kind, entries] of Object.entries(components)) {
			if (!Array.isArray(entries)) continue;
			for (const entry of entries.filter(HcpClientlegacyistomltable)) {
				const component = HcpClientlegacyparsecomponententry(
					entry,
					kind,
					packageId,
					profile,
					sourcePath,
					diagnostics,
				);
				if (component) refs.push(component);
			}
		}
		return refs;
	}
	return [];
}

function HcpClientlegacyparsecomponententry(
	entry: TomlTable,
	defaultKind: string | undefined,
	packageId: string,
	profile: string | undefined,
	sourcePath: string,
	diagnostics: HcpClientpackagev1diagnostic[],
): HcpClientpackagecomponentrefv1 | undefined {
	const kind = HcpClientlegacyasstring(entry.kind) ?? defaultKind;
	const name = HcpClientlegacyasstring(entry.name);
	if (!kind || !name) {
		diagnostics.push({
			type: "error",
			code: "package_component_invalid",
			message: "Package components must declare kind and name.",
			path: sourcePath,
			packageId,
			profile,
		});
		return undefined;
	}
	return {
		kind,
		name,
		description: HcpClientlegacyasstring(entry.description),
		path: HcpClientlegacyasstring(entry.path),
		includeInContext: HcpClientlegacyasboolean(entry.include_in_context),
		source: HcpClientlegacyasstring(entry.source),
		profiles: HcpClientlegacyasstringarray(entry.profiles),
		bundles: HcpClientlegacyparsebundlerefs(entry.bundles, packageId, profile, sourcePath, diagnostics),
		raw: entry,
	};
}

function HcpClientlegacyresolvecomponent(
	component: HcpClientpackagecomponentrefv1,
	pkg: HcpClientharnesspackagev1,
	profile: string | undefined,
	baseDir: string,
	sourcePath: string,
	diagnostics: HcpClientpackagev1diagnostic[],
): HcpClientpackageresolvedcomponentv1 | undefined {
	const resolvedPath = component.path
		? HcpClientlegacyresolvepackagelocalreference({
				reference: component.path,
				packageDir: pkg.dir,
				baseDir,
				sourcePath,
				packageId: pkg.id,
				profile,
				diagnostics,
				invalidCode: "package_component_invalid",
				referenceKind: `${component.kind}:${component.name} component`,
			})
		: undefined;
	if (component.path && !resolvedPath) return undefined;
	if (resolvedPath && !existsSync(resolvedPath)) {
		diagnostics.push({
			type: "error",
			code: "package_component_missing",
			message: `Package ${pkg.id} ${component.kind}:${component.name} component path is missing: ${resolvedPath}`,
			path: sourcePath,
			packageId: pkg.id,
			profile,
		});
		return undefined;
	}
	return {
		...component,
		packageId: pkg.id,
		packageDir: pkg.dir,
		profile,
		key: HcpClientlegacycomponentkey(component),
		baseDir,
		...(resolvedPath ? { path: resolvedPath } : {}),
		sourcePath,
	};
}

async function HcpClientlegacyapplycomponentbundles(
	components: HcpClientpackageresolvedcomponentv1[],
	diagnostics: HcpClientpackagev1diagnostic[],
): Promise<HcpClientpackageresolvedcomponentv1[]> {
	const annotated = await Promise.all(
		components.map(async (component) => {
			const compatibility = await HcpClientlegacyreadcomponentcompatibility(component, diagnostics);
			return {
				...component,
				source: compatibility.source ?? component.source,
				bundles: [...component.bundles, ...compatibility.bundles],
			};
		}),
	);

	const nextSources = new Map(annotated.map((component) => [component.key, component.source] as const));
	const byKind = new Map<string, HcpClientpackageresolvedcomponentv1[]>();
	for (const component of annotated) {
		const list = byKind.get(component.kind) ?? [];
		list.push(component);
		byKind.set(component.kind, list);
	}

	for (const component of annotated) {
		for (const bundle of component.bundles) {
			const candidates = (byKind.get(bundle.kind) ?? []).filter((candidate) =>
				bundle.name ? candidate.name === bundle.name : true,
			);
			if (candidates.length === 0) {
				diagnostics.push({
					type: "warning",
					code: "package_bundle_target_missing",
					message:
						`Package ${component.packageId} ${component.kind}:${component.name} declares bundle ` +
						`${bundle.raw}, but no matching ${bundle.name ? `${bundle.kind}:${bundle.name}` : bundle.kind} component is selected.`,
					path: component.path ?? component.sourcePath,
					packageId: component.packageId,
					profile: component.profile,
				});
				continue;
			}

			for (const target of candidates) {
				const previousSource = nextSources.get(target.key);
				if (previousSource === bundle.source) continue;
				nextSources.set(target.key, bundle.source);
				diagnostics.push({
					type: "warning",
					code: previousSource ? "package_bundle_conflict" : "package_bundle_applied",
					message: previousSource
						? `Package bundle ${component.kind}:${component.name} -> ${bundle.raw} changed ${target.kind}:${target.name} source from ${previousSource} to ${bundle.source}.`
						: `Package bundle ${component.kind}:${component.name} -> ${bundle.raw} selected ${target.kind}:${target.name} source ${bundle.source}.`,
					path: target.path ?? target.sourcePath,
					packageId: target.packageId,
					profile: target.profile,
				});
			}
		}
	}

	return annotated.map((component) => ({ ...component, source: nextSources.get(component.key) }));
}

async function HcpClientlegacyreadcomponentcompatibility(
	component: HcpClientpackageresolvedcomponentv1,
	diagnostics: HcpClientpackagev1diagnostic[],
): Promise<{ source?: string; bundles: HcpClientpackagecomponentbundlev1[] }> {
	if (!component.path || !component.path.endsWith(".toml")) {
		return { bundles: [] };
	}

	let descriptor: TomlTable;
	try {
		descriptor = parseToml(await readFile(component.path, "utf-8"));
	} catch (error) {
		diagnostics.push({
			type: "error",
			code: "package_component_invalid",
			message: `Unable to read component descriptor ${component.path}: ${HcpClientlegacyformatunknownerror(error)}`,
			path: component.path,
			packageId: component.packageId,
			profile: component.profile,
		});
		return { bundles: [] };
	}

	return {
		source: HcpClientlegacyasstring(descriptor.source),
		bundles: HcpClientlegacyparsebundlerefs(
			descriptor.bundles,
			component.packageId,
			component.profile,
			component.path,
			diagnostics,
		),
	};
}

function HcpClientlegacyresolvepackagelocalreference(options: {
	reference: string;
	packageDir: string;
	baseDir: string;
	sourcePath: string;
	packageId: string;
	profile?: string;
	diagnostics: HcpClientpackagev1diagnostic[];
	invalidCode: Extract<HcpClientpackagev1diagnosticcode, "package_harness_invalid" | "package_component_invalid">;
	referenceKind: string;
}): string | undefined {
	if (isAbsolute(options.reference)) {
		options.diagnostics.push({
			type: "error",
			code: options.invalidCode,
			message: `Package ${options.packageId} ${options.referenceKind} must be a package-local relative reference, not an absolute path: ${options.reference}`,
			path: options.sourcePath,
			packageId: options.packageId,
			profile: options.profile,
		});
		return undefined;
	}

	const resolvedPath = resolve(options.baseDir, options.reference);
	if (
		!HcpClientlegacyiswithindir(options.packageDir, resolvedPath) ||
		!HcpClientlegacyisrealpathwithindir(options.packageDir, resolvedPath)
	) {
		options.diagnostics.push({
			type: "error",
			code: options.invalidCode,
			message: `Package ${options.packageId} ${options.referenceKind} escapes the package directory: ${options.reference}`,
			path: options.sourcePath,
			packageId: options.packageId,
			profile: options.profile,
		});
		return undefined;
	}

	return resolvedPath;
}

function HcpClientlegacyiswithindir(parentDir: string, childPath: string): boolean {
	const rel = relative(parentDir, childPath);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function HcpClientlegacyisrealpathwithindir(parentDir: string, childPath: string): boolean {
	if (!existsSync(childPath)) return true;
	try {
		return HcpClientlegacyiswithindir(realpathSync(parentDir), realpathSync(childPath));
	} catch {
		return false;
	}
}

function HcpClientlegacyoverlaycomponentmap(components: HcpClientpackageresolvedcomponentv1[]): {
	componentMap: Map<string, HcpClientpackageresolvedcomponentv1>;
	overrides: HcpClientpackagecomponentoverridev1[];
} {
	const componentMap = new Map<string, HcpClientpackageresolvedcomponentv1>();
	const overrides: HcpClientpackagecomponentoverridev1[] = [];
	for (const component of components) {
		const replaced = componentMap.get(component.key);
		if (replaced) {
			overrides.push({ key: component.key, replaced, replacement: component });
			// Map.set() preserves the first insertion position. Reinsert so iteration
			// reflects actual last-writer precedence for ordered Resource merging.
			componentMap.delete(component.key);
		}
		componentMap.set(component.key, component);
	}
	return { componentMap, overrides };
}

function HcpClientlegacycomponentkey(component: Pick<HcpClientpackagecomponentrefv1, "kind" | "name">): string {
	return `${component.kind}:${component.name}`;
}

function HcpClientlegacyparsebundlerefs(
	value: TomlValue | undefined,
	packageId: string,
	profile: string | undefined,
	path: string,
	diagnostics: HcpClientpackagev1diagnostic[],
): HcpClientpackagecomponentbundlev1[] {
	const refs: HcpClientpackagecomponentbundlev1[] = [];
	for (const raw of HcpClientlegacyasstringarray(value)) {
		const parts = raw
			.split(":")
			.map((part) => part.trim())
			.filter(Boolean);
		if (parts.length !== 2 && parts.length !== 3) {
			diagnostics.push({
				type: "error",
				code: "package_bundle_invalid",
				message: `Invalid bundle reference "${raw}". Expected "kind:source" or "kind:name:source".`,
				path,
				packageId,
				profile,
			});
			continue;
		}
		refs.push(
			parts.length === 2
				? { kind: parts[0]!, source: parts[1]!, raw }
				: { kind: parts[0]!, name: parts[1]!, source: parts[2]!, raw },
		);
	}
	return refs;
}

function HcpClientlegacyasstring(value: TomlValue | undefined): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function HcpClientlegacyasboolean(value: TomlValue | undefined): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function HcpClientlegacyasstringarray(value: TomlValue | undefined): string[] {
	if (typeof value === "string") return [value];
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

function HcpClientlegacyistomltable(value: TomlValue | undefined): value is TomlTable {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function HcpClientlegacyunique(values: string[]): string[] {
	return [...new Set(values.filter(Boolean))];
}

async function HcpClientlegacystatifexists(path: string): Promise<import("node:fs").Stats | undefined> {
	try {
		return await stat(path);
	} catch {
		return undefined;
	}
}

function HcpClientlegacyformatunknownerror(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
