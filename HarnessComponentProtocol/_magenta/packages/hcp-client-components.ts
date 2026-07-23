import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { HcpClientcomponent } from "../../.HCP/assembly/session-hcp.ts";
import type { HcpMagnetBuildContext } from "../../.HCP/HcpMagnetTypes.ts";
import {
	HcpClientbuildpackagetoolproducts,
	type HcpClientpackagetoolbuildsettings,
	type HcpClientpackagetoolcontext,
	type HcpClientpackagetoolproduct,
} from "../../tools/descriptor/package-tool.ts";
import type { HcpClientpackagediagnostic, HcpClientpackageoverlay } from "./package-overlay-v2.ts";
import type { HcpClientpackageloadedmagnet } from "./runtime-magnet-loader.ts";
import type { HcpClientpackagetooldiagnostic } from "./tool-diagnostic.ts";

export type HcpClientpackageinputresult = {
	components: HcpClientcomponent[];
	diagnostics: HcpClientpackagediagnostic[];
	toolDiagnostics: HcpClientpackagetooldiagnostic[];
};

/**
 * Client-owned Tool build request passed by a real package HcpMagnet to the
 * injected host builder. It carries identity and the package-local TOML path;
 * the returned product remains wrapped by that same package HcpMagnet.
 */
type HcpClientpackagetooldescriptor = {
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
 * Tool magnets keep their real package identity. Their static build() calls the
 * Client-owned builder injected in settings, which routes the TOML through the
 * shared sandbox/runtime/MCP product chain and returns host-backed products for
 * the package Magnet to wrap with toTool().
 */
export async function HcpClientpackageinputfromoverlay(
	overlay: HcpClientpackageoverlay,
): Promise<HcpClientpackageinputresult> {
	const components: HcpClientcomponent[] = [];
	const diagnostics: HcpClientpackagediagnostic[] = [...overlay.diagnostics];
	const toolDiagnostics: HcpClientpackagetooldiagnostic[] = [];

	const packageContext = {
		components: [...overlay.components, ...overlay.infrastructure],
		diagnostics: toolDiagnostics,
	};

	for (const component of overlay.components) {
		if (component.kind === "tool") {
			const toolComponent = HcpClientbuildpackagetoolcomponent(component, packageContext);
			if (toolComponent) components.push(toolComponent);
			continue;
		}

		// Resource / capability: the package's own magnet is self-sufficient.
		// It carries static build() + toResource()/toCapability(); assembly calls
		// them directly. We pass the loaded component through unchanged.
		components.push(HcpClientstrippackageloaderfields(component));
	}

	return { components, diagnostics, toolDiagnostics };
}

type HcpClientpackagetoolcontextinput = {
	components: ReadonlyArray<
		| Pick<HcpClientpackageloadedmagnet, "packageId" | "packageRoot" | "kind" | "name" | "descriptorPath">
		| {
				packageId: string;
				packageRoot: string;
				kind: string;
				name: string;
				path: string;
				sourcePath: string;
		  }
	>;
	diagnostics: HcpClientpackagetooldiagnostic[];
};

/** Keep the package's real HcpMagnet and inject only the host-owned Tool builder. */
function HcpClientbuildpackagetoolcomponent(
	component: HcpClientpackageloadedmagnet,
	packageContext: HcpClientpackagetoolcontextinput,
): HcpClientcomponent {
	const clientComponent = HcpClientstrippackageloaderfields(component);
	return {
		...clientComponent,
		settings: {
			HcpClientbuildtools: async (
				descriptor: HcpClientpackagetooldescriptor,
				buildContext: HcpMagnetBuildContext,
			): Promise<HcpClientpackagetoolproduct[]> => {
				const validated = await HcpClientvalidatepackagetooldescriptor(
					component,
					descriptor,
					packageContext.diagnostics,
				);
				if (!validated) return [];
				const settings = HcpClientcreatepackagetoolbuildsettings(component, validated, packageContext);
				const context: HcpClientpackagetoolcontext = {
					repoRoot: buildContext.repoRoot,
					cacheRoot: buildContext.cacheRoot,
					components: settings.components,
					componentMap: settings.componentMap,
					resolveCapability: buildContext.resolveCapability ?? (() => undefined),
				};
				return HcpClientbuildpackagetoolproducts(settings, context);
			},
		},
		HcpClientallowfanout: true,
	};
}

async function HcpClientvalidatepackagetooldescriptor(
	component: HcpClientpackageloadedmagnet,
	descriptor: HcpClientpackagetooldescriptor,
	diagnostics: HcpClientpackagetooldiagnostic[],
): Promise<HcpClientpackagetooldescriptor | undefined> {
	if (
		descriptor?.kind !== "tool" ||
		typeof descriptor.name !== "string" ||
		!descriptor.name ||
		descriptor.source !== component.source ||
		typeof descriptor.descriptorPath !== "string" ||
		!descriptor.descriptorPath
	) {
		diagnostics.push({
			type: "error",
			code: "package_tool_descriptor_invalid",
			message: `Package tool ${component.packageId}:${component.name} supplied an invalid host build descriptor.`,
			path: component.descriptorPath,
			packageId: component.packageId,
		});
		return undefined;
	}

	const descriptorPath = isAbsolute(descriptor.descriptorPath)
		? resolve(descriptor.descriptorPath)
		: resolve(component.descriptorPath, descriptor.descriptorPath);
	try {
		const [actualRoot, actualDescriptor] = await Promise.all([
			realpath(component.packageRoot),
			realpath(descriptorPath),
		]);
		if (!HcpClientiswithinpackageroot(actualRoot, actualDescriptor)) {
			throw new Error(`descriptor path escapes the package root: ${descriptor.descriptorPath}`);
		}
		return { ...descriptor, descriptorPath: actualDescriptor };
	} catch (error) {
		diagnostics.push({
			type: "error",
			code: "package_tool_descriptor_invalid",
			message: `Package tool ${component.packageId}:${component.name} descriptor is invalid: ${
				error instanceof Error ? error.message : String(error)
			}`,
			path: descriptorPath,
			packageId: component.packageId,
		});
		return undefined;
	}
}

function HcpClientcreatepackagetoolbuildsettings(
	component: HcpClientpackageloadedmagnet,
	descriptor: HcpClientpackagetooldescriptor,
	packageContext: HcpClientpackagetoolcontextinput,
): HcpClientpackagetoolbuildsettings {
	const packageComponents = packageContext.components
		.filter(
			(candidate) => candidate.packageId === component.packageId && candidate.packageRoot === component.packageRoot,
		)
		.map((candidate) => ({
			packageId: candidate.packageId,
			packageDir: candidate.packageRoot,
			kind: candidate.kind,
			name: candidate.name,
			path: "path" in candidate ? candidate.path : candidate.descriptorPath,
		}));
	return {
		component: {
			packageId: component.packageId,
			packageDir: component.packageRoot,
			kind: "tool",
			name: descriptor.name,
			path: descriptor.descriptorPath,
			sourcePath: dirname(descriptor.descriptorPath),
		},
		components: packageComponents,
		componentMap: new Map(packageComponents.map((candidate) => [`${candidate.kind}:${candidate.name}`, candidate])),
		diagnostics: packageContext.diagnostics,
	};
}

function HcpClientiswithinpackageroot(packageRoot: string, candidate: string): boolean {
	const pathFromRoot = relative(packageRoot, candidate);
	return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

/** Strip loader-only fields so the entry matches HcpClientcomponent exactly. */
function HcpClientstrippackageloaderfields(component: HcpClientpackageloadedmagnet): HcpClientcomponent {
	const { packageId, packageVersion, packageRoot, profiles, includeInContext, key, profile, ...clientComponent } =
		component;
	void packageId;
	void packageVersion;
	void packageRoot;
	void profiles;
	void includeInContext;
	void key;
	void profile;
	return clientComponent;
}
