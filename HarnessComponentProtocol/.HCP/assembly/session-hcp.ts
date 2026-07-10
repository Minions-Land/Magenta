import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { HcpClient } from "../../HcpClient.ts";
import {
	expandPackageToolBuildSettings,
	type PackageToolBuildSettings,
	type PackageToolDiagnostic,
} from "../../tools/descriptor/package-tool.ts";
import type { HcpMagnetBinding, HcpMagnetBuildContext, HcpMagnetResource } from "../HcpMagnetTypes.ts";
import type { PackageAssemblyProgress, PackageDiagnostic, PackageOverlay } from "../overlay/package-overlay.ts";
import { getHarnessPackagesRoot } from "../overlay/package-overlay.ts";
import { HCP_MAGNETS, HCP_SERVERS } from "./sources.generated.ts";

const HCP_ROOT = fileURLToPath(new URL("../..", import.meta.url));

type HcpMagnetproduct = {
	readonly kind: string;
	readonly source?: string;
	readonly hotSwappable?: boolean;
	toTool?(): AgentTool;
	toCapability?(): HcpMagnetBinding;
	toResource?(): HcpMagnetResource;
};

type HcpMagnetclass = {
	readonly module: string;
	readonly kind: string;
	readonly source: string;
	build(context: HcpMagnetBuildContext): unknown | Promise<unknown>;
};

export type HcpClientcomponent = {
	module: string;
	kind: string;
	name: string;
	product: "tool" | "capability" | "resource";
	source: string;
	selected: boolean;
	autoload: boolean;
	hotSwappable?: boolean;
	descriptorPath: string;
	slot?: string;
	requires: readonly string[];
	HcpMagnet: HcpMagnetclass;
	settings?: unknown;
};

export type HcpClientassemblydiagnostic = {
	type: "warning" | "error";
	code:
		| "component_dependency_missing"
		| "component_build_failed"
		| "component_product_invalid"
		| "component_server_missing"
		| "component_source_unavailable";
	message: string;
	module: string;
	name: string;
	source: string;
};

export type HcpClientassembleoptions = {
	hcp: HcpClient;
	repoRoot: string;
	packagesRoot?: string;
	cwd?: string;
	/** Include TOML-selected entries marked autoload=true. Default true. */
	includeAutoload?: boolean;
	/** Additionally assemble these real module paths through the same pipeline. */
	modules?: readonly string[];
	/** Dynamic entries, such as package-selected components, merged into this assembly pass. */
	components?: readonly HcpClientcomponent[];
	/** Source constructor settings keyed by `module:name`, then by module path. */
	settings?: Readonly<Record<string, unknown>>;
	descriptions?: Readonly<Record<string, string | undefined>>;
	disabledModules?: readonly string[];
};

export type HcpClientassembleresult = {
	hcp: HcpClient;
	addresses: string[];
	builtComponents: Array<{ component: HcpClientcomponent; addresses: string[] }>;
	diagnostics: HcpClientassemblydiagnostic[];
};

/**
 * The one component construction and registration pipeline.
 *
 * Every input is a real TOML/codegen registration: module Server, selected
 * source Magnet, product, slot, and dependency edges. Package and host phases
 * may add entries or settings, but they do not get another builder or registry.
 */
