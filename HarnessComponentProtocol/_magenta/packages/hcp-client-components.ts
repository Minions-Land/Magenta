import type { HcpClientcomponent } from "../../.HCP/assembly/session-hcp.ts";
import { HCP_MAGNETS } from "../../.HCP/assembly/sources.generated.ts";
import type { HcpMagnetResourcebuildsettings } from "../../.HCP/HcpMagnetTypes.ts";
import type { PackageToolBuildSettings } from "../../tools/descriptor/package-tool.ts";
import type { PackageDiagnostic, PackageOverlay } from "./package-overlay.ts";
import type { PackageToolDiagnostic } from "./tool-diagnostic.ts";

export type HcpClientpackageinputresult = {
	components: HcpClientcomponent[];
	diagnostics: PackageDiagnostic[];
	toolDiagnostics: PackageToolDiagnostic[];
};

/** Translate the generic Package contract into ordinary Client component inputs. */
export function HcpClientpackageinputfromoverlay(overlay: PackageOverlay): HcpClientpackageinputresult {
	const components: HcpClientcomponent[] = [];
	const diagnostics = [...overlay.diagnostics];
	const toolDiagnostics: PackageToolDiagnostic[] = [];
	const generatedComponents = HCP_MAGNETS as readonly HcpClientcomponent[];
	const packageContext = {
		components: overlay.components,
		componentMap: overlay.componentMap,
		diagnostics: toolDiagnostics,
	};
	const packageResourceTargets = new Set<string>();

	for (const component of overlay.components) {
		if (component.kind === "tool") {
			const descriptor = generatedComponents.find(
				(entry) => entry.product === "tool" && entry.kind === component.kind && entry.source === "descriptor",
			);
			if (!descriptor || !component.path) continue;
			const settings: PackageToolBuildSettings = { component, ...packageContext };
			components.push({
				...descriptor,
				name: component.name,
				selected: true,
				autoload: false,
				descriptorPath: component.path,
				requires: ["runtime:process", "sandbox"],
				settings,
				overrideExisting: true,
			});
			continue;
		}

		const resourceKind = HcpClientpackagecomponentkind(component.kind);
		const resourceDescriptor = generatedComponents.find(
			(entry) => entry.product === "resource" && entry.kind === resourceKind && entry.source === "descriptor",
		);
		if (resourceDescriptor) {
			if (!component.path) {
				diagnostics.push({
					type: "error",
					code: "package_component_invalid",
					message: `Package ${component.packageId} ${component.kind}:${component.name} must declare a content path.`,
					path: component.sourcePath,
					packageId: component.packageId,
					profile: component.profile,
				});
				continue;
			}
			const target = `${resourceKind}:${component.name}`;
			if (packageResourceTargets.has(target)) {
				diagnostics.push({
					type: "error",
					code: "package_component_invalid",
					message: `Package Resource address ${target} is declared more than once; append fragments need distinct names.`,
					path: component.path,
					packageId: component.packageId,
					profile: component.profile,
				});
				continue;
			}
			packageResourceTargets.add(target);
			const settings: HcpMagnetResourcebuildsettings = {
				name: component.name,
				source: component.source ?? component.packageId,
				mergeMode: component.kind === "append-system-prompt" ? "append" : "replace",
				...(resourceKind === "system-prompt"
					? { descriptorPath: component.path }
					: { contentPath: component.path }),
				metadata: {
					origin: "package",
					packageId: component.packageId,
					packageDir: component.packageDir,
					...(component.profile ? { profile: component.profile } : {}),
					sourcePath: component.sourcePath,
					...(component.description ? { description: component.description } : {}),
					...(component.includeInContext === undefined ? {} : { includeInContext: component.includeInContext }),
				},
			};
			components.push({
				...resourceDescriptor,
				kind: resourceKind,
				name: component.name,
				selected: true,
				autoload: true,
				descriptorPath: component.path,
				settings,
				overrideExisting: true,
			});
			continue;
		}

		const kindCandidates = generatedComponents.filter(
			(entry) => entry.product === "capability" && entry.kind === component.kind,
		);
		if (kindCandidates.length === 0) continue;
		const candidates = kindCandidates.filter(
			(entry) => entry.slot === component.key || entry.name === component.name,
		);
		if (candidates.length === 0) {
			diagnostics.push({
				type: "error",
				code: "package_component_invalid",
				message: `Package ${component.packageId} ${component.kind}:${component.name} has no matching HCP capability component.`,
				path: component.path ?? component.sourcePath,
				packageId: component.packageId,
				profile: component.profile,
			});
			continue;
		}
		const source = component.source ?? candidates.find((entry) => entry.selected)?.source;
		const selected = candidates.find((entry) => entry.source === source);
		if (!selected) {
			diagnostics.push({
				type: "error",
				code: "package_component_invalid",
				message: `Package ${component.packageId} ${component.kind}:${component.name} selects unavailable source ${source ?? "<missing>"}.`,
				path: component.path ?? component.sourcePath,
				packageId: component.packageId,
				profile: component.profile,
			});
			continue;
		}
		components.push({
			...selected,
			name: component.name,
			selected: true,
			autoload: true,
			descriptorPath: component.path ?? selected.descriptorPath,
			overrideExisting: true,
		});
	}

	return { components, diagnostics, toolDiagnostics };
}

function HcpClientpackagecomponentkind(kind: string): string {
	if (kind === "prompt") return "prompt-template";
	if (kind === "append-system-prompt") return "system-prompt";
	return kind;
}
