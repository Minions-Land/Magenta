/**
 * Runtime magnet loader for v2 packages with isomorphic HCP structure.
 *
 * Manifest-driven: reads [[components]] declarations from package.toml (the
 * authoritative source per spec §2.1), and for each component resolves
 * <package-root>/<component.path>/HcpMagnet.{mjs,js,ts}, dynamically imports it,
 * validates the bare-class shape, and constructs an HcpClientcomponent entry
 * for the unified session assembly.
 *
 * Per contract from MagentaPackages collaboration:
 * - Package magnets use import.meta.url-relative paths (cache-relocatable).
 * - Export裸 class (no interface, structural typing per spec §2).
 * - static build + module/kind/source; exactly one product method from
 *   {toTool, toCapability, toResource}. Tool Sources receive a Client-owned
 *   builder through build settings, so host infrastructure never replaces the
 *   package's real HcpMagnet.
 * - Infra-only kinds (python-runtime/runtime-tests/env/env-lock) have no
 *   HcpMagnet.ts and are skipped here; they are referenced by tool descriptors
 *   and resolved by the host tool build chain.
 */

import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import * as TOML from "smol-toml";
import type { HcpClientcomponent } from "../../.HCP/assembly/session-hcp.ts";
import { HCP_MAGNETS, HCP_SERVERS } from "../../.HCP/assembly/sources.generated.ts";
import type { HcpMagnetBuildContext, HcpMagnetResource } from "../../.HCP/HcpMagnetTypes.ts";
import type { HcpClientpackageresolvedcomponentv1 } from "./package-overlay-v1-compat.ts";

/** Component declaration as it appears in package.toml [[components]]. */
export type HcpClientpackagecomponentdeclaration = {
	kind: string;
	name: string;
	source: string;
	path: string;
	slot?: string;
	requires?: string[];
	profiles?: string[];
	include_in_context?: boolean;
	description?: string;
};

export type HcpClientpackageloadedmagnet = HcpClientcomponent & {
	packageId: string;
	packageVersion: string;
	packageRoot: string;
	profiles: string[];
	includeInContext: boolean;
	key: string;
	profile?: string;
};

export type HcpClientpackageinfrastructuredeclaration = {
	packageId: string;
	packageRoot: string;
	kind: string;
	name: string;
	path: string;
	sourcePath: string;
};

export type HcpClientpackagemagnetloaderdiagnostic = {
	type: "error" | "warning";
	code: string;
	message: string;
	path: string;
	packageId: string;
};

export type HcpClientpackagemagnetloaderresult = {
	magnets: HcpClientpackageloadedmagnet[];
	infrastructure: HcpClientpackageinfrastructuredeclaration[];
	diagnostics: HcpClientpackagemagnetloaderdiagnostic[];
};

/** Kinds that are package-local infrastructure with no HcpMagnet role. */
const HcpClientpackageinfrakinds = new Set(["python-runtime", "runtime-tests", "env", "env-lock"]);
const HcpClientpackagerolesuffixes = [".mjs", ".js", ".ts"] as const;
const HcpClientpackageimportcache = new Map<string, Promise<Record<string, unknown>>>();
const HcpClientpackageresourcekinds = new Set([
	"append-system-prompt",
	"brand",
	"prompt",
	"prompt-template",
	"skill",
	"system-prompt",
	"theme",
]);

type HcpMagnetclass = {
	readonly module: string;
	readonly kind: string;
	readonly source: string;
	build(context: unknown): unknown;
};

type HcpMagnettoolproduct = {
	readonly kind: string;
	toTool(): AgentTool;
	close?(): void | Promise<void>;
};

type HcpClientpackagetoolbuildsettings = {
	HcpClientbuildtools?(
		descriptor: { kind: "tool"; name: string; source: string; descriptorPath: string },
		context: HcpMagnetBuildContext,
	): Promise<HcpMagnettoolproduct[]>;
};

type HcpServerclass = new () => {
	readonly moduleName: string;
	readonly description?: string;
};

