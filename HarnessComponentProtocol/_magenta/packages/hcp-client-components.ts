import { dirname } from "node:path";
import type { HcpClientcomponent } from "../../.HCP/assembly/session-hcp.ts";
import { HCP_MAGNETS } from "../../.HCP/assembly/sources.generated.ts";
import type { PackageToolBuildSettings } from "../../tools/descriptor/package-tool.ts";
import type { PackageDiagnostic, PackageOverlay } from "./package-overlay-v2.ts";
import type { LoadedPackageMagnet } from "./runtime-magnet-loader.ts";
import type { PackageToolDiagnostic } from "./tool-diagnostic.ts";

export type HcpClientpackageinputresult = {
	components: HcpClientcomponent[];
	diagnostics: PackageDiagnostic[];
	toolDiagnostics: PackageToolDiagnostic[];
};

/**
 * Tool magnet's descriptor() output shape (contract with MagentaPackages).
 * Package tool magnets are descriptor providers: they declare identity and
 * hand over the path to their tool descriptor toml. The host builds the
 * AgentTool via createPackageToolProduct, reusing sandbox/runtime/mcp infra.
 */
type PackageToolDescriptor = {
	kind: "tool";
	name: string;
	source: string;
	descriptorPath: string;
};

/**
 * Translate a v2 package overlay into ordinary Client component inputs.
 *
 * V2 packages carry their own real HcpMagnet classes (loaded at runtime).
 * Resource and capability magnets are self-sufficient — they pass straight
 * through to assembly, which calls their build()/toResource()/toCapability().
 *
 * Tool magnets are descriptor providers: their build().descriptor() yields a
 * pointer to the tool's toml, which is routed through the host's tools/descriptor
 * magnet + createPackageToolProduct chain so the AgentTool is built by the same
 * host infrastructure (sandbox/runtime/mcp) as built-in package tools. Unlike v1,
 * the source label is the package's real source (e.g. "AutOmicScience"), not the
 * hard-coded "descriptor".
 */
export async function HcpClientpackageinputfromoverlay(overlay: PackageOverlay): Promise<HcpClientpackageinputresult> {
	const components: HcpClientcomponent[] = [];
	const diagnostics: PackageDiagnostic[] = [...overlay.diagnostics];
	const toolDiagnostics: PackageToolDiagnostic[] = [];

	// The host descriptor magnet that owns package tool construction.
	const toolDescriptorEntry = (HCP_MAGNETS as readonly HcpClientcomponent[]).find(
		(entry) => entry.product === "tool" && entry.kind === "tool" && entry.source === "descriptor",
	);

	const packageContext = {
		components: overlay.components,
		diagnostics: toolDiagnostics,
	};

	for (const component of overlay.components) {
		if (component.kind === "tool") {
			const toolComponent = buildToolComponent(component, overlay, toolDescriptorEntry, packageContext, diagnostics);
			if (toolComponent) components.push(toolComponent);
			continue;
		}

		// Resource / capability: the package's own magnet is self-sufficient.
		// It carries static build() + toResource()/toCapability(); assembly calls
		// them directly. We pass the loaded component through unchanged.
		components.push(stripLoaderFields(component));
	}

	return { components, diagnostics, toolDiagnostics };
}

/**
 * Build a tool component by extracting the descriptor path from the package's
 * tool magnet and routing it through the host descriptor magnet + build chain.
 */
function buildToolComponent(
	component: LoadedPackageMagnet,
	overlay: PackageOverlay,
	toolDescriptorEntry: HcpClientcomponent | undefined,
	packageContext: { components: readonly LoadedPackageMagnet[]; diagnostics: PackageToolDiagnostic[] },
	diagnostics: PackageDiagnostic[],
): HcpClientcomponent | undefined {
	if (!toolDescriptorEntry) {
		diagnostics.push({
			type: "error",
			code: "package_tool_host_descriptor_missing",
			message: `No host tools/descriptor magnet available to build package tool ${component.name}.`,
			path: component.descriptorPath,
			packageId: component.packageId,
		});
		return undefined;
	}

	// Instantiate the package tool magnet and read its descriptor() pointer.
	let descriptorPath: string;
	let toolName: string;
	try {
		const built = component.HcpMagnet.build({
			repoRoot: overlay.packageRoot,
			cwd: overlay.packageRoot,
			kind: component.kind,
			name: component.name,
			source: component.source,
		}) as { descriptor?: () => PackageToolDescriptor };
		if (typeof built?.descriptor !== "function") {
			diagnostics.push({
				type: "error",
				code: "package_tool_descriptor_missing",
				message: `Package tool magnet ${component.name} does not implement descriptor().`,
				path: component.descriptorPath,
				packageId: component.packageId,
			});
			return undefined;
		}
		const descriptor = built.descriptor();
		descriptorPath = descriptor.descriptorPath;
		toolName = descriptor.name;
	} catch (error) {
		diagnostics.push({
			type: "error",
			code: "package_tool_magnet_build_failed",
			message: `Package tool magnet ${component.name} build/descriptor failed: ${error instanceof Error ? error.message : String(error)}`,
			path: component.descriptorPath,
			packageId: component.packageId,
		});
		return undefined;
	}

	// Construct the PackageToolBuildSettings the host descriptor magnet expects.
	// The descriptor toml's own name field is authoritative for the final tool
	// name (createPackageToolProduct uses descriptor.name ?? component.name).
	const settings: PackageToolBuildSettings = {
		component: {
			packageId: component.packageId,
			packageDir: overlay.packageRoot,
			kind: "tool",
			name: toolName,
			description: undefined,
			path: descriptorPath,
			sourcePath: dirname(descriptorPath),
		},
		components: packageContext.components.map((c) => ({
			packageId: c.packageId,
			packageDir: overlay.packageRoot,
			kind: c.kind,
			name: c.name,
			path: c.descriptorPath,
			sourcePath: c.descriptorPath,
		})),
		componentMap: new Map(),
		diagnostics: packageContext.diagnostics,
	};

	return {
		...toolDescriptorEntry,
		module: component.module,
		kind: "tool",
		name: component.name,
		// Real package source, not the host "descriptor" placeholder.
		source: component.source,
		selected: true,
		autoload: false,
		descriptorPath,
		requires: ["runtime:process", "sandbox"],
		settings,
		overrideExisting: true,
	};
}

/** Strip loader-only fields so the entry matches HcpClientcomponent exactly. */
function stripLoaderFields(component: LoadedPackageMagnet): HcpClientcomponent {
	const { packageId, packageVersion, profiles, includeInContext, ...clientComponent } = component;
	void packageId;
	void packageVersion;
	void profiles;
	void includeInContext;
	return clientComponent;
}
