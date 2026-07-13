/**
 * Package overlay v2: isomorphic HCP structure loader.
 *
 * Replaces the v1 flat component adapter with a manifest-driven loader that
 * resolves each declared Source HcpMagnet.ts and owning Module HcpServer.ts,
 * dynamically imports them, and constructs HcpClientcomponent entries for the
 * unified session assembly.
 *
 * V2 packages have this structure (matching HarnessComponentProtocol):
 *   <package-root>/
 *     package.toml (id, version, source, profiles)
 *     memory/<source>/HcpMagnet.ts
 *     tools/<tool>/<source>/HcpMagnet.ts
 *     skills/<skill>/<source>/HcpMagnet.ts
 *
 * Each HcpMagnet is a bare class (spec §2) with static module/kind/source,
 * static build(), and exactly one product method
 * (toTool/toCapability/toResource). The runtime magnet loader imports these,
 * validates shape, and hands them to the same HcpClient assembly pipeline as
 * host magnets.
 */

import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import * as TOML from "smol-toml";
import { HcpClientloadpackageoverlayv1, type HcpClientpackageprofileselectionv1 } from "./package-overlay-v1-compat.ts";
import {
	HcpClientconvertlegacycomponents,
	HcpClientloadpackagemagnets,
	type HcpClientpackagecomponentdeclaration,
	type HcpClientpackageinfrastructuredeclaration,
	type HcpClientpackageloadedmagnet,
} from "./runtime-magnet-loader.ts";

const HcpClientpackageidpattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const HcpClientwindowsreservednamepattern = /^(?:aux|con|nul|prn|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/** Selection of a package plus optional profile narrowing (e.g. "AutOmicScience:single-cell,spatial"). */
export type HcpClientpackageprofileselection = {
	packageId: string;
	profiles?: string[];
	/**
	 * Explicit on-disk root for this package. When present, the loader uses it
	 * directly instead of resolving `<packagesRoot>/<packageId>`. This lets an
	 * acquisition layer place a downloaded package in a per-version cache dir
	 * and hand its path straight to the overlay loader.
	 */
	packageRoot?: string;
};

/** Default packages root: <repoRoot>/packages. */
export function HcpClientgetharnesspackagesroot(repoRoot: string = process.cwd()): string {
	return resolve(repoRoot, "packages");
}

/** Parse a "PackageId:profile1,profile2" selector into id + profiles. */
export function HcpClientparsepackageselector(selector: string): HcpClientpackageprofileselection {
	const [packageId, profileList] = selector.split(":", 2);
	const profiles = profileList
		? profileList
				.split(",")
				.map((p) => p.trim())
				.filter((p) => p.length > 0)
		: undefined;
	return { packageId: packageId!.trim(), ...(profiles && profiles.length > 0 ? { profiles } : {}) };
}

export type HcpClientpackagemanifest = {
	schema_version: string;
	id: string;
	name: string;
	version?: string;
	source?: string;
	kind?: string;
	domain?: string;
	description?: string;
	default_profiles?: string[];
	profiles?: HcpClientpackageprofile[];
	components?: HcpClientpackagecomponentdeclaration[];
};

export type HcpClientpackageprofile = {
	name: string;
	description?: string;
	extends?: string[];
};

/** View shape for TUI package discovery/menu (maps v2 HcpClientpackageoverlay to legacy shape). */
export type HcpClientharnesspackage = {
	id: string;
	dir: string;
	manifest: {
		components: readonly HcpClientpackagecomponentdeclaration[];
		profiles: readonly HcpClientpackageprofile[];
	};
};

export type HcpClientpackageoverlay = {
	repoRoot: string;
	packagesRoot: string;
	selections: HcpClientpackageprofileselection[];
	packages: HcpClientharnesspackage[];
	packageId: string;
	packageVersion: string;
	packageRoot: string;
	source: string;
	profiles: HcpClientpackageprofile[];
	components: HcpClientpackageloadedmagnet[];
	componentMap: Map<string, HcpClientpackageloadedmagnet>;
	overrides: Array<{
		key: string;
		replaced: HcpClientpackageloadedmagnet;
		replacement: HcpClientpackageloadedmagnet;
	}>;
	infrastructure: HcpClientpackageinfrastructuredeclaration[];
	diagnostics: HcpClientpackagediagnostic[];
};

export type HcpClientpackagediagnostic = {
	type: "error" | "warning";
	code: string;
	message: string;
	path?: string;
	packageId: string;
	profile?: string;
};

function HcpClientisplainrecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function HcpClientisnonemptystring(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function HcpClientisstringarray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** Validate the manifest collections dereferenced by the v2 loader. */
function HcpClientpackagev2manifestcollectionshapeerror(value: unknown): string | undefined {
	if (!HcpClientisplainrecord(value)) return "package.toml must contain a TOML table";
	if (!HcpClientisnonemptystring(value.id) || !HcpClientisportablepackageid(value.id)) {
		return "package.toml id must be one portable non-empty identifier";
	}
	if (value.default_profiles !== undefined && !HcpClientisstringarray(value.default_profiles)) {
		return "package.toml default_profiles must be an array of strings";
	}
	if (value.profiles !== undefined) {
		if (!Array.isArray(value.profiles)) return "package.toml profiles must be an array of profile tables";
		for (const [index, profile] of value.profiles.entries()) {
			if (!HcpClientisplainrecord(profile) || !HcpClientisnonemptystring(profile.name)) {
				return `package.toml profiles[${index}] must be a table with a non-empty string name`;
			}
			if (profile.description !== undefined && typeof profile.description !== "string") {
				return `package.toml profiles[${index}].description must be a string`;
			}
			if (profile.extends !== undefined && !HcpClientisstringarray(profile.extends)) {
				return `package.toml profiles[${index}].extends must be an array of strings`;
			}
		}
	}
	if (value.components !== undefined) {
		if (!Array.isArray(value.components)) return "package.toml components must be an array of component tables";
		for (const [index, component] of value.components.entries()) {
			if (!HcpClientisplainrecord(component)) {
				return `package.toml components[${index}] must be a component table`;
			}
		}
	}
	return undefined;
}

/** Validate fields that the v2 runtime loader dereferences as strings/arrays. */
function HcpClientpackagev2manifestshapeerror(manifest: Record<string, unknown>): string | undefined {
	for (const field of ["schema_version", "id", "name", "version", "source"] as const) {
		if (!HcpClientisnonemptystring(manifest[field])) {
			return `package.toml ${field} must be a non-empty string`;
		}
	}
	for (const [index, component] of ((manifest.components as Record<string, unknown>[] | undefined) ?? []).entries()) {
		for (const field of ["kind", "name", "source", "path"] as const) {
			if (!HcpClientisnonemptystring(component[field])) {
				return `package.toml components[${index}].${field} must be a non-empty string`;
			}
		}
		for (const field of ["slot", "description"] as const) {
			if (component[field] !== undefined && typeof component[field] !== "string") {
				return `package.toml components[${index}].${field} must be a string`;
			}
		}
		for (const field of ["requires", "profiles"] as const) {
			if (component[field] !== undefined && !HcpClientisstringarray(component[field])) {
				return `package.toml components[${index}].${field} must be an array of strings`;
			}
		}
		if (component.include_in_context !== undefined && typeof component.include_in_context !== "boolean") {
			return `package.toml components[${index}].include_in_context must be a boolean`;
		}
	}
	return undefined;
}

function HcpClientemptypackageoverlay(options: {
	packageRoot: string;
	packageId: string;
	packageVersion?: string;
	source?: string;
	selectedProfiles?: readonly string[];
	diagnostics: HcpClientpackagediagnostic[];
}): HcpClientpackageoverlay {
	return {
		repoRoot: dirname(options.packageRoot),
		packagesRoot: dirname(options.packageRoot),
		selections: [
			{
				packageId: options.packageId,
				...(options.selectedProfiles ? { profiles: [...options.selectedProfiles] } : {}),
			},
		],
		packages: [],
		packageId: options.packageId,
		packageVersion: options.packageVersion ?? "0.0.0",
		packageRoot: options.packageRoot,
		source: options.source ?? "unknown",
		profiles: [],
		components: [],
		componentMap: new Map(),
		overrides: [],
		infrastructure: [],
		diagnostics: options.diagnostics,
	};
}

/** Progress signal emitted while a package overlay is assembled into a session. */
export type HcpClientpackageassemblyprogress = {
	phase: "start" | "assembled";
	index: number;
	total: number;
	component: HcpClientpackageloadedmagnet;
};

/**
 * Options for loading a package overlay across a packages root, matching the
 * host resource-loader consumption shape.
 */
export type HcpClientloadpackageoverlayoptions = {
	repoRoot?: string;
	packagesRoot?: string;
	selections: readonly (string | HcpClientpackageprofileselection)[];
};

/**
 * Discover all packages under a packages root directory for the TUI menu.
 * Reads each package.toml manifest (id, components, profiles) without loading
 * or validating magnets — this is a lightweight listing for selection.
 */
export async function HcpClientdiscoverharnesspackages(options: {
	repoRoot?: string;
	packagesRoot?: string;
}): Promise<{ packagesRoot: string; packages: HcpClientharnesspackage[]; diagnostics: HcpClientpackagediagnostic[] }> {
	const { readdir, stat } = await import("node:fs/promises");
	const packagesRoot = resolve(options.packagesRoot ?? HcpClientgetharnesspackagesroot(options.repoRoot));
	const diagnostics: HcpClientpackagediagnostic[] = [];

	try {
		const entries = await readdir(packagesRoot, { withFileTypes: true });
		const packageDirs = entries
			.filter((e) => e.isDirectory() && !e.name.startsWith("."))
			.map((e) => join(packagesRoot, e.name));

		const packages: HcpClientharnesspackage[] = [];
		for (const packageDir of packageDirs) {
			const manifestPath = join(packageDir, "package.toml");
			try {
				await stat(manifestPath);
			} catch {
				continue;
			}
			try {
				const parsed = TOML.parse(await readFile(manifestPath, "utf-8")) as unknown;
				const schemaVersion = HcpClientisplainrecord(parsed) ? parsed.schema_version : undefined;
				if (schemaVersion !== "magenta.package.v2") {
					const legacy = await HcpClientloadpackageoverlayv1({
						repoRoot: packagesRoot,
						packagesRoot,
						selections: [{ packageId: basename(packageDir) }],
					});
					const pkg = legacy.packages.find((candidate) => candidate.dir === packageDir);
					if (!pkg) continue;
					packages.push({
						id: pkg.id,
						dir: pkg.dir,
						manifest: {
							components: pkg.manifest.components.map((component) => ({
								kind: component.kind,
								name: component.name,
								source: component.source ?? pkg.id,
								path: component.path ?? "",
								profiles: component.profiles,
								include_in_context: component.includeInContext,
								description: component.description,
							})),
							profiles: pkg.manifest.profiles.map((profile) => ({
								name: profile.name,
								description: profile.description,
								extends: profile.extends,
							})),
						},
					});
					diagnostics.push(
						...legacy.diagnostics.map((diagnostic) => ({
							type: diagnostic.type,
							code: diagnostic.code,
							message: diagnostic.message,
							path: diagnostic.path,
							packageId: diagnostic.packageId ?? pkg.id,
							profile: diagnostic.profile,
						})),
					);
					continue;
				}
				const shapeError = HcpClientpackagev2manifestcollectionshapeerror(parsed);
				if (shapeError) {
					diagnostics.push({
						type: "error",
						code: "package_manifest_invalid",
						message: `Invalid ${manifestPath}: ${shapeError}`,
						path: manifestPath,
						packageId:
							HcpClientisplainrecord(parsed) && HcpClientisnonemptystring(parsed.id)
								? parsed.id
								: basename(packageDir),
					});
					continue;
				}
				const manifest = parsed as HcpClientpackagemanifest;
				const directoryId = basename(packageDir);
				if (manifest.id !== directoryId) {
					diagnostics.push({
						type: "error",
						code: "package_manifest_id_mismatch",
						message: `Package directory ${directoryId} declares manifest id ${manifest.id}.`,
						path: manifestPath,
						packageId: directoryId,
					});
					continue;
				}
				packages.push({
					id: manifest.id,
					dir: packageDir,
					manifest: {
						components: manifest.components ?? [],
						profiles: manifest.profiles ?? [],
					},
				});
			} catch (error) {
				diagnostics.push({
					type: "error",
					code: "package_manifest_parse_failed",
					message: `Failed to parse ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
					path: manifestPath,
					packageId: basename(packageDir) || "unknown",
				});
			}
		}
		return { packagesRoot, packages, diagnostics };
	} catch {
		return { packagesRoot, packages: [], diagnostics };
	}
}

/**
 * Load selected packages (with optional profile narrowing) from a packages root
 * and merge them into a single overlay. This is the primary host entry point.
 *
 * Later selections replace earlier same-address components (kind:name), matching
 * the overlay precedence rule.
 */
export async function HcpClientloadpackageoverlay(
	options: HcpClientloadpackageoverlayoptions,
): Promise<HcpClientpackageoverlay> {
	const repoRoot = resolve(options.repoRoot ?? process.cwd());
	const packagesRoot = resolve(options.packagesRoot ?? HcpClientgetharnesspackagesroot(repoRoot));
	const diagnostics: HcpClientpackagediagnostic[] = [];
	const merged = new Map<string, HcpClientpackageloadedmagnet>();
	const mergedProfiles: HcpClientpackageprofile[] = [];
	const infrastructure: HcpClientpackageinfrastructuredeclaration[] = [];
	const selections = options.selections.map((selection) =>
		typeof selection === "string" ? HcpClientparsepackageselector(selection) : { ...selection },
	);
	const packages: HcpClientharnesspackage[] = [];
	const overrides: HcpClientpackageoverlay["overrides"] = [];
	let primaryId = "";
	let primaryVersion = "0.0.0";
	let primarySource = "";
	let primaryRoot = packagesRoot;
	const realPackagesRoot = await realpath(packagesRoot).catch(() => packagesRoot);

	for (const parsed of selections) {
		const { packageId, profiles } = parsed;
		if (!HcpClientisportablepackageid(packageId)) {
			diagnostics.push({
				type: "error",
				code: "package_selector_invalid",
				message: `Package selector id must be one portable path segment: ${packageId}`,
				packageId,
			});
			continue;
		}
		const invalidProfile = profiles?.find(
			(profile) => profile !== "*" && profile !== "all" && !HcpClientisportablepackageid(profile),
		);
		if (invalidProfile) {
			diagnostics.push({
				type: "error",
				code: "package_selector_invalid",
				message: `Package profile must be a portable identifier: ${invalidProfile}`,
				packageId,
				profile: invalidProfile,
			});
			continue;
		}
		// An explicit packageRoot (e.g. from the acquisition cache) wins over the
		// <packagesRoot>/<packageId> convention.
		const packageRoot = parsed.packageRoot
			? resolve(parsed.packageRoot)
			: await HcpClientresolvelocalpackageroot(packagesRoot, realPackagesRoot, packageId, diagnostics);
		if (!packageRoot) continue;
		const overlay = await HcpClientloadsinglepackage(packageRoot, profiles);
		diagnostics.push(...overlay.diagnostics);
		if (overlay.packageId !== packageId) {
			diagnostics.push({
				type: "error",
				code: "package_manifest_id_mismatch",
				message: `Selected package ${packageId} loaded manifest id ${overlay.packageId}.`,
				path: join(overlay.packageRoot, "package.toml"),
				packageId,
			});
			continue;
		}
		if (!primaryId) {
			primaryId = overlay.packageId;
			primaryVersion = overlay.packageVersion;
			primarySource = overlay.source;
			primaryRoot = overlay.packageRoot;
		}
		mergedProfiles.push(...overlay.profiles);
		packages.push(...overlay.packages);
		infrastructure.push(...overlay.infrastructure);
		// Later components with the same kind:name replace earlier ones.
		for (const component of overlay.components) {
			const replaced = merged.get(component.key);
			if (replaced) {
				overrides.push({ key: component.key, replaced, replacement: component });
				merged.delete(component.key);
			}
			merged.set(component.key, component);
		}
	}

	return {
		repoRoot,
		packagesRoot,
		selections,
		packages,
		packageId: primaryId,
		packageVersion: primaryVersion,
		packageRoot: primaryRoot,
		source: primarySource,
		profiles: mergedProfiles,
		components: [...merged.values()],
		componentMap: merged,
		overrides,
		infrastructure,
		diagnostics,
	};
}

function HcpClientisportablepackageid(value: string): boolean {
	return (
		HcpClientpackageidpattern.test(value) &&
		value !== "." &&
		value !== ".." &&
		!value.endsWith(".") &&
		!HcpClientwindowsreservednamepattern.test(value)
	);
}

async function HcpClientresolvelocalpackageroot(
	packagesRoot: string,
	realPackagesRoot: string,
	packageId: string,
	diagnostics: HcpClientpackagediagnostic[],
): Promise<string | undefined> {
	const candidate = resolve(packagesRoot, packageId);
	if (!HcpClientiswithinroot(packagesRoot, candidate)) {
		diagnostics.push({
			type: "error",
			code: "package_selector_invalid",
			message: `Package selector escapes the packages root: ${packageId}`,
			path: candidate,
			packageId,
		});
		return undefined;
	}
	const actual = await realpath(candidate).catch(() => candidate);
	if (!HcpClientiswithinroot(realPackagesRoot, actual)) {
		diagnostics.push({
			type: "error",
			code: "package_selector_invalid",
			message: `Package selector resolves outside the packages root: ${packageId}`,
			path: actual,
			packageId,
		});
		return undefined;
	}
	return candidate;
}

function HcpClientiswithinroot(root: string, candidate: string): boolean {
	const pathFromRoot = relative(root, candidate);
	return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

/**
 * Load a single package from its root directory, optionally filtering components
 * by selected profiles.
 *
 * Reads package.toml manifest (authoritative component list per spec §2.1),
 * resolves each component's <path>/HcpMagnet.ts, dynamically imports and
 * validates them, and constructs HcpClientcomponent entries.
 */
export async function HcpClientloadsinglepackage(
	inputPackageRoot: string,
	selectedProfiles?: readonly string[],
): Promise<HcpClientpackageoverlay> {
	const diagnostics: HcpClientpackagediagnostic[] = [];
	const lexicalPackageRoot = resolve(inputPackageRoot);

	// Normalize to the real path so paths derived here share the same basis as
	// the magnets' own import.meta.url resolution (which realpath-resolves
	// symlinks, e.g. macOS /var -> /private/var). Without this, package tool
	// command containment checks (isWithinDir) spuriously reject descriptor-
	// relative commands whose realpath differs from the unresolved packageRoot.
	const packageRoot = await realpath(lexicalPackageRoot).catch(() => lexicalPackageRoot);

	// Parse manifest
	const manifestPath = join(packageRoot, "package.toml");
	let manifest: HcpClientpackagemanifest;
	try {
		const tomlContent = await readFile(manifestPath, "utf-8");
		const parsed = TOML.parse(tomlContent) as unknown;
		if (!HcpClientisplainrecord(parsed)) {
			const packageId = basename(packageRoot) || "unknown";
			diagnostics.push({
				type: "error",
				code: "package_manifest_invalid",
				message: "Invalid package.toml: package.toml must contain a TOML table",
				path: manifestPath,
				packageId,
			});
			return HcpClientemptypackageoverlay({ packageRoot, packageId, selectedProfiles, diagnostics });
		}
		const schemaVersion = parsed.schema_version;
		if (schemaVersion !== "magenta.package.v2") {
			// Legacy diagnostics historically expose the lexical package path. Keep
			// that stable on macOS, where /var and /private/var refer to the same
			// location, while v2 continues to use the real path for containment.
			const legacyManifest = {
				...parsed,
				id: typeof parsed.id === "string" ? parsed.id : basename(lexicalPackageRoot),
			} as unknown as HcpClientpackagemanifest;
			return HcpClientloadlegacyoverlay(lexicalPackageRoot, legacyManifest, selectedProfiles);
		}

		const collectionShapeError = HcpClientpackagev2manifestcollectionshapeerror(parsed);
		if (collectionShapeError) {
			const packageId =
				HcpClientisplainrecord(parsed) && HcpClientisnonemptystring(parsed.id)
					? parsed.id
					: basename(packageRoot) || "unknown";
			diagnostics.push({
				type: "error",
				code: "package_manifest_invalid",
				message: `Invalid package.toml: ${collectionShapeError}`,
				path: manifestPath,
				packageId,
			});
			return HcpClientemptypackageoverlay({ packageRoot, packageId, selectedProfiles, diagnostics });
		}
		manifest = parsed as HcpClientpackagemanifest;

		const v2ShapeError = HcpClientpackagev2manifestshapeerror(parsed as Record<string, unknown>);
		if (v2ShapeError) {
			diagnostics.push({
				type: "error",
				code: "package_manifest_invalid",
				message: `Invalid package.toml: ${v2ShapeError}`,
				path: manifestPath,
				packageId: manifest.id,
			});
			return HcpClientemptypackageoverlay({
				packageRoot,
				packageId: manifest.id,
				packageVersion: typeof manifest.version === "string" ? manifest.version : undefined,
				source: typeof manifest.source === "string" ? manifest.source : undefined,
				selectedProfiles,
				diagnostics,
			});
		}

		// Validate schema version
		if (manifest.schema_version !== "magenta.package.v2") {
			diagnostics.push({
				type: "warning",
				code: "package_schema_unknown",
				message: `package.toml schema_version="${manifest.schema_version}" is not "magenta.package.v2"`,
				path: manifestPath,
				packageId: manifest.id,
			});
		}
	} catch (error) {
		const packageId = basename(packageRoot) || "unknown";
		diagnostics.push({
			type: "error",
			code: "package_manifest_parse_failed",
			message: `Failed to parse package.toml: ${error instanceof Error ? error.message : String(error)}`,
			path: manifestPath,
			packageId,
		});
		return HcpClientemptypackageoverlay({ packageRoot, packageId, selectedProfiles, diagnostics });
	}

	const selectedProfileClosure = HcpClientpackageprofileclosure(manifest, selectedProfiles, manifestPath, diagnostics);

	// Load magnets from manifest component declarations, filtered by profile.
	// Profile semantics: when profiles are selected, load components tagged with
	// any selected profile PLUS untagged (always-load) components. When no profiles
	// are selected, load everything.
	const allComponents = manifest.components ?? [];
	const selectedComponents =
		selectedProfileClosure !== undefined
			? allComponents.filter((c) => {
					const tags = c.profiles ?? [];
					return tags.length === 0 || tags.some((t) => selectedProfileClosure.has(t));
				})
			: allComponents;
	const components = HcpClientdedupepackagedeclarations(selectedComponents, manifest.id, manifestPath, diagnostics);
	const magnetResult = await HcpClientloadpackagemagnets(packageRoot, manifest.id, manifest.version!, components);

	// Convert loader diagnostics to overlay diagnostics
	for (const loaderDiag of magnetResult.diagnostics) {
		diagnostics.push({
			type: loaderDiag.type,
			code: loaderDiag.code,
			message: loaderDiag.message,
			path: loaderDiag.path,
			packageId: loaderDiag.packageId,
		});
	}

	const loadedComponents = magnetResult.magnets;
	const packageInfo: HcpClientharnesspackage = {
		id: manifest.id,
		dir: packageRoot,
		manifest: { components: manifest.components ?? [], profiles: manifest.profiles ?? [] },
	};
	return {
		repoRoot: dirname(packageRoot),
		packagesRoot: dirname(packageRoot),
		selections: [{ packageId: manifest.id, ...(selectedProfiles ? { profiles: [...selectedProfiles] } : {}) }],
		packages: [packageInfo],
		packageId: manifest.id,
		packageVersion: manifest.version!,
		packageRoot,
		source: manifest.source!,
		profiles: manifest.profiles ?? [],
		components: loadedComponents,
		componentMap: new Map(loadedComponents.map((component) => [component.key, component])),
		overrides: [],
		infrastructure: magnetResult.infrastructure,
		diagnostics,
	};
}

function HcpClientdedupepackagedeclarations(
	components: readonly HcpClientpackagecomponentdeclaration[],
	packageId: string,
	manifestPath: string,
	diagnostics: HcpClientpackagediagnostic[],
): HcpClientpackagecomponentdeclaration[] {
	const seen = new Set<string>();
	const unique: HcpClientpackagecomponentdeclaration[] = [];
	for (const component of components) {
		const kind =
			component.kind === "prompt"
				? "prompt-template"
				: component.kind === "append-system-prompt"
					? "system-prompt"
					: component.kind;
		const key = `${kind}:${component.name}:${component.source}`;
		if (seen.has(key)) {
			diagnostics.push({
				type: "error",
				code: "package_component_invalid",
				message: `Package component ${kind}:${component.name} from source ${component.source} is declared more than once.`,
				path: manifestPath,
				packageId,
			});
			continue;
		}
		seen.add(key);
		unique.push(component);
	}
	return unique;
}

async function HcpClientloadlegacyoverlay(
	packageRoot: string,
	manifest: HcpClientpackagemanifest,
	selectedProfiles: readonly string[] | undefined,
): Promise<HcpClientpackageoverlay> {
	const packagesRoot = dirname(packageRoot);
	const selection: HcpClientpackageprofileselectionv1 = {
		packageId: manifest.id,
		...(selectedProfiles ? { profiles: [...selectedProfiles] } : {}),
	};
	const legacy = await HcpClientloadpackageoverlayv1({
		repoRoot: packagesRoot,
		packagesRoot,
		selections: [selection],
	});
	const converted = await HcpClientconvertlegacycomponents(legacy.components, manifest.version ?? "0.0.0");
	const diagnostics: HcpClientpackagediagnostic[] = [
		...legacy.diagnostics.map((diagnostic) => ({
			type: diagnostic.type,
			code: diagnostic.code,
			message: diagnostic.message,
			path: diagnostic.path,
			packageId: diagnostic.packageId ?? manifest.id,
			profile: diagnostic.profile,
		})),
		...converted.diagnostics.map((diagnostic) => ({
			type: diagnostic.type,
			code: diagnostic.code,
			message: diagnostic.message,
			path: diagnostic.path,
			packageId: diagnostic.packageId,
		})),
	];
	const packages: HcpClientharnesspackage[] = legacy.packages.map((pkg) => ({
		id: pkg.id,
		dir: pkg.dir,
		manifest: {
			components: pkg.manifest.components.map((component) => ({
				kind: component.kind,
				name: component.name,
				source: component.source ?? pkg.id,
				path: component.path ?? "",
				profiles: component.profiles,
				include_in_context: component.includeInContext,
				description: component.description,
			})),
			profiles: pkg.manifest.profiles.map((profile) => ({
				name: profile.name,
				description: profile.description,
				extends: profile.extends,
			})),
		},
	}));
	const components = converted.magnets;
	return {
		repoRoot: legacy.repoRoot,
		packagesRoot: legacy.packagesRoot,
		selections: [{ packageId: manifest.id, ...(selectedProfiles ? { profiles: [...selectedProfiles] } : {}) }],
		packages,
		packageId: manifest.id,
		packageVersion: manifest.version ?? "0.0.0",
		packageRoot,
		source: manifest.source ?? manifest.id,
		profiles: packages[0]?.manifest.profiles ? [...packages[0].manifest.profiles] : [],
		components,
		componentMap: new Map(components.map((component) => [component.key, component])),
		overrides: [],
		infrastructure: converted.infrastructure,
		diagnostics,
	};
}

function HcpClientpackageprofileclosure(
	manifest: HcpClientpackagemanifest,
	selectedProfiles: readonly string[] | undefined,
	manifestPath: string,
	diagnostics: HcpClientpackagediagnostic[],
): Set<string> | undefined {
	const profiles = manifest.profiles ?? [];
	const byName = new Map(profiles.map((profile) => [profile.name, profile]));
	const requested = selectedProfiles?.length ? [...selectedProfiles] : [...(manifest.default_profiles ?? [])];
	const expanded = requested.some((profile) => profile === "*" || profile === "all")
		? profiles.map((profile) => profile.name)
		: requested;
	if (expanded.length === 0) return undefined;

	const closure = new Set<string>();
	const invalid = new Set<string>();
	const visiting: string[] = [];
	const visit = (name: string): void => {
		if (closure.has(name) || invalid.has(name)) return;
		const profile = byName.get(name);
		if (!profile) {
			diagnostics.push({
				type: "error",
				code: "package_profile_missing",
				message: `Package ${manifest.id} does not declare profile ${name}.`,
				path: manifestPath,
				packageId: manifest.id,
				profile: name,
			});
			invalid.add(name);
			return;
		}
		const cycleIndex = visiting.indexOf(name);
		if (cycleIndex >= 0) {
			const cycle = [...visiting.slice(cycleIndex), name];
			diagnostics.push({
				type: "error",
				code: "package_profile_cycle",
				message: `Package ${manifest.id} has cyclic profile inheritance: ${cycle.join(" -> ")}.`,
				path: manifestPath,
				packageId: manifest.id,
				profile: name,
			});
			for (const member of cycle) invalid.add(member);
			return;
		}
		visiting.push(name);
		for (const parent of profile.extends ?? []) visit(parent);
		visiting.pop();
		if ((profile.extends ?? []).some((parent) => invalid.has(parent))) invalid.add(name);
		else closure.add(name);
	};
	for (const profile of expanded) visit(profile);
	return closure;
}