type HcpClientpackageproductresolution = {
	product: HcpClientcomponent["product"];
	slot?: string;
	requires: string[];
};

/** Convert validated v1 flat components into the same Client input shape as v2 Magnets. */
export async function HcpClientconvertlegacycomponents(
	components: readonly HcpClientpackageresolvedcomponentv1[],
	packageVersion = "0.0.0",
): Promise<HcpClientpackagemagnetloaderresult> {
	const magnets: HcpClientpackageloadedmagnet[] = [];
	const infrastructure: HcpClientpackageinfrastructuredeclaration[] = [];
	const diagnostics: HcpClientpackagemagnetloaderdiagnostic[] = [];

	for (const component of components) {
		if (HcpClientpackageinfrakinds.has(component.kind)) {
			if (!component.path) {
				diagnostics.push({
					type: "error",
					code: "package_component_missing",
					message: `Package ${component.packageId} ${component.kind}:${component.name} has no path.`,
					path: component.sourcePath,
					packageId: component.packageId,
				});
				continue;
			}
			infrastructure.push({
				packageId: component.packageId,
				packageRoot: component.packageDir,
				kind: component.kind,
				name: component.name,
				path: component.path,
				sourcePath: component.sourcePath,
			});
			continue;
		}

		const module = HcpClientlegacymodule(component.kind);
		const descriptorPath = component.path ?? component.sourcePath;
		if (!module) {
			const capability = HcpClientlegacycapabilitycomponent(component, packageVersion, diagnostics);
			if (capability) magnets.push(capability);
			continue;
		}
		const HcpServer = HCP_SERVERS.get(module);
		if (!HcpServer) {
			diagnostics.push({
				type: "error",
				code: "package_legacy_server_missing",
				message: `Package ${component.packageId} v1 component ${component.kind}:${component.name} has no host HcpServer for ${module}.`,
				path: descriptorPath,
				packageId: component.packageId,
			});
			continue;
		}

		const source = component.source ?? component.packageId;
		let HcpMagnet: HcpClientcomponent["HcpMagnet"];
		let product: HcpClientcomponent["product"];
		if (component.kind === "tool") {
			if (!component.path) {
				diagnostics.push({
					type: "error",
					code: "package_component_missing",
					message: `Package ${component.packageId} tool ${component.name} has no descriptor path.`,
					path: component.sourcePath,
					packageId: component.packageId,
				});
				continue;
			}
			HcpMagnet = HcpClientlegacytoolmagnetclass(module, source, component.name, component.path);
			product = "tool";
		} else {
			const resource = await HcpClientlegacyresource(component, diagnostics);
			if (!resource) continue;
			HcpMagnet = HcpClientlegacyresourcemagnetclass(module, resource.kind, source, resource);
			product = "resource";
		}

		const includeInContext = component.includeInContext ?? true;
		const canonicalKind = product === "resource" ? HcpClientlegacyresourcekind(component.kind) : component.kind;
		magnets.push({
			module,
			kind: canonicalKind,
			name: component.name,
			product,
			source,
			selected: true,
			autoload: product !== "tool",
			hotSwappable: false,
			descriptorPath,
			requires: product === "tool" ? ["runtime:process", "sandbox"] : [],
			HcpMagnet,
			HcpServer,
			overrideExisting: true,
			packageId: component.packageId,
			packageVersion,
			packageRoot: component.packageDir,
			profiles: component.profile ? [component.profile] : [],
			includeInContext,
			key: component.kind === "append-system-prompt" ? component.key : `${canonicalKind}:${component.name}`,
			...(component.profile ? { profile: component.profile } : {}),
			HcpClientresourcemetadata:
				product === "resource"
					? {
							origin: "package",
							packageId: component.packageId,
							packageDir: component.packageDir,
							...(component.profile ? { profile: component.profile } : {}),
							includeInContext,
							sourcePath: component.sourcePath,
						}
					: undefined,
		});
	}

	return { magnets, infrastructure, diagnostics };
}

