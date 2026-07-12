/**
 * Runtime magnet loader for v2 packages with isomorphic HCP structure.
 *
 * Manifest-driven: reads [[components]] declarations from package.toml (the
 * authoritative source per spec §2.1), and for each component resolves
 * <package-root>/<component.path>/HcpMagnet.ts, dynamically imports it,
 * validates the bare-class shape, and constructs an HcpClientcomponent entry
 * for the unified session assembly.
 *
 * Per contract from MagentaPackages collaboration:
 * - Package magnets use import.meta.url-relative paths (cache-relocatable).
 * - Export裸 class (no interface, structural typing per spec §2).
 * - static build + module/kind/source; product method ∈
 *   {toTool, toCapability, toResource} for resources/capabilities, or
 *   descriptor() for tools (which yields a descriptor pointer built by the
 *   host's createPackageToolProduct chain).
 * - Infra-only kinds (python-runtime/runtime-tests/env/env-lock) have no
 *   HcpMagnet.ts and are skipped here; they are referenced by tool descriptors
 *   and resolved by the host tool build chain.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { HcpClientcomponent } from "../../.HCP/assembly/session-hcp.ts";

/** Component declaration as it appears in package.toml [[components]]. */
export type PackageComponentDeclaration = {
	kind: string;
	name: string;
	source: string;
	path: string;
	profiles?: string[];
	include_in_context?: boolean;
	description?: string;
};

export type LoadedPackageMagnet = HcpClientcomponent & {
	packageId: string;
	packageVersion: string;
	profiles: string[];
	includeInContext: boolean;
};

export type RuntimeMagnetLoaderDiagnostic = {
	type: "error" | "warning";
	code: string;
	message: string;
	path: string;
	packageId: string;
};

export type RuntimeMagnetLoaderResult = {
	magnets: LoadedPackageMagnet[];
	diagnostics: RuntimeMagnetLoaderDiagnostic[];
};

/** Kinds that are package-local infrastructure with no HcpMagnet.ts. */
const INFRA_KINDS = new Set(["python-runtime", "runtime-tests", "env", "env-lock"]);

type HcpMagnetClass = {
	readonly module: string;
	readonly kind: string;
	readonly source: string;
	build(context: unknown): unknown;
};

/**
 * Load magnets for a package from its manifest component declarations.
 * Each non-infra component resolves <packageRoot>/<component.path>/HcpMagnet.ts.
 */
export async function loadPackageMagnets(
	packageRoot: string,
	packageId: string,
	packageVersion: string,
	components: readonly PackageComponentDeclaration[],
): Promise<RuntimeMagnetLoaderResult> {
	const magnets: LoadedPackageMagnet[] = [];
	const diagnostics: RuntimeMagnetLoaderDiagnostic[] = [];

	for (const declaration of components) {
		// Skip infra-only kinds (no HcpMagnet.ts; referenced by tool descriptors)
		if (INFRA_KINDS.has(declaration.kind)) continue;

		const magnetPath = join(packageRoot, declaration.path, "HcpMagnet.ts");
		try {
			const magnetExists = await stat(magnetPath).then(
				(s) => s.isFile(),
				() => false,
			);
			if (!magnetExists) {
				diagnostics.push({
					type: "error",
					code: "magnet_not_found",
					message: `Component ${declaration.kind}:${declaration.name} declares path "${declaration.path}" but no HcpMagnet.ts found there`,
					path: magnetPath,
					packageId,
				});
				continue;
			}

			// Dynamic import (bun binary verified to support external .ts)
			const imported = await import(magnetPath);
			if (!imported.HcpMagnet) {
				diagnostics.push({
					type: "error",
					code: "magnet_missing_export",
					message: `${magnetPath} does not export class HcpMagnet`,
					path: magnetPath,
					packageId,
				});
				continue;
			}

			const MagnetClass = imported.HcpMagnet as HcpMagnetClass;

			// Validate shape against the manifest declaration
			const diagnostic = validateMagnetShape(MagnetClass, declaration, magnetPath, packageId);
			if (diagnostic) {
				diagnostics.push(diagnostic);
				if (diagnostic.type === "error") continue;
			}

			// Construct HcpClientcomponent entry
			magnets.push(constructComponent(MagnetClass, declaration, packageRoot, packageId, packageVersion));
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

	return { magnets, diagnostics };
}

/**
 * Validate magnet shape:
 * - static build exists
 * - static module/kind/source are strings
 * - static kind matches manifest declaration kind
 * - static source matches manifest declaration source
 * Returns a diagnostic (error blocks load, warning allows it) or undefined.
 */
function validateMagnetShape(
	MagnetClass: HcpMagnetClass,
	declaration: PackageComponentDeclaration,
	magnetPath: string,
	packageId: string,
): RuntimeMagnetLoaderDiagnostic | undefined {
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

	return undefined;
}

/**
 * Construct an HcpClientcomponent from a validated magnet class and its
 * manifest declaration. Product type is inferred from kind; tool descriptor
 * building is deferred to the host chain (see hcp-client-components).
 */
function constructComponent(
	MagnetClass: HcpMagnetClass,
	declaration: PackageComponentDeclaration,
	packageRoot: string,
	packageId: string,
	packageVersion: string,
): LoadedPackageMagnet {
	const product = inferProduct(MagnetClass.kind);
	// descriptorPath points at the source directory that owns the magnet; the
	// magnet itself resolves its own content/toml via import.meta.url, so this
	// is used only for diagnostics and host tool-descriptor resolution.
	const descriptorPath = join(packageRoot, declaration.path);
	const slot = product === "capability" ? declaration.name : undefined;

	// Assembly routing uses the generic parent module server (skills, tools,
	// system-prompt, brand, ...). Packages ship no per-item HcpServer, so an
	// item-level module like "skills/omics-shared" routes through its generic
	// parent "skills" (exactly as the host's skills/descriptor magnet uses
	// module="skills"). The magnet's own static module keeps the isomorphic
	// identity; only the routing module is generalized here.
	const routingModule = MagnetClass.module.split("/")[0]!;

	return {
		module: routingModule,
		kind: MagnetClass.kind,
		name: declaration.name,
		product,
		source: MagnetClass.source,
		selected: true,
		autoload: product !== "tool",
		hotSwappable: false,
		descriptorPath,
		slot,
		requires: product === "tool" ? ["runtime:process", "sandbox"] : [],
		HcpMagnet: MagnetClass as HcpClientcomponent["HcpMagnet"],
		overrideExisting: true,
		packageId,
		packageVersion,
		profiles: declaration.profiles ?? [],
		includeInContext: declaration.include_in_context ?? false,
	};
}

/**
 * Infer product type from kind string, following host conventions in
 * sources.generated.ts.
 */
function inferProduct(kind: string): "tool" | "capability" | "resource" {
	const CAPABILITY_KINDS = new Set([
		"compaction",
		"context",
		"memory",
		"multiagent",
		"hooks",
		"policy",
		"sandbox",
		"eval",
		"runtime",
	]);

	if (kind === "tool") return "tool";
	if (CAPABILITY_KINDS.has(kind)) return "capability";
	// skill, brand, system-prompt, prompt-template, theme, append-system-prompt
	return "resource";
}