export async function HcpClientassemble(options: HcpClientassembleoptions): Promise<HcpClientassembleresult> {
	const packagesRoot = options.packagesRoot ?? getHarnessPackagesRoot(options.repoRoot);
	const disabledModules = new Set(options.disabledModules ?? []);
	const requestedModules = new Set(options.modules ?? []);
	const inventory: readonly HcpClientcomponent[] = HCP_MAGNETS;
	const generated = inventory.filter((entry) => {
		if (!entry.selected || HcpClientmoduledisabled(entry.module, disabledModules)) return false;
		return (
			(options.includeAutoload !== false && entry.autoload) ||
			requestedModules.has(entry.module) ||
			options.settings?.[`${entry.module}:${entry.name}`] !== undefined ||
			options.settings?.[entry.module] !== undefined ||
			options.settings?.[entry.name] !== undefined
		);
	});
	const components = HcpClientdedupecomponents([...generated, ...(options.components ?? [])]);
	const pending = [...components];
	const addresses: string[] = [];
	const builtComponents: HcpClientassembleresult["builtComponents"] = [];
	const diagnostics: HcpClientassemblydiagnostic[] = [];

	while (pending.length > 0) {
		let progressed = false;
		for (let index = 0; index < pending.length; ) {
			const component = pending[index]!;
			const missing = component.requires.filter(
				(requirement) => options.hcp.resolve(`capability:${requirement}`) === undefined,
			);
			if (missing.length > 0) {
				index += 1;
				continue;
			}

			pending.splice(index, 1);
			progressed = true;
			const result = await HcpClientbuildcomponent(component, options, packagesRoot);
			if (result.diagnostic) {
				diagnostics.push(result.diagnostic);
				continue;
			}
			if (!result.magnet) continue;
			const registration = HcpClientregistercomponent(options.hcp, component, result.magnet);
			if (registration.diagnostic) diagnostics.push(registration.diagnostic);
			else {
				addresses.push(...registration.addresses);
				builtComponents.push({ component, addresses: registration.addresses });
			}
		}

		if (progressed) continue;
		for (const component of pending.splice(0)) {
			const missing = component.requires.filter(
				(requirement) => options.hcp.resolve(`capability:${requirement}`) === undefined,
			);
			diagnostics.push({
				type: "error",
				code: "component_dependency_missing",
				message: `${component.module}:${component.name} requires unresolved capabilities [${missing.join(", ")}].`,
				module: component.module,
				name: component.name,
				source: component.source,
			});
		}
	}

	return { hcp: options.hcp, addresses: [...new Set(addresses)], builtComponents, diagnostics };
}

async function HcpClientbuildcomponent(
	component: HcpClientcomponent,
	options: HcpClientassembleoptions,
	packagesRoot: string,
): Promise<{ magnet?: HcpMagnetproduct; diagnostic?: HcpClientassemblydiagnostic }> {
	const settings =
		component.settings ??
		options.settings?.[`${component.module}:${component.name}`] ??
		options.settings?.[component.module] ??
		options.settings?.[component.name];
	try {
		const descriptorPath = isAbsolute(component.descriptorPath)
			? component.descriptorPath
			: resolve(HCP_ROOT, component.descriptorPath);
		const built = await component.HcpMagnet.build({
			repoRoot: options.repoRoot,
			packagesRoot,
			cwd: options.cwd ?? options.repoRoot,
			kind: component.kind,
			name: component.name,
			descriptorPath,
			source: component.source,
			settings,
			description: options.descriptions?.[component.name],
			hotSwappable: component.hotSwappable ?? false,
			resolveCapability: options.hcp.resolveCapability.bind(options.hcp),
		});
		if (built === undefined) {
			if (component.product === "tool" && component.autoload === false) return {};
			return {
				diagnostic: {
					type: "warning",
					code: "component_source_unavailable",
					message: `${component.module}:${component.source} did not build ${component.name}.`,
					module: component.module,
					name: component.name,
					source: component.source,
				},
			};
		}
		if (Array.isArray(built)) {
			throw new Error("build must return exactly one HcpMagnet product; expand fan-out before assembly");
		}
		if (!HcpMagnetisproduct(built)) throw new Error("build returned a value that is not an HcpMagnet product");
		return { magnet: built };
	} catch (error) {
		return {
			diagnostic: {
				type: "error",
				code: "component_build_failed",
				message: `${component.module}:${component.source} failed to build ${component.name}: ${
					error instanceof Error ? error.message : String(error)
				}`,
				module: component.module,
				name: component.name,
				source: component.source,
			},
		};
	}
}