function HcpClientlegacymodule(kind: string): string | undefined {
	switch (kind) {
		case "tool":
			return "tools";
		case "skill":
			return "skills";
		case "prompt":
		case "prompt-template":
			return "prompt-templates";
		case "theme":
			return "themes";
		case "brand":
			return "brand";
		case "system-prompt":
		case "append-system-prompt":
			return "system-prompt";
		default:
			return undefined;
	}
}

function HcpClientlegacyresourcekind(kind: string): string {
	if (kind === "prompt") return "prompt-template";
	if (kind === "append-system-prompt") return "system-prompt";
	return kind;
}

function HcpClientlegacycapabilitycomponent(
	component: HcpClientpackageresolvedcomponentv1,
	packageVersion: string,
	diagnostics: HcpClientpackagemagnetloaderdiagnostic[],
): HcpClientpackageloadedmagnet | undefined {
	const candidates = (HCP_MAGNETS as readonly HcpClientcomponent[]).filter(
		(entry) => entry.product === "capability" && entry.kind === component.kind,
	);
	const matches = candidates.filter((entry) => entry.slot === component.key || entry.name === component.name);
	if (matches.length === 0) {
		diagnostics.push({
			type: "error",
			code: candidates.length === 0 ? "package_legacy_kind_unsupported" : "package_component_invalid",
			message:
				candidates.length === 0
					? `Package ${component.packageId} uses unsupported v1 component kind ${component.kind}.`
					: `Package ${component.packageId} ${component.key} has no matching HCP capability component.`,
			path: component.path ?? component.sourcePath,
			packageId: component.packageId,
		});
		return undefined;
	}

	const source = component.source ?? matches.find((entry) => entry.selected)?.source;
	const selected = matches.find((entry) => entry.source === source);
	if (!selected) {
		diagnostics.push({
			type: "error",
			code: "package_component_invalid",
			message: `Package ${component.packageId} ${component.key} selects unavailable source ${source ?? "<missing>"}.`,
			path: component.path ?? component.sourcePath,
			packageId: component.packageId,
		});
		return undefined;
	}

	return {
		...selected,
		name: component.name,
		selected: true,
		autoload: true,
		descriptorPath: component.path ?? selected.descriptorPath,
		overrideExisting: true,
		packageId: component.packageId,
		packageVersion,
		packageRoot: component.packageDir,
		profiles: component.profile ? [component.profile] : [],
		includeInContext: component.includeInContext ?? true,
		key: component.key,
		...(component.profile ? { profile: component.profile } : {}),
	};
}

async function HcpClientlegacyresource(
	component: HcpClientpackageresolvedcomponentv1,
	diagnostics: HcpClientpackagemagnetloaderdiagnostic[],
): Promise<HcpMagnetResource | undefined> {
	let contentPath = component.path;
	let resourceKind = HcpClientlegacyresourcekind(component.kind);
	let mergeMode: HcpMagnetResource["mergeMode"] = "replace";
	if (component.kind === "system-prompt" || component.kind === "append-system-prompt") {
		if (!component.path) return undefined;
		try {
			const descriptor = TOML.parse(await readFile(component.path, "utf-8")) as Record<string, unknown>;
			const reference = descriptor.content_path;
			if (typeof reference !== "string" || reference.length === 0) {
				throw new Error("descriptor does not declare content_path");
			}
			const candidate = resolve(dirname(component.path), reference);
			if (!HcpClientiswithinpackage(component.packageDir, candidate)) {
				throw new Error(`content_path escapes the package root: ${reference}`);
			}
			try {
				const actualPackageRoot = await realpath(component.packageDir).catch(() => component.packageDir);
				const actual = await realpath(candidate);
				if (!HcpClientiswithinpackage(actualPackageRoot, actual)) {
					throw new Error(`content_path resolves outside the package root: ${reference}`);
				}
				// The real path is used only for containment. Preserve the lexical
				// package path in Resource diagnostics and user-visible metadata.
				contentPath = candidate;
			} catch (error) {
				if (error instanceof Error && error.message.includes("outside the package root")) throw error;
				// Preserve the expected in-package path so the Resource loader reports
				// a precise missing-file diagnostic instead of injecting the path text.
				contentPath = candidate;
			}
			resourceKind = "system-prompt";
			mergeMode = component.kind === "append-system-prompt" ? "append" : "replace";
		} catch (error) {
			diagnostics.push({
				type: "error",
				code: "package_component_invalid",
				message: `Package ${component.packageId} ${component.kind}:${component.name} is invalid: ${
					error instanceof Error ? error.message : String(error)
				}`,
				path: component.path,
				packageId: component.packageId,
			});
			return undefined;
		}
	}

	if (!contentPath) {
		diagnostics.push({
			type: "error",
			code: "package_component_missing",
			message: `Package ${component.packageId} ${component.kind}:${component.name} has no content path.`,
			path: component.sourcePath,
			packageId: component.packageId,
		});
		return undefined;
	}

	return {
		kind: resourceKind,
		name: component.name,
		source: component.source ?? component.packageId,
		mergeMode,
		contentPath,
	};
}

