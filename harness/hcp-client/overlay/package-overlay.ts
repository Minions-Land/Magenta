import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { HcpMagnetBinding, HcpMagnet } from "../../hcp-client/HcpMagnetTypes.ts";
import {
	createPackageToolMagnet as createPackageToolMagnetFromDescriptor,
	type PackageToolMagnetDiagnosticCode,
} from "../../hcp-magnet/package-tool.ts";
import {
	type CapabilityMagnetDiagnosticCode,
	capabilityBindingKey,
	createCapabilityMagnet,
} from "../assembly/capability.ts";
import { registerMagnetHcpServers } from "../assembly/register-servers.ts";
import { HcpClient } from "../HcpClient.ts";
import { parseToml, type TomlTable, type TomlValue } from "../registry/registry.ts";

export const PACKAGE_MANIFEST_FILE = "package.toml";
export const PACKAGE_SCHEMA_VERSION = "magenta.package.v1";

export type HarnessPackageKind = "domain" | "brand" | "harness" | string;

export type PackageDiagnosticCode =
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
	| PackageToolMagnetDiagnosticCode
	| CapabilityMagnetDiagnosticCode;

export interface PackageDiagnostic {
	type: "warning" | "error";
	code: PackageDiagnosticCode;
	message: string;
	path?: string;
	packageId?: string;
	profile?: string;
}

export interface HarnessPackageProfile {
	name: string;
	description?: string;
	extends: string[];
	harness?: string;
}

export interface HarnessPackageManifest {
	schemaVersion?: string;
	id: string;
	name: string;
	description?: string;
	kind?: HarnessPackageKind;
	domain?: string;
	defaultProfiles: string[];
	profiles: HarnessPackageProfile[];
	components: PackageComponentRef[];
	raw: TomlTable;
}

export interface HarnessPackage {
	id: string;
	dir: string;
	manifestPath: string;
	manifest: HarnessPackageManifest;
	diagnostics: PackageDiagnostic[];
}

export interface PackageComponentRef {
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
	 * {@link componentMatchesProfiles}).
	 */
	profiles?: string[];
	bundles: PackageComponentBundle[];
	raw: TomlTable;
}

export interface PackageResolvedComponent extends PackageComponentRef {
	packageId: string;
	profile?: string;
	key: string;
	baseDir: string;
	path?: string;
	sourcePath: string;
}

export interface PackageComponentBundle {
	kind: string;
	name?: string;
	source: string;
	raw: string;
}

export interface PackageResourcePath {
	packageId: string;
	profile?: string;
	name: string;
	path: string;
	sourcePath: string;
	component: PackageResolvedComponent;
}

export interface PackageOverlayResources {
	skillPaths: PackageResourcePath[];
	promptTemplatePaths: PackageResourcePath[];
	themePaths: PackageResourcePath[];
	systemPromptPaths: PackageResourcePath[];
	appendSystemPromptPaths: PackageResourcePath[];
	brandPaths: PackageResourcePath[];
}

export interface PackageComponentOverride {
	key: string;
	replaced: PackageResolvedComponent;
	replacement: PackageResolvedComponent;
}

export interface PackageProfileSelection {
	packageId: string;
	profiles?: string[];
}

export interface PackageOverlay {
	repoRoot: string;
	packagesRoot: string;
	selections: PackageProfileSelection[];
	packages: HarnessPackage[];
	components: PackageResolvedComponent[];
	componentMap: Map<string, PackageResolvedComponent>;
	overrides: PackageComponentOverride[];
	resources: PackageOverlayResources;
	diagnostics: PackageDiagnostic[];
}

export interface PackageToolAssembly {
	magnets: HcpMagnet[];
	tools: AgentTool[];
	/**
	 * Source-selected non-tool capability bindings, keyed by capability slot
	 * (`kind` for single-slot capabilities, `kind:name` for multi-instance
	 * families such as runtime). Consumers inject these instead of statically
	 * importing an impl, so the assembly layer — not an import path — decides
	 * which source is used.
	 */
	capabilities: Map<string, HcpMagnetBinding>;
	/**
	 * The one HCP registry every magnet's management + resolution surface was
	 * registered into. `tools` and `capabilities` above are DERIVED from it (each
	 * resolved via `instance()`), so HCP is the single resolver. Additive field:
	 * existing consumers that only read `tools`/`capabilities` are unaffected.
	 */
	hcp: HcpClient;
	diagnostics: PackageDiagnostic[];
}

