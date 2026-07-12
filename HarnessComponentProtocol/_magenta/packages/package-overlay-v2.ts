/**
 * Package overlay v2: isomorphic HCP structure loader.
 * 
 * Replaces the v1 flat package.toml [[components]] parser with a directory-tree
 * scanner that discovers modules/<source>/HcpMagnet.ts, dynamically imports them,
 * and constructs HcpClientcomponent entries for the unified session assembly.
 * 
 * V2 packages have this structure (matching HarnessComponentProtocol):
 *   <package-root>/
 *     package.toml (id, version, source, profiles)
 *     memory/<source>/HcpMagnet.ts
 *     tools/<tool>/<source>/HcpMagnet.ts
 *     skills/<skill>/<source>/HcpMagnet.ts
 * 
 * Each HcpMagnet is a bare class (spec §2) with static module/kind/source,
 * static build(), and a product method (toTool/toCapability/toResource or
 * descriptor() for tools). The runtime magnet loader imports these, validates
 * shape, and hands them to the same HcpClient assembly pipeline as host magnets.
 */

import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as TOML from "smol-toml";
import type { HcpClientcomponent } from "../../.HCP/assembly/session-hcp.ts";
import { loadPackageMagnets, type LoadedPackageMagnet, type PackageComponentDeclaration } from "./runtime-magnet-loader.ts";