function HcpClientregistercomponent(
	hcp: HcpClient,
	component: HcpClientcomponent,
	magnet: HcpMagnetproduct,
): { addresses: string[]; diagnostic?: HcpClientassemblydiagnostic } {
	const products = [
		typeof magnet.toTool === "function" ? "tool" : undefined,
		typeof magnet.toCapability === "function" ? "capability" : undefined,
		typeof magnet.toResource === "function" ? "resource" : undefined,
	].filter((product): product is HcpClientcomponent["product"] => product !== undefined);
	if (products.length !== 1 || products[0] !== component.product) {
		return {
			addresses: [],
			diagnostic: {
				type: "error",
				code: "component_product_invalid",
				message: `${component.module}:${component.name} declares product=${component.product} but built [${products.join(", ") || "none"}].`,
				module: component.module,
				name: component.name,
				source: component.source,
			},
		};
	}

	const HcpServer = HCP_SERVERS.get(component.module);
	if (!HcpServer) {
		return {
			addresses: [],
			diagnostic: {
				type: "error",
				code: "component_server_missing",
				message: `${component.module}:${component.name} has no generated HcpServer.`,
				module: component.module,
				name: component.name,
				source: component.source,
			},
		};
	}

	HcpClientregisterparents(hcp, component.module);
	const selector = HcpClientcomponentselector(component, magnet);
	const addresses = hcp.registerModule(new HcpServer(), new Map([[selector, magnet]]), { merge: true });
	return { addresses };
}

function HcpClientcomponentselector(component: HcpClientcomponent, magnet: HcpMagnetproduct): string {
	if (component.product === "capability") return component.slot!;
	if (component.product === "resource") return component.source;
	if (component.module.startsWith("tools/")) return component.source;
	if (component.module !== "tools") return component.name;
	const tool = magnet.toTool!();
	return `tool:${tool.name}`;
}

function HcpClientregisterparents(hcp: HcpClient, module: string): void {
	const parts = module.split("/");
	for (let index = 1; index < parts.length; index++) {
		const parent = parts.slice(0, index).join("/");
		const HcpServer = HCP_SERVERS.get(parent);
		if (HcpServer && !hcp.resolveModule(parent)) hcp.registerModule(new HcpServer(), new Map(), { merge: true });
	}
}

function HcpClientdedupecomponents(components: readonly HcpClientcomponent[]): HcpClientcomponent[] {
	const bySlot = new Map<string, HcpClientcomponent>();
	for (const component of components) {
		const key =
			component.product === "capability" ? `capability:${component.slot}` : `${component.module}:${component.name}`;
		bySlot.set(key, component);
	}
	return [...bySlot.values()];
}

function HcpClientmoduledisabled(module: string, disabled: ReadonlySet<string>): boolean {
	for (const candidate of disabled) {
		if (module === candidate || module.startsWith(`${candidate}/`)) return true;
	}
	return false;
}

function HcpMagnetisproduct(value: unknown): value is HcpMagnetproduct {
	return Boolean(value) && typeof value === "object" && typeof (value as { kind?: unknown }).kind === "string";
}

export type HcpClientbuildsessionoptions = {
	repoRoot?: string;
	packagesRoot?: string;
	cwd?: string;
	overlay?: PackageOverlay;
	onPackageAssemblyProgress?: (progress: PackageAssemblyProgress) => void;
	disabledModules?: readonly string[];
	toolOptions?: Readonly<Record<string, unknown>>;
	modules?: readonly string[];
};

export type HcpClientbuildsessionresult = {
	hcp: HcpClient;
	diagnostics: Array<PackageDiagnostic | HcpClientassemblydiagnostic>;
	toolAddresses: string[];
	packageToolAddresses: string[];
};