/**
 * Progress reading emitted while {@link assemblePackageToolMagnets} walks the
 * component list. `start` fires before a component is built (useful because a
 * `runtime = "mcp"` component may spawn a server, and a process tool may trigger
 * a cargo build); `assembled` fires once it is done. `index` is 0-based and
 * `total` is the full component count, so a consumer can render `index+1/total`.
 */
export interface PackageAssemblyProgress {
	phase: "start" | "assembled";
	index: number;
	total: number;
	component: PackageResolvedComponent;
}

export interface AssemblePackageToolMagnetsOptions {
	onProgress?: (progress: PackageAssemblyProgress) => void;
}

export interface DiscoverHarnessPackagesResult {
	repoRoot: string;
	packagesRoot: string;
	packages: HarnessPackage[];
	diagnostics: PackageDiagnostic[];
}

export interface DiscoverHarnessPackagesOptions {
	repoRoot?: string;
}

export interface LoadPackageOverlayOptions {
	repoRoot?: string;
	selections: Array<string | PackageProfileSelection>;
	includeDefaultProfiles?: boolean;
}

interface LoadedProfile {
	name: string;
	components: PackageResolvedComponent[];
	diagnostics: PackageDiagnostic[];
}

export function getHarnessPackagesRoot(repoRoot: string = process.cwd()): string {
	return resolve(repoRoot, "packages");
}

export function parsePackageSelector(selector: string): PackageProfileSelection {
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

export async function discoverHarnessPackages(
	options: DiscoverHarnessPackagesOptions = {},
): Promise<DiscoverHarnessPackagesResult> {
	const repoRoot = resolve(options.repoRoot ?? process.cwd());
	const root = getHarnessPackagesRoot(repoRoot);
	const diagnostics: PackageDiagnostic[] = [];
	const packages: HarnessPackage[] = [];

	const rootInfo = await statIfExists(root);
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
		const manifestPath = resolve(root, entry.name, PACKAGE_MANIFEST_FILE);
		if (!existsSync(manifestPath)) continue;
		const loaded = await loadHarnessPackageManifest(manifestPath);
		packages.push(loaded.package);
		diagnostics.push(...loaded.package.diagnostics);
	}

	return { repoRoot, packagesRoot: root, packages, diagnostics };
}