function HcpClientlegacytoolmagnetclass(
	module: string,
	source: string,
	name: string,
	descriptorPath: string,
): HcpClientcomponent["HcpMagnet"] {
	return class HcpMagnet {
		static readonly module = module;
		static readonly kind = "tool";
		static readonly source = source;
		static async build(context: HcpMagnetBuildContext) {
			const settings = context.settings as HcpClientpackagetoolbuildsettings | undefined;
			if (typeof settings?.HcpClientbuildtools !== "function") {
				throw new Error(`Package tool ${name} has no HcpClient Tool builder.`);
			}
			const products = await settings.HcpClientbuildtools({ kind: "tool", name, source, descriptorPath }, context);
			const magnets = products.map((product) => new HcpMagnet(product));
			if (magnets.length === 0) return undefined;
			return magnets.length === 1 ? magnets[0] : magnets;
		}

		readonly kind: string;
		readonly source = source;
		readonly product: HcpMagnettoolproduct;

		constructor(product: HcpMagnettoolproduct) {
			this.product = product;
			this.kind = product.kind;
		}

		toTool(): AgentTool {
			return this.product.toTool();
		}

		async dispose(): Promise<void> {
			await this.product.close?.();
		}
	};
}

function HcpClientlegacyresourcemagnetclass(
	module: string,
	kind: string,
	source: string,
	resource: HcpMagnetResource,
): HcpClientcomponent["HcpMagnet"] {
	return class HcpMagnet {
		static readonly module = module;
		static readonly kind = kind;
		static readonly source = source;
		static build() {
			return new HcpMagnet();
		}

		readonly kind = `resource:${resource.kind}`;
		readonly source = source;

		toResource(): HcpMagnetResource {
			return resource;
		}
	};
}

/**
 * Load magnets for a package from its manifest component declarations.
 * Each non-infra component resolves one unambiguous
 * <packageRoot>/<component.path>/HcpMagnet.{mjs,js,ts} role.
 */