/** Selection of a package plus optional profile narrowing (e.g. "AutOmicScience:single-cell,spatial"). */
export type PackageProfileSelection = {
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
export function getHarnessPackagesRoot(repoRoot: string = process.cwd()): string {
	return resolve(repoRoot, "packages");
}

/** Parse a "PackageId:profile1,profile2" selector into id + profiles. */
export function parsePackageSelector(selector: string): PackageProfileSelection {
	const [packageId, profileList] = selector.split(":", 2);
	const profiles = profileList
		? profileList
				.split(",")
				.map((p) => p.trim())
				.filter((p) => p.length > 0)
		: undefined;
	return { packageId: packageId!.trim(), ...(profiles && profiles.length > 0 ? { profiles } : {}) };
}

export type PackageManifest = {
	schema_version: string;
	id: string;
	name: string;
	version: string;
	source: string;
	kind?: string;
	domain?: string;
	description?: string;
	default_profiles?: string[];
	profiles?: PackageProfile[];
	components?: PackageComponentDeclaration[];
};

export type PackageProfile = {
	name: string;
	description?: string;
	extends?: string[];
};

/** View shape for TUI package discovery/menu (maps v2 PackageOverlay to legacy shape). */
export type HarnessPackage = {
	id: string;
	dir: string;
	manifest: {
		components: readonly PackageComponentDeclaration[];
		profiles: readonly PackageProfile[];
	};
};

export type PackageOverlay = {
	packageId: string;
	packageVersion: string;
	packageRoot: string;
	source: string;
	profiles: PackageProfile[];
	components: LoadedPackageMagnet[];
	diagnostics: PackageDiagnostic[];
};

export type PackageDiagnostic = {
	type: "error" | "warning";
	code: string;
	message: string;
	path?: string;
	packageId: string;
	profile?: string;
};

/** Progress signal emitted while a package overlay is assembled into a session. */
export type PackageAssemblyProgress = {
	phase: "start" | "assembled";
	index: number;
	total: number;
	component: LoadedPackageMagnet;
};

/**
 * Options for loading a package overlay across a packages root, matching the
 * host resource-loader consumption shape.
 */
export type LoadPackageOverlayOptions = {
	repoRoot?: string;
	packagesRoot?: string;
	selections: readonly (string | PackageProfileSelection)[];
};

/**
 * Discover all packages under a packages root directory for the TUI menu.
 * Reads each package.toml manifest (id, components, profiles) without loading
 * or validating magnets — this is a lightweight listing for selection.
 */
export async function discoverHarnessPackages(options: {
	repoRoot?: string;
	packagesRoot?: string;
}): Promise<{ packagesRoot: string; packages: HarnessPackage[]; diagnostics: PackageDiagnostic[] }> {
	const { readdir, stat } = await import("node:fs/promises");
	const packagesRoot = resolve(options.packagesRoot ?? getHarnessPackagesRoot(options.repoRoot));
	const diagnostics: PackageDiagnostic[] = [];

	try {
		const entries = await readdir(packagesRoot, { withFileTypes: true });
		const packageDirs = entries
			.filter((e) => e.isDirectory() && !e.name.startsWith("."))
			.map((e) => join(packagesRoot, e.name));

		const packages: HarnessPackage[] = [];
		for (const packageDir of packageDirs) {
			const manifestPath = join(packageDir, "package.toml");
			try {
				await stat(manifestPath);
			} catch {
				continue;
			}
			try {
				const manifest = TOML.parse(await readFile(manifestPath, "utf-8")) as PackageManifest;
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
					packageId: packageDir.split("/").pop() ?? "unknown",
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
export async function loadPackageOverlay(options: LoadPackageOverlayOptions): Promise<PackageOverlay> {
	const packagesRoot = resolve(options.packagesRoot ?? getHarnessPackagesRoot(options.repoRoot));
	const diagnostics: PackageDiagnostic[] = [];
	const merged = new Map<string, LoadedPackageMagnet>();
	const mergedProfiles: PackageProfile[] = [];
	let primaryId = "";
	let primaryVersion = "0.0.0";
	let primarySource = "";
	let primaryRoot = packagesRoot;

	for (const selection of options.selections) {
		const parsed = typeof selection === "string" ? parsePackageSelector(selection) : selection;
		const { packageId, profiles } = parsed;
		// An explicit packageRoot (e.g. from the acquisition cache) wins over the
		// <packagesRoot>/<packageId> convention.
		const packageRoot = parsed.packageRoot ?? join(packagesRoot, packageId);
		const overlay = await loadSinglePackage(packageRoot, profiles);
		diagnostics.push(...overlay.diagnostics);
		if (!primaryId) {
			primaryId = overlay.packageId;
			primaryVersion = overlay.packageVersion;
			primarySource = overlay.source;
			primaryRoot = overlay.packageRoot;
		}
		mergedProfiles.push(...overlay.profiles);
		// Later components with the same kind:name replace earlier ones.
		for (const component of overlay.components) {
			merged.set(`${component.kind}:${component.name}`, component);
		}
	}

	return {
		packageId: primaryId,
		packageVersion: primaryVersion,
		packageRoot: primaryRoot,
		source: primarySource,
		profiles: mergedProfiles,
		components: [...merged.values()],
		diagnostics,
	};
}

/**
 * Load a single package from its root directory, optionally filtering components
 * by selected profiles.
 *
 * Reads package.toml manifest (authoritative component list per spec §2.1),
 * resolves each component's <path>/HcpMagnet.ts, dynamically imports and
 * validates them, and constructs HcpClientcomponent entries.
 */
export async function loadSinglePackage(inputPackageRoot: string, selectedProfiles?: readonly string[]): Promise<PackageOverlay> {
	const diagnostics: PackageDiagnostic[] = [];

	// Normalize to the real path so paths derived here share the same basis as
	// the magnets' own import.meta.url resolution (which realpath-resolves
	// symlinks, e.g. macOS /var -> /private/var). Without this, package tool
	// command containment checks (isWithinDir) spuriously reject descriptor-
	// relative commands whose realpath differs from the unresolved packageRoot.
	const packageRoot = await realpath(inputPackageRoot).catch(() => inputPackageRoot);

	// Parse manifest
	const manifestPath = join(packageRoot, "package.toml");
	let manifest: PackageManifest;
	try {
		const tomlContent = await readFile(manifestPath, "utf-8");
		manifest = TOML.parse(tomlContent) as PackageManifest;
		
		// Validate required fields
		if (!manifest.id || !manifest.name || !manifest.version || !manifest.source) {
			diagnostics.push({
				type: "error",
				code: "package_manifest_incomplete",
				message: `package.toml must declare id, name, version, source`,
				path: manifestPath,
				packageId: manifest.id ?? "unknown",
			});
			// Return empty overlay on critical manifest error
			return {
				packageId: manifest.id ?? "unknown",
				packageVersion: manifest.version ?? "0.0.0",
				packageRoot,
				source: manifest.source ?? "unknown",
				profiles: [],
				components: [],
				diagnostics,
			};
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
		const packageId = packageRoot.split("/").pop() ?? "unknown";
		diagnostics.push({
			type: "error",
			code: "package_manifest_parse_failed",
			message: `Failed to parse package.toml: ${error instanceof Error ? error.message : String(error)}`,
			path: manifestPath,
			packageId,
		});
		return {
			packageId,
			packageVersion: "0.0.0",
			packageRoot,
			source: "unknown",
			profiles: [],
			components: [],
			diagnostics,
		};
	}
	
	// Load magnets from manifest component declarations, filtered by profile.
	// Profile semantics: when profiles are selected, load components tagged with
	// any selected profile PLUS untagged (always-load) components. When no profiles
	// are selected, load everything.
	const allComponents = manifest.components ?? [];
	const components =
		selectedProfiles && selectedProfiles.length > 0
			? allComponents.filter((c) => {
					const tags = c.profiles ?? [];
					return tags.length === 0 || tags.some((t) => selectedProfiles.includes(t));
				})
			: allComponents;
	const magnetResult = await loadPackageMagnets(packageRoot, manifest.id, manifest.version, components);
	
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
	
	return {
		packageId: manifest.id,
		packageVersion: manifest.version,
		packageRoot,
		source: manifest.source,
		profiles: manifest.profiles ?? [],
		components: magnetResult.magnets,
		diagnostics,
	};
}