async function loadHarnessPackageManifest(
	manifestPath: string,
): Promise<{ package: HarnessPackage; diagnostics: PackageDiagnostic[] }> {
	const resolvedManifestPath = resolve(manifestPath);
	const packageDir = dirname(resolvedManifestPath);
	const fallbackId = basename(packageDir);
	const diagnostics: PackageDiagnostic[] = [];
	let raw: TomlTable = {};

	try {
		raw = parseToml(await readFile(resolvedManifestPath, "utf-8"));
	} catch (error) {
		diagnostics.push({
			type: "error",
			code: "package_manifest_read_failed",
			message: `Unable to read package manifest ${resolvedManifestPath}: ${formatUnknownError(error)}`,
			path: resolvedManifestPath,
		});
	}

	const id = asString(raw.id) ?? fallbackId;
	const name = asString(raw.name) ?? id;
	const manifest: HarnessPackageManifest = {
		schemaVersion: asString(raw.schema_version),
		id,
		name,
		description: asString(raw.description),
		kind: asString(raw.kind),
		domain: asString(raw.domain),
		defaultProfiles: asStringArray(raw.default_profiles),
		profiles: parseProfiles(raw.profiles, resolvedManifestPath, id, diagnostics),
		components: parseComponents(raw, id, undefined, resolvedManifestPath, diagnostics),
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
	if (manifest.schemaVersion && manifest.schemaVersion !== PACKAGE_SCHEMA_VERSION) {
		diagnostics.push({
			type: "warning",
			code: "package_manifest_invalid",
			message: `Unsupported package schema_version ${manifest.schemaVersion}; expected ${PACKAGE_SCHEMA_VERSION}.`,
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

export async function loadPackageOverlay(options: LoadPackageOverlayOptions): Promise<PackageOverlay> {
	const repoRoot = resolve(options.repoRoot ?? process.cwd());
	const packagesRoot = getHarnessPackagesRoot(repoRoot);
	const includeDefaultProfiles = options.includeDefaultProfiles ?? true;
	const discovery = await discoverHarnessPackages({ repoRoot });
	const packageMap = new Map(discovery.packages.map((pkg) => [pkg.id, pkg]));
	const selections = options.selections.map((selection) =>
		typeof selection === "string" ? parsePackageSelector(selection) : selection,
	);
	const diagnostics: PackageDiagnostic[] = [...discovery.diagnostics];
	const selectedPackages: HarnessPackage[] = [];
	const components: PackageResolvedComponent[] = [];

	for (const selection of selections) {
		const pkg = packageMap.get(selection.packageId);
		if (!pkg) {
			diagnostics.push({
				type: "error",
				code: "package_manifest_missing",
				message: `Selected package was not found: ${selection.packageId}`,
				path: resolve(packagesRoot, selection.packageId, PACKAGE_MANIFEST_FILE),
				packageId: selection.packageId,
			});
			continue;
		}

		selectedPackages.push(pkg);
		const profileNames = resolveSelectedProfileNames(pkg, selection.profiles, includeDefaultProfiles);
		const selectedProfileClosure = expandProfileClosure(pkg, profileNames);
		components.push(...resolvePackageRootComponents(pkg, selectedProfileClosure, diagnostics));
		const loadedProfiles = new Set<string>();

		for (const profileName of profileNames) {
			const loaded = await loadProfile(pkg, profileName, [], loadedProfiles);
			components.push(...loaded.components);
			diagnostics.push(...loaded.diagnostics);
		}
	}

	const { componentMap, overrides } = overlayComponentMap(components);
	const resolvedComponents = await applyComponentBundles([...componentMap.values()], diagnostics);
	const resolvedComponentMap = new Map(resolvedComponents.map((component) => [component.key, component]));
	return {
		repoRoot,
		packagesRoot,
		selections,
		packages: selectedPackages,
		components: resolvedComponents,
		componentMap: resolvedComponentMap,
		overrides,
		resources: collectOverlayResources(resolvedComponents),
		diagnostics,
	};
}

/**
 * Non-tool component kinds that the assembly layer resolves into
 * {@link HcpMagnetBinding}s via a {@link CapabilityMagnet}. Empty until a
 * module is migrated off static-import consumption onto assembly injection;
 * each migration adds its kind here. While empty, {@link assemblePackageToolMagnets}
 * behaves exactly as the tool-only assembly did.
 */
export const CAPABILITY_KINDS = new Set<string>([
	"compaction",
	"context",
	"hook",
	"memory",
	"policy",
	"prompt-template",
	"runtime",
	"sandbox",
]);

export async function assemblePackageToolMagnets(
	overlay: PackageOverlay,
	options: AssemblePackageToolMagnetsOptions = {},
): Promise<PackageToolAssembly> {
	const diagnostics: PackageDiagnostic[] = [];
	const magnets: HcpMagnet[] = [];
	const onProgress = options.onProgress;
	const total = overlay.components.length;

	for (let index = 0; index < overlay.components.length; index++) {
		const component = overlay.components[index];
		const context = {
			repoRoot: overlay.repoRoot,
			packagesRoot: overlay.packagesRoot,
			components: overlay.components,
			componentMap: overlay.componentMap,
		};

		if (component.kind === "tool") {
			onProgress?.({ phase: "start", index, total, component });
			const result = await createPackageToolMagnetFromDescriptor({ component, context });
			diagnostics.push(...result.diagnostics);
			if (result.magnet) magnets.push(result.magnet);
			if (result.magnets) magnets.push(...result.magnets);
			onProgress?.({ phase: "assembled", index, total, component });
			continue;
		}
		if (CAPABILITY_KINDS.has(component.kind)) {
			onProgress?.({ phase: "start", index, total, component });
			const result = await createCapabilityMagnetFromDescriptor({ component, context });
			diagnostics.push(...result.diagnostics);
			if (result.magnet) magnets.push(result.magnet);
			onProgress?.({ phase: "assembled", index, total, component });
		}
	}

	// Enforce the magnet one-of invariant before anything reaches HCP: a magnet
	// yields at most one of a tool, a capability, or a resource (spec §5). This is
	// the structural guard that keeps tools off the capability map, capabilities
	// off the LLM hot path, and content-only resources out of code-builder
	// resolution (the §5.1 category error).
	for (const magnet of magnets) {
		const products = [
			typeof magnet.toTool === "function" ? "tool" : undefined,
			typeof magnet.toCapability === "function" ? "capability" : undefined,
			typeof magnet.toResource === "function" ? "resource" : undefined,
		].filter((p): p is string => p !== undefined);
		if (products.length > 1) {
			throw new Error(
				`HcpMagnet "${magnet.kind}" produces multiple primitives (${products.join(", ")}); a magnet must produce at most one.`,
			);
		}
	}

	// The one HCP. Every magnet's management + resolution surface registers here;
	// `tools` and `capabilities` are then DERIVED by resolving through it, so HCP
	// is the single resolver rather than a bypassed bystander.
	const hcp = new HcpClient();
	const registration = registerMagnetHcpServers(hcp, magnets);

	const tools: AgentTool[] = [];
	const capabilities = new Map<string, HcpMagnetBinding>();
	for (const entry of registration.registrations) {
		const instance = hcp.resolveInstance(entry.target);
		if (instance === undefined) continue;
		if (entry.kind === "tool") {
			// Resolved through HCP, but still a plain AgentTool invoked directly on
			// the runtime hot path — HCP is off that path (contract invariant 3).
			tools.push(instance as AgentTool);
		} else {
			// Capabilities carry their source as binding metadata; consumers never
			// read it. Recover the binding from the magnet whose toCapability holds
			// this exact resolved instance (identity match — a magnet's `kind` is
			// its implementation and can repeat across capabilities of one source).
			for (const magnet of magnets) {
				const binding = magnet.toCapability?.();
				if (binding && binding.instance === instance) {
					capabilities.set(capabilityBindingKey(binding), binding);
					break;
				}
			}
		}
	}

	return { magnets, tools, capabilities, hcp, diagnostics };
}

/**
 * Adapt an assembled non-tool component into a capability magnet. Reads the
 * component's descriptor TOML to determine the selected `source`, then delegates
 * to {@link createCapabilityMagnet}, which looks up the registered factory for
 * that `(kind, source)` pair. This is where source selection actually happens.
 */
async function createCapabilityMagnetFromDescriptor(options: {
	component: PackageResolvedComponent;
	context: {
		repoRoot: string;
		packagesRoot: string;
		components: PackageResolvedComponent[];
		componentMap: Map<string, PackageResolvedComponent>;
	};
}): Promise<{ magnet?: HcpMagnet; diagnostics: PackageDiagnostic[] }> {
	const { component, context } = options;
	const diagnostics: PackageDiagnostic[] = [];

	let source: string | undefined = component.source;
	if (component.path) {
		try {
			const descriptor = parseToml(await readFile(component.path, "utf-8"));
			source = source ?? asString(descriptor.source);
		} catch (error) {
			diagnostics.push({
				type: "error",
				code: "package_component_invalid",
				message: `Unable to read capability descriptor ${component.path}: ${
					error instanceof Error ? error.message : String(error)
				}`,
				path: component.sourcePath,
				packageId: component.packageId,
				profile: component.profile,
			});
			return { diagnostics };
		}
	}

	const result = await createCapabilityMagnet({
		component: {
			kind: component.kind,
			name: component.name,
			description: component.description,
			path: component.path,
			source: source ?? "",
		},
		context: { repoRoot: context.repoRoot, packagesRoot: context.packagesRoot },
	});

	for (const diagnostic of result.diagnostics) {
		diagnostics.push({
			type: "error",
			code: diagnostic.code,
			message: diagnostic.message,
			path: component.sourcePath,
			packageId: component.packageId,
			profile: component.profile,
		});
	}

	return { magnet: result.magnet, diagnostics };
}

function resolveSelectedProfileNames(
	pkg: HarnessPackage,
	selectedProfiles: string[] | undefined,
	includeDefaultProfiles: boolean,
): string[] {
	if (selectedProfiles?.includes("*") || selectedProfiles?.includes("all")) {
		return unique(pkg.manifest.profiles.map((profile) => profile.name));
	}
	const profiles = selectedProfiles?.length ? selectedProfiles : pkg.manifest.defaultProfiles;
	return unique([...(includeDefaultProfiles ? pkg.manifest.defaultProfiles : []), ...profiles]);
}

/**
 * Transitive `extends` closure of the selected profile names. Selecting a
 * profile pulls in every profile it extends (e.g. `all` extends the topic
 * profiles), so a component tagged with any profile in the closure matches.
 */
function expandProfileClosure(pkg: HarnessPackage, names: string[]): Set<string> {
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
function componentMatchesProfiles(component: PackageComponentRef, closure: Set<string>): boolean {
	if (!component.profiles || component.profiles.length === 0) return true;
	if (closure.size === 0) return true;
	return component.profiles.some((tag) => closure.has(tag));
}

function resolvePackageRootComponents(
	pkg: HarnessPackage,
	selectedProfileClosure: Set<string>,
	diagnostics: PackageDiagnostic[],
): PackageResolvedComponent[] {
	return pkg.manifest.components
		.filter((component) => componentMatchesProfiles(component, selectedProfileClosure))
		.map((component) => resolveComponent(component, pkg, undefined, pkg.dir, pkg.manifestPath, diagnostics))
		.filter((component): component is PackageResolvedComponent => Boolean(component));
}

async function loadProfile(
	pkg: HarnessPackage,
	profileName: string,
	stack: string[],
	loadedProfiles: Set<string>,
): Promise<LoadedProfile> {
	if (loadedProfiles.has(profileName)) return { name: profileName, components: [], diagnostics: [] };
	const diagnostics: PackageDiagnostic[] = [];
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

	const components: PackageResolvedComponent[] = [];
	for (const parentProfile of profile.extends) {
		const loaded = await loadProfile(pkg, parentProfile, [...stack, profileName], loadedProfiles);
		components.push(...loaded.components);
		diagnostics.push(...loaded.diagnostics);
	}

	if (!profile.harness) {
		loadedProfiles.add(profileName);
		return { name: profileName, components, diagnostics };
	}

	const harnessPath = resolvePackageLocalReference({
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

	const info = await statIfExists(harnessPath);
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
			message: `Unable to read package harness ${harnessPath}: ${formatUnknownError(error)}`,
			path: harnessPath,
			packageId: pkg.id,
			profile: profileName,
		});
		return { name: profileName, components, diagnostics };
	}

	const refs = parseComponents(table, pkg.id, profileName, harnessPath, diagnostics);
	for (const ref of refs) {
		const component = resolveComponent(ref, pkg, profileName, dirname(harnessPath), harnessPath, diagnostics);
		if (component) components.push(component);
	}
	loadedProfiles.add(profileName);
	return { name: profileName, components, diagnostics };
}

function parseProfiles(
	value: TomlValue | undefined,
	path: string,
	packageId: string,
	diagnostics: PackageDiagnostic[],
): HarnessPackageProfile[] {
	if (!Array.isArray(value)) return [];
	const profiles: HarnessPackageProfile[] = [];
	for (const item of value) {
		if (!isTomlTable(item)) continue;
		const name = asString(item.name);
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
			description: asString(item.description),
			extends: asStringArray(item.extends),
			harness: asString(item.harness) ?? asString(item.path),
		});
	}
	return profiles;
}

function parseComponents(
	table: TomlTable,
	packageId: string,
	profile: string | undefined,
	sourcePath: string,
	diagnostics: PackageDiagnostic[],
): PackageComponentRef[] {
	const components = table.components;
	if (Array.isArray(components)) {
		return components
			.filter(isTomlTable)
			.map((entry) => parseComponentEntry(entry, asString(entry.kind), packageId, profile, sourcePath, diagnostics))
			.filter((entry): entry is PackageComponentRef => Boolean(entry));
	}
	if (isTomlTable(components)) {
		const refs: PackageComponentRef[] = [];
		for (const [kind, entries] of Object.entries(components)) {
			if (!Array.isArray(entries)) continue;
			for (const entry of entries.filter(isTomlTable)) {
				const component = parseComponentEntry(entry, kind, packageId, profile, sourcePath, diagnostics);
				if (component) refs.push(component);
			}
		}
		return refs;
	}
	return [];
}

function parseComponentEntry(
	entry: TomlTable,
	defaultKind: string | undefined,
	packageId: string,
	profile: string | undefined,
	sourcePath: string,
	diagnostics: PackageDiagnostic[],
): PackageComponentRef | undefined {
	const kind = asString(entry.kind) ?? defaultKind;
	const name = asString(entry.name);
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
		description: asString(entry.description),
		path: asString(entry.path),
		includeInContext: asBoolean(entry.include_in_context),
		source: asString(entry.source),
		profiles: asStringArray(entry.profiles),
		bundles: parseBundleRefs(entry.bundles, packageId, profile, sourcePath, diagnostics),
		raw: entry,
	};
}

function resolveComponent(
	component: PackageComponentRef,
	pkg: HarnessPackage,
	profile: string | undefined,
	baseDir: string,
	sourcePath: string,
	diagnostics: PackageDiagnostic[],
): PackageResolvedComponent | undefined {
	const resolvedPath = component.path
		? resolvePackageLocalReference({
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
		profile,
		key: componentKey(component),
		baseDir,
		...(resolvedPath ? { path: resolvedPath } : {}),
		sourcePath,
	};
}

async function applyComponentBundles(
	components: PackageResolvedComponent[],
	diagnostics: PackageDiagnostic[],
): Promise<PackageResolvedComponent[]> {
	const annotated = await Promise.all(
		components.map(async (component) => {
			const compatibility = await readComponentCompatibility(component, diagnostics);
			return {
				...component,
				source: compatibility.source ?? component.source,
				bundles: [...component.bundles, ...compatibility.bundles],
			};
		}),
	);

	const nextSources = new Map(annotated.map((component) => [component.key, component.source] as const));
	const byKind = new Map<string, PackageResolvedComponent[]>();
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

async function readComponentCompatibility(
	component: PackageResolvedComponent,
	diagnostics: PackageDiagnostic[],
): Promise<{ source?: string; bundles: PackageComponentBundle[] }> {
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
			message: `Unable to read component descriptor ${component.path}: ${formatUnknownError(error)}`,
			path: component.path,
			packageId: component.packageId,
			profile: component.profile,
		});
		return { bundles: [] };
	}

	return {
		source: asString(descriptor.source),
		bundles: parseBundleRefs(descriptor.bundles, component.packageId, component.profile, component.path, diagnostics),
	};
}

function resolvePackageLocalReference(options: {
	reference: string;
	packageDir: string;
	baseDir: string;
	sourcePath: string;
	packageId: string;
	profile?: string;
	diagnostics: PackageDiagnostic[];
	invalidCode: Extract<PackageDiagnosticCode, "package_harness_invalid" | "package_component_invalid">;
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
	if (!isWithinDir(options.packageDir, resolvedPath)) {
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

function isWithinDir(parentDir: string, childPath: string): boolean {
	const rel = relative(parentDir, childPath);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function overlayComponentMap(components: PackageResolvedComponent[]): {
	componentMap: Map<string, PackageResolvedComponent>;
	overrides: PackageComponentOverride[];
} {
	const componentMap = new Map<string, PackageResolvedComponent>();
	const overrides: PackageComponentOverride[] = [];
	for (const component of components) {
		const replaced = componentMap.get(component.key);
		if (replaced) {
			overrides.push({ key: component.key, replaced, replacement: component });
		}
		componentMap.set(component.key, component);
	}
	return { componentMap, overrides };
}

function collectOverlayResources(components: PackageResolvedComponent[]): PackageOverlayResources {
	const resources: PackageOverlayResources = {
		skillPaths: [],
		promptTemplatePaths: [],
		themePaths: [],
		systemPromptPaths: [],
		appendSystemPromptPaths: [],
		brandPaths: [],
	};

	for (const component of components) {
		if (!component.path) continue;
		const resource = {
			packageId: component.packageId,
			profile: component.profile,
			name: component.name,
			path: component.path,
			sourcePath: component.sourcePath,
			component,
		};
		switch (component.kind) {
			case "skill":
				resources.skillPaths.push(resource);
				break;
			case "prompt":
			case "prompt-template":
				resources.promptTemplatePaths.push(resource);
				break;
			case "theme":
				resources.themePaths.push(resource);
				break;
			case "system-prompt":
				resources.systemPromptPaths.push(resource);
				break;
			case "append-system-prompt":
				resources.appendSystemPromptPaths.push(resource);
				break;
			case "brand":
				resources.brandPaths.push(resource);
				break;
		}
	}

	return resources;
}

function componentKey(component: Pick<PackageComponentRef, "kind" | "name">): string {
	return `${component.kind}:${component.name}`;
}

function parseBundleRefs(
	value: TomlValue | undefined,
	packageId: string,
	profile: string | undefined,
	path: string,
	diagnostics: PackageDiagnostic[],
): PackageComponentBundle[] {
	const refs: PackageComponentBundle[] = [];
	for (const raw of asStringArray(value)) {
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

function asString(value: TomlValue | undefined): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asBoolean(value: TomlValue | undefined): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function asStringArray(value: TomlValue | undefined): string[] {
	if (typeof value === "string") return [value];
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

function isTomlTable(value: TomlValue | undefined): value is TomlTable {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function unique(values: string[]): string[] {
	return [...new Set(values.filter(Boolean))];
}

async function statIfExists(path: string): Promise<import("node:fs").Stats | undefined> {
	try {
		return await stat(path);
	} catch {
		return undefined;
	}
}

function formatUnknownError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