export async function HcpClientloadpackagemagnets(
	packageRoot: string,
	packageId: string,
	packageVersion: string,
	components: readonly HcpClientpackagecomponentdeclaration[],
): Promise<HcpClientpackagemagnetloaderresult> {
	const magnets: HcpClientpackageloadedmagnet[] = [];
	const infrastructure: HcpClientpackageinfrastructuredeclaration[] = [];
	const diagnostics: HcpClientpackagemagnetloaderdiagnostic[] = [];
	const servers = new Map<string, HcpServerclass>();
	for (const declaration of components) {
		const componentPath = await HcpClientresolvepackagepath(
			packageRoot,
			declaration.path,
			packageId,
			`${declaration.kind}:${declaration.name}`,
			diagnostics,
		);
		if (!componentPath) continue;

		// Skip infra-only kinds (no HcpMagnet role; referenced by tool descriptors)
		if (HcpClientpackageinfrakinds.has(declaration.kind)) {
			infrastructure.push({
				packageId,
				packageRoot,
				kind: declaration.kind,
				name: declaration.name,
				path: componentPath,
				sourcePath: join(packageRoot, "package.toml"),
			});
			continue;
		}

		const magnetPath = await HcpClientresolvepackagerole({
			packageRoot,
			roleDirectory: componentPath,
			roleName: "HcpMagnet",
			packageId,
			owner: `Component ${declaration.kind}:${declaration.name}`,
			missingCode: "magnet_not_found",
			diagnostics,
		});
		if (!magnetPath) continue;

		try {
			// A content-hash cache key keeps unchanged Modules cached while allowing
			// local package role edits to reload in the same Node or Bun process.
			const imported = await HcpClientimportpackagefile(magnetPath);
			if (typeof imported.HcpMagnet !== "function") {
				diagnostics.push({
					type: "error",
					code: "magnet_missing_export",
					message: `${magnetPath} does not export class HcpMagnet`,
					path: magnetPath,
					packageId,
				});
				continue;
			}

			const MagnetClass = imported.HcpMagnet as unknown as HcpMagnetclass;
			const expectedModule = HcpClientpackagemodulefrompath(declaration.path);
			if (!expectedModule || MagnetClass.module !== expectedModule) {
				diagnostics.push({
					type: "error",
					code: "magnet_module_mismatch",
					message: `${magnetPath}: static module="${MagnetClass.module}" does not match declaration module="${expectedModule ?? "<invalid>"}"`,
					path: magnetPath,
					packageId,
				});
				continue;
			}

			const productResolution = HcpClientresolvepackageproduct(declaration);
			if ("error" in productResolution) {
				diagnostics.push({
					type: "error",
					code: "package_component_invalid",
					message: `${magnetPath}: ${productResolution.error}`,
					path: magnetPath,
					packageId,
				});
				continue;
			}

			// Validate shape against the manifest declaration.
			const diagnostic = HcpClientvalidatemagnetshape(
				MagnetClass,
				declaration,
				productResolution.product,
				magnetPath,
				packageId,
			);
			if (diagnostic) {
				diagnostics.push(diagnostic);
				if (diagnostic.type === "error") continue;
			}

			const HcpServer = await HcpClientloadpackageserver(
				packageRoot,
				MagnetClass.module,
				packageId,
				servers,
				diagnostics,
			);
			if (!HcpServer) continue;

			// Construct HcpClientcomponent entry with its real owning Module Server.
			magnets.push(
				HcpClientconstructpackagecomponent(
					MagnetClass,
					HcpServer,
					declaration,
					packageRoot,
					packageId,
					packageVersion,
					productResolution,
				),
			);
		} catch (error) {
			diagnostics.push({
				type: "error",
				code: "magnet_import_failed",
				message: `Failed to import ${magnetPath}: ${error instanceof Error ? error.message : String(error)}`,
				path: magnetPath,
				packageId,
			});
		}
	}

	return { magnets, infrastructure, diagnostics };
}

async function HcpClientresolvepackagepath(
	packageRoot: string,
	reference: string,
	packageId: string,
	component: string,
	diagnostics: HcpClientpackagemagnetloaderdiagnostic[],
): Promise<string | undefined> {
	const normalizedReference = reference.replaceAll("\\", "/");
	if (
		!normalizedReference.trim() ||
		isAbsolute(reference) ||
		posix.isAbsolute(normalizedReference) ||
		win32.isAbsolute(reference)
	) {
		diagnostics.push({
			type: "error",
			code: "package_component_path_invalid",
			message: `Package ${packageId} ${component} path must be package-local: ${reference}`,
			path: reference,
			packageId,
		});
		return undefined;
	}
	const candidate = resolve(packageRoot, normalizedReference);
	if (!HcpClientiswithinpackage(packageRoot, candidate)) {
		diagnostics.push({
			type: "error",
			code: "package_component_path_invalid",
			message: `Package ${packageId} ${component} path escapes the package root: ${reference}`,
			path: candidate,
			packageId,
		});
		return undefined;
	}
	try {
		const actual = await realpath(candidate);
		if (!HcpClientiswithinpackage(packageRoot, actual)) {
			diagnostics.push({
				type: "error",
				code: "package_component_path_invalid",
				message: `Package ${packageId} ${component} path resolves outside the package root: ${reference}`,
				path: actual,
				packageId,
			});
			return undefined;
		}
		return actual;
	} catch {
		diagnostics.push({
			type: "error",
			code: "package_component_missing",
			message: `Package ${packageId} ${component} path is missing: ${reference}`,
			path: candidate,
			packageId,
		});
		return undefined;
	}
}