/** Construct the one session Client, then delegate every registration to HcpClientassemble. */
export async function HcpClientbuildsession(
	options: HcpClientbuildsessionoptions = {},
): Promise<HcpClientbuildsessionresult> {
	const repoRoot = options.repoRoot ?? process.cwd();
	const packagesRoot = options.packagesRoot ?? getHarnessPackagesRoot(repoRoot);
	const hcp = new HcpClient();
	const packageDiagnostics: PackageDiagnostic[] = [];
	const packageToolDiagnostics: PackageToolDiagnostic[] = [];
	const packageComponentTemplates = options.overlay
		? HcpClientpackagecomponents(options.overlay, packageDiagnostics, packageToolDiagnostics)
		: [];
	for (const [index, component] of (options.overlay?.components ?? []).entries()) {
		options.onPackageAssemblyProgress?.({
			phase: "start",
			index,
			total: options.overlay!.components.length,
			component,
		});
	}
	const toolOptions = options.toolOptions ?? {};
	const baseAssembled = await HcpClientassemble({
		hcp,
		repoRoot,
		packagesRoot,
		cwd: options.cwd ?? repoRoot,
		disabledModules: options.disabledModules,
		modules: options.modules,
		components: packageComponentTemplates.filter((component) => component.product !== "tool"),
		settings: toolOptions,
		descriptions: toolOptions.descriptions as Readonly<Record<string, string | undefined>> | undefined,
	});
	const packageToolComponents: HcpClientcomponent[] = [];
	for (const template of packageComponentTemplates.filter((component) => component.product === "tool")) {
		const settings = template.settings as PackageToolBuildSettings;
		const expanded = await expandPackageToolBuildSettings(settings, {
			repoRoot,
			packagesRoot,
			components: settings.components,
			componentMap: settings.componentMap,
			resolveCapability: hcp.resolveCapability.bind(hcp),
		});
		packageToolComponents.push(
			...expanded.map((expandedSettings) => ({
				...template,
				name: expandedSettings.toolName ?? template.name,
				settings: expandedSettings,
			})),
		);
	}
	const packageAssembled = await HcpClientassemble({
		hcp,
		repoRoot,
		packagesRoot,
		cwd: options.cwd ?? repoRoot,
		includeAutoload: false,
		components: packageToolComponents,
	});
	const assembled: HcpClientassembleresult = {
		hcp,
		addresses: [...new Set([...baseAssembled.addresses, ...packageAssembled.addresses])],
		builtComponents: [...baseAssembled.builtComponents, ...packageAssembled.builtComponents],
		diagnostics: [...baseAssembled.diagnostics, ...packageAssembled.diagnostics],
	};
	packageDiagnostics.push(...packageToolDiagnostics);
	const diagnostics: Array<PackageDiagnostic | HcpClientassemblydiagnostic> = [
		...packageDiagnostics,
		...assembled.diagnostics,
	];
	const toolAddresses = assembled.addresses.filter((address) => address.startsWith("tool:"));
	const packageComponentSet = new Set(packageToolComponents);
	const packageToolAddresses = assembled.builtComponents
		.filter(({ component }) => packageComponentSet.has(component))
		.flatMap(({ addresses }) => addresses)
		.filter((address) => address.startsWith("tool:"));
	for (const [index, component] of (options.overlay?.components ?? []).entries()) {
		options.onPackageAssemblyProgress?.({
			phase: "assembled",
			index,
			total: options.overlay!.components.length,
			component,
		});
	}

	return {
		hcp,
		diagnostics,
		toolAddresses: [...new Set(toolAddresses)],
		packageToolAddresses: [...new Set(packageToolAddresses)],
	};
}

function HcpClientpackagecomponents(
	overlay: PackageOverlay,
	diagnostics: PackageDiagnostic[],
	toolDiagnostics: PackageToolDiagnostic[],
): HcpClientcomponent[] {
	const components: HcpClientcomponent[] = [];
	const inventory = HCP_MAGNETS as readonly HcpClientcomponent[];
	const packageContext = {
		components: overlay.components,
		componentMap: overlay.componentMap,
		diagnostics: toolDiagnostics,
	};
	const resourceComponents = new Set(
		Object.values(overlay.resources).flatMap((resources) => resources.map((resource) => resource.component)),
	);

	for (const component of overlay.components) {
		if (component.kind === "tool") {
			const root = inventory.find(
				(entry) => entry.module === "tools" && entry.source === "descriptor" && entry.product === "tool",
			);
			if (!root || !component.path) continue;
			const settings: PackageToolBuildSettings = { component, ...packageContext };
			components.push({
				...root,
				name: component.name,
				selected: true,
				autoload: false,
				descriptorPath: component.path,
				requires: ["runtime:process", "sandbox"],
				settings,
			});
			continue;
		}
		if (resourceComponents.has(component)) continue;

		const kindCandidates = inventory.filter(
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
		});
	}
	return components;
}