function HcpClientiswithinpackage(packageRoot: string, candidate: string): boolean {
	const pathFromRoot = relative(packageRoot, candidate);
	return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

function HcpClientpackagemodulefrompath(reference: string): string | undefined {
	const normalized = reference.replaceAll("\\", "/").replace(/^\.\//u, "");
	const module = posix.dirname(normalized);
	return module && module !== "." && !module.startsWith("../") ? module : undefined;
}

async function HcpClientloadpackageserver(
	packageRoot: string,
	module: string,
	packageId: string,
	servers: Map<string, HcpServerclass>,
	diagnostics: HcpClientpackagemagnetloaderdiagnostic[],
): Promise<HcpServerclass | undefined> {
	const serverPath = await HcpClientresolvepackagerole({
		packageRoot,
		roleDirectory: join(packageRoot, module),
		roleName: "HcpServer",
		packageId,
		owner: `Package Module ${module}`,
		missingCode: "server_not_found",
		diagnostics,
	});
	if (!serverPath) return undefined;
	const cached = servers.get(serverPath);
	if (cached) return cached;
	try {
		const imported = await HcpClientimportpackagefile(serverPath);
		if (typeof imported.HcpServer !== "function") {
			diagnostics.push({
				type: "error",
				code: "server_missing_export",
				message: `${serverPath} does not export class HcpServer`,
				path: serverPath,
				packageId,
			});
			return undefined;
		}
		const HcpServer = imported.HcpServer as HcpServerclass;
		const server = new HcpServer();
		if (server.moduleName !== module) {
			diagnostics.push({
				type: "error",
				code: "server_module_mismatch",
				message: `${serverPath}: moduleName="${server.moduleName}" does not match Magnet module="${module}"`,
				path: serverPath,
				packageId,
			});
			return undefined;
		}
		servers.set(serverPath, HcpServer);
		return HcpServer;
	} catch (error) {
		diagnostics.push({
			type: "error",
			code: "server_import_failed",
			message: `Failed to import ${serverPath}: ${error instanceof Error ? error.message : String(error)}`,
			path: serverPath,
			packageId,
		});
		return undefined;
	}
}

type HcpClientpackageroleresolutionoptions = {
	packageRoot: string;
	roleDirectory: string;
	roleName: "HcpMagnet" | "HcpServer";
	packageId: string;
	owner: string;
	missingCode: "magnet_not_found" | "server_not_found";
	diagnostics: HcpClientpackagemagnetloaderdiagnostic[];
};

/** Discover one role without giving source or compiled output silent precedence. */
async function HcpClientresolvepackagerole(
	options: HcpClientpackageroleresolutionoptions,
): Promise<string | undefined> {
	const roleNames = HcpClientpackagerolesuffixes.map((suffix) => `${options.roleName}${suffix}`);
	const candidates = (
		await Promise.all(
			roleNames.map(async (name) => {
				const candidate = join(options.roleDirectory, name);
				const exists = await stat(candidate).then(
					(value) => value.isFile(),
					() => false,
				);
				return exists ? candidate : undefined;
			}),
		)
	).filter((candidate): candidate is string => candidate !== undefined);

	if (candidates.length === 0) {
		options.diagnostics.push({
			type: "error",
			code: options.missingCode,
			message: `${options.owner} has no ${roleNames.join(", ")} role; exactly one accepted role file is required`,
			path: options.roleDirectory,
			packageId: options.packageId,
		});
		return undefined;
	}
	if (candidates.length > 1) {
		options.diagnostics.push({
			type: "error",
			code: "package_role_ambiguous",
			message: `${options.owner} has ambiguous ${options.roleName} roles: ${candidates
				.map((candidate) => candidate.slice(options.roleDirectory.length + 1))
				.join(", ")}; remove stale source or compiled outputs before loading`,
			path: options.roleDirectory,
			packageId: options.packageId,
		});
		return undefined;
	}

	const [actualPackageRoot, actualRole] = await Promise.all([
		realpath(options.packageRoot).catch(() => resolve(options.packageRoot)),
		realpath(candidates[0]!),
	]);
	if (!HcpClientiswithinpackage(actualPackageRoot, actualRole)) {
		options.diagnostics.push({
			type: "error",
			code: "package_component_path_invalid",
			message: `${options.owner} ${options.roleName} role resolves outside the package root: ${actualRole}`,
			path: actualRole,
			packageId: options.packageId,
		});
		return undefined;
	}
	return actualRole;
}

async function HcpClientimportpackagefile(path: string): Promise<Record<string, unknown>> {
	const digest = createHash("sha256")
		.update(await readFile(path))
		.digest("hex");
	const url = pathToFileURL(path);
	url.searchParams.set("magenta-package-sha256", digest);
	const cacheKey = url.href;
	const cached = HcpClientpackageimportcache.get(cacheKey);
	if (cached) return cached;
	const imported = import(cacheKey) as Promise<Record<string, unknown>>;
	HcpClientpackageimportcache.set(cacheKey, imported);
	try {
		return await imported;
	} catch (error) {
		HcpClientpackageimportcache.delete(cacheKey);
		throw error;
	}
}

/**
 * Validate magnet shape:
 * - static build exists
 * - static module/kind/source are strings
 * - static kind matches manifest declaration kind
 * - static source matches manifest declaration source
 * Returns a diagnostic (error blocks load, warning allows it) or undefined.
 */
function HcpClientvalidatemagnetshape(
	MagnetClass: HcpMagnetclass,
	declaration: HcpClientpackagecomponentdeclaration,
	product: HcpClientcomponent["product"],
	magnetPath: string,
	packageId: string,
): HcpClientpackagemagnetloaderdiagnostic | undefined {
	if (typeof MagnetClass.build !== "function") {
		return {
			type: "error",
			code: "magnet_missing_build",
			message: `${magnetPath}: HcpMagnet.build is not a static function`,
			path: magnetPath,
			packageId,
		};
	}

	if (
		typeof MagnetClass.module !== "string" ||
		typeof MagnetClass.kind !== "string" ||
		typeof MagnetClass.source !== "string"
	) {
		return {
			type: "error",
			code: "magnet_missing_static_fields",
			message: `${magnetPath}: HcpMagnet must declare static module/kind/source strings`,
			path: magnetPath,
			packageId,
		};
	}

	if (MagnetClass.kind !== declaration.kind) {
		return {
			type: "error",
			code: "magnet_kind_mismatch",
			message: `${magnetPath}: static kind="${MagnetClass.kind}" does not match manifest kind="${declaration.kind}"`,
			path: magnetPath,
			packageId,
		};
	}

	if (MagnetClass.source !== declaration.source) {
		return {
			type: "error",
			code: "magnet_source_mismatch",
			message: `${magnetPath}: static source="${MagnetClass.source}" does not match manifest source="${declaration.source}"`,
			path: magnetPath,
			packageId,
		};
	}

	const prototype = (MagnetClass as unknown as { prototype?: Record<string, unknown> }).prototype;
	const productMethods = ["toTool", "toCapability", "toResource"].filter(
		(method) => typeof prototype?.[method] === "function",
	);
	const expectedMethod = product === "tool" ? "toTool" : product === "capability" ? "toCapability" : "toResource";
	if (productMethods.length !== 1 || productMethods[0] !== expectedMethod) {
		return {
			type: "error",
			code: "magnet_product_shape_invalid",
			message: `${magnetPath}: HcpMagnet must define exactly ${expectedMethod}(), found [${productMethods.join(", ") || "none"}]`,
			path: magnetPath,
			packageId,
		};
	}

	return undefined;
}

/**
 * Construct an HcpClientcomponent from a validated package role class and its
 * resolved frozen product/slot metadata. Tool product construction remains a
 * Client-injected dependency of the real package HcpMagnet.
 */
function HcpClientconstructpackagecomponent(
	MagnetClass: HcpMagnetclass,
	HcpServer: HcpServerclass,
	declaration: HcpClientpackagecomponentdeclaration,
	packageRoot: string,
	packageId: string,
	packageVersion: string,
	productResolution: HcpClientpackageproductresolution,
): HcpClientpackageloadedmagnet {
	const { product, slot } = productResolution;
	// descriptorPath points at the source directory that owns the magnet; the
	// magnet itself resolves its own content/toml via import.meta.url, so this
	// is used only for diagnostics and host tool-descriptor resolution.
	const descriptorPath = join(packageRoot, declaration.path);
	return {
		module: MagnetClass.module,
		kind: MagnetClass.kind,
		name: declaration.name,
		product,
		source: MagnetClass.source,
		selected: true,
		autoload: product !== "tool",
		hotSwappable: false,
		descriptorPath,
		slot,
		requires: productResolution.requires,
		HcpMagnet: MagnetClass as HcpClientcomponent["HcpMagnet"],
		HcpServer,
		overrideExisting: true,
		packageId,
		packageVersion,
		packageRoot,
		profiles: declaration.profiles ?? [],
		includeInContext: declaration.include_in_context ?? false,
		key: `${MagnetClass.kind}:${declaration.name}`,
		HcpClientresourcemetadata:
			product === "resource"
				? {
						origin: "package",
						packageId,
						packageDir: packageRoot,
						includeInContext: declaration.include_in_context ?? false,
						sourcePath: dirname(descriptorPath),
					}
				: undefined,
	};
}

/**
 * Resolve a package declaration onto the frozen HCP product surface. Resource
 * kinds are explicit; Capability slots reuse the host's generated registry so
 * names such as context/workspace and runtime/process retain their canonical
 * addresses.
 */
function HcpClientresolvepackageproduct(
	declaration: HcpClientpackagecomponentdeclaration,
): HcpClientpackageproductresolution | { error: string } {
	if (declaration.kind === "tool") {
		return {
			product: "tool",
			requires: [...new Set(["runtime:process", "sandbox", ...(declaration.requires ?? [])])],
		};
	}
	if (HcpClientpackageresourcekinds.has(declaration.kind)) {
		return { product: "resource", requires: [...new Set(declaration.requires ?? [])] };
	}

	const candidates = (HCP_MAGNETS as readonly HcpClientcomponent[]).filter(
		(entry) => entry.product === "capability" && entry.kind === declaration.kind && typeof entry.slot === "string",
	);
	if (candidates.length === 0) {
		return { error: `unsupported package component kind ${JSON.stringify(declaration.kind)}` };
	}
	const matches = declaration.slot
		? candidates.filter((entry) => entry.slot === declaration.slot)
		: candidates.filter(
				(entry) =>
					entry.name === declaration.name ||
					entry.slot === declaration.name ||
					entry.slot === `${declaration.kind}:${declaration.name}`,
			);
	if (matches.length === 0) {
		return {
			error: `component ${declaration.kind}:${declaration.name} has no matching HCP Capability slot; declare a valid slot explicitly`,
		};
	}
	if (matches.length > 1) {
		return {
			error: `component ${declaration.kind}:${declaration.name} matches multiple HCP Capability slots; declare slot explicitly`,
		};
	}
	const match = matches[0]!;
	return {
		product: "capability",
		slot: match.slot,
		requires: [...new Set([...(match.requires ?? []), ...(declaration.requires ?? [])])],
	};
}
