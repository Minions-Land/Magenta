import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type {
	PackageAssemblyProgress,
	PackageDiagnostic,
	PackageOverlay,
} from "../../_magenta/packages/package-overlay.ts";
import { getHarnessPackagesRoot } from "../../_magenta/packages/package-overlay.ts";
import type { PackageToolDiagnostic } from "../../_magenta/packages/tool-diagnostic.ts";
import { HcpClient } from "../../HcpClient.ts";
import { expandPackageToolBuildSettings, type PackageToolBuildSettings } from "../../tools/descriptor/package-tool.ts";
import type {
	HcpMagnetBinding,
	HcpMagnetBuildContext,
	HcpMagnetResource,
	HcpMagnetResourcebuildsettings,
} from "../HcpMagnetTypes.ts";
import { HCP_MAGNETS, HCP_SERVERS } from "./sources.generated.ts";

const HCP_ROOT = fileURLToPath(new URL("../..", import.meta.url));

type HcpMagnetproduct = {
	readonly kind: string;
	readonly source?: string;
	readonly hotSwappable?: boolean;
	toTool?(): AgentTool;
	toCapability?(): HcpMagnetBinding;
	toResource?(): HcpMagnetResource;
	dispose?(): void | Promise<void>;
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
	/** Explicit overlay precedence: replace an address owned by another Module. */
	overrideExisting?: boolean;
};

export type HcpClientassemblydiagnostic = {
	type: "warning" | "error";
	code:
		| "component_dependency_missing"
		| "component_dependency_cycle"
		| "component_build_failed"
		| "component_product_invalid"
		| "component_server_missing"
		| "component_source_unavailable"
		| "component_address_collision"
		| "component_routing_failed";
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
	/** Additionally assemble selected generated rows for these Magnet products. */
	includeSelectedProducts?: readonly HcpClientcomponent["product"][];
	/** Dynamic entries, such as package-selected components, merged into this assembly pass. */
	components?: readonly HcpClientcomponent[];
	/** Leave components whose canonical address is already routed untouched. */
	skipOccupied?: boolean;
	/** Whether this pass may replace an address already owned by the same Module slot. Default true. */
	replaceExisting?: boolean;
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
 * The one component construction and attachment pipeline.
 *
 * Every input comes from a TOML declaration and its generated module Server,
 * selected source Magnet, product, slot, and dependency edges. Package and host
 * phases may add components or settings, but they use this same path.
 */
export async function HcpClientassemble(options: HcpClientassembleoptions): Promise<HcpClientassembleresult> {
	const packagesRoot = options.packagesRoot ?? getHarnessPackagesRoot(options.repoRoot);
	const disabledModules = new Set(options.disabledModules ?? []);
	const requestedModules = new Set(options.modules ?? []);
	const selectedProducts = new Set(options.includeSelectedProducts ?? []);
	const generatedComponents: readonly HcpClientcomponent[] = HCP_MAGNETS;
	const generated = generatedComponents.filter((entry) => {
		if (!entry.selected || HcpClientmoduledisabled(entry.module, disabledModules)) return false;
		return (
			(options.includeAutoload !== false && entry.autoload) ||
			selectedProducts.has(entry.product) ||
			requestedModules.has(entry.module) ||
			options.settings?.[`${entry.module}:${entry.name}`] !== undefined ||
			options.settings?.[entry.module] !== undefined ||
			options.settings?.[entry.name] !== undefined
		);
	});
	const requestedComponents = HcpClientdedupecomponents([
		...generated,
		...(options.components ?? []).filter((component) => !HcpClientmoduledisabled(component.module, disabledModules)),
	]);
	const components = HcpClientdependencyclosure(
		requestedComponents.filter(
			(component) =>
				!options.skipOccupied || options.hcp.resolve(HcpClientcomponentaddress(component)) === undefined,
		),
		generatedComponents,
		options.hcp,
		disabledModules,
	);
	const addresses: string[] = [];
	const builtComponents: HcpClientassembleresult["builtComponents"] = [];
	const diagnostics: HcpClientassemblydiagnostic[] = [];
	const providers = new Map<string, HcpClientcomponent>();
	for (const component of components) {
		if (component.product === "capability" && component.slot) providers.set(component.slot, component);
	}
	const waiting = new Map<HcpClientcomponent, number>();
	const dependants = new Map<HcpClientcomponent, HcpClientcomponent[]>();
	const absent = new Map<HcpClientcomponent, string[]>();
	for (const component of components) {
		let dependencyCount = 0;
		const missing: string[] = [];
		for (const requirement of new Set(component.requires)) {
			const provider = providers.get(requirement);
			if (provider) {
				dependencyCount += 1;
				const waitingDependants = dependants.get(provider) ?? [];
				waitingDependants.push(component);
				dependants.set(provider, waitingDependants);
				continue;
			}
			if (options.hcp.resolve(`capability:${requirement}`) === undefined) missing.push(requirement);
		}
		waiting.set(component, dependencyCount);
		if (missing.length > 0) absent.set(component, missing);
	}

	const ready = components.filter((component) => waiting.get(component) === 0 && !absent.has(component));
	const attempted = new Set<HcpClientcomponent>();
	const available = new Set<HcpClientcomponent>();
	for (let index = 0; index < ready.length; index++) {
		const component = ready[index]!;
		attempted.add(component);
		const result = await HcpClientbuildcomponent(component, options, packagesRoot);
		if (result.diagnostic) {
			diagnostics.push(result.diagnostic);
			continue;
		}
		if (!result.magnet) continue;
		const routed = HcpClientregistercomponent(
			options.hcp,
			component,
			result.magnet,
			options.replaceExisting !== false,
		);
		if (routed.diagnostic) {
			await HcpClientdisposeproduct(result.magnet);
			diagnostics.push(routed.diagnostic);
			continue;
		}
		addresses.push(...routed.addresses);
		builtComponents.push({ component, addresses: routed.addresses });
		available.add(component);
		for (const dependant of dependants.get(component) ?? []) {
			const remaining = (waiting.get(dependant) ?? 1) - 1;
			waiting.set(dependant, remaining);
			if (remaining === 0 && !absent.has(dependant)) ready.push(dependant);
		}
	}

	const pending = components.filter((component) => !attempted.has(component));
	const cycles = HcpClientdependencycycles(pending, providers);
	for (const component of pending) {
		const missing = component.requires.filter((requirement) => {
			const provider = providers.get(requirement);
			return provider ? !available.has(provider) : options.hcp.resolve(`capability:${requirement}`) === undefined;
		});
		const cycle = cycles.has(component);
		diagnostics.push({
			type: "error",
			code: cycle ? "component_dependency_cycle" : "component_dependency_missing",
			message: cycle
				? `${component.module}:${component.name} participates in a capability dependency cycle [${missing.join(", ")}].`
				: `${component.module}:${component.name} requires unresolved capabilities [${missing.join(", ")}].`,
			module: component.module,
			name: component.name,
			source: component.source,
		});
	}

	return { hcp: options.hcp, addresses: [...new Set(addresses)], builtComponents, diagnostics };
}

async function HcpClientdisposeproduct(magnet: HcpMagnetproduct): Promise<void> {
	if (typeof magnet.dispose !== "function") return;
	try {
		await magnet.dispose();
	} catch {
		// Preserve the routing diagnostic; cleanup is best-effort.
	}
}

function HcpClientdependencyclosure(
	components: readonly HcpClientcomponent[],
	generatedComponents: readonly HcpClientcomponent[],
	hcp: HcpClient,
	disabledModules: ReadonlySet<string>,
): HcpClientcomponent[] {
	const expanded = [...components];
	const provided = new Set(
		expanded
			.filter((component) => component.product === "capability" && component.slot)
			.map((component) => component.slot!),
	);
	const selectedProviders = new Map(
		generatedComponents
			.filter(
				(component) =>
					component.selected &&
					component.product === "capability" &&
					component.slot &&
					!HcpClientmoduledisabled(component.module, disabledModules),
			)
			.map((component) => [component.slot!, component]),
	);

	for (let index = 0; index < expanded.length; index++) {
		for (const requirement of new Set(expanded[index]!.requires)) {
			if (provided.has(requirement) || hcp.resolve(`capability:${requirement}`)) continue;
			const provider = selectedProviders.get(requirement);
			if (!provider) continue;
			expanded.push(provider);
			provided.add(requirement);
		}
	}
	return expanded;
}

function HcpClientdependencycycles(
	components: readonly HcpClientcomponent[],
	providers: ReadonlyMap<string, HcpClientcomponent>,
): Set<HcpClientcomponent> {
	const pending = new Set(components);
	const indices = new Map<HcpClientcomponent, number>();
	const lowLinks = new Map<HcpClientcomponent, number>();
	const stack: HcpClientcomponent[] = [];
	const stacked = new Set<HcpClientcomponent>();
	const cycles = new Set<HcpClientcomponent>();
	let nextIndex = 0;

	const visit = (component: HcpClientcomponent): void => {
		const index = nextIndex++;
		indices.set(component, index);
		lowLinks.set(component, index);
		stack.push(component);
		stacked.add(component);

		for (const requirement of new Set(component.requires)) {
			const provider = providers.get(requirement);
			if (!provider || !pending.has(provider)) continue;
			if (!indices.has(provider)) {
				visit(provider);
				lowLinks.set(component, Math.min(lowLinks.get(component)!, lowLinks.get(provider)!));
			} else if (stacked.has(provider)) {
				lowLinks.set(component, Math.min(lowLinks.get(component)!, indices.get(provider)!));
			}
		}

		if (lowLinks.get(component) !== indices.get(component)) return;
		const connected: HcpClientcomponent[] = [];
		let member: HcpClientcomponent;
		do {
			member = stack.pop()!;
			stacked.delete(member);
			connected.push(member);
		} while (member !== component);
		const selfCycle =
			connected.length === 1 &&
			connected[0]!.requires.some((requirement) => providers.get(requirement) === connected[0]);
		if (connected.length > 1 || selfCycle) {
			for (const cycleMember of connected) cycles.add(cycleMember);
		}
	};

	for (const component of components) {
		if (!indices.has(component)) visit(component);
	}
	return cycles;
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
	replaceExisting: boolean,
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

	try {
		HcpClientregisterparents(hcp, component.module);
		const server = hcp.resolveModule(component.module) ?? new HcpServer();
		const selector = HcpClientcomponentselector(component, magnet);
		const addresses = hcp.registerModule(server, new Map([[selector, magnet]]), {
			merge: true,
			replace: replaceExisting,
			override: component.overrideExisting === true,
		});
		return { addresses };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			addresses: [],
			diagnostic: {
				type: "error",
				code: message.startsWith("HcpClient address collision:")
					? "component_address_collision"
					: "component_routing_failed",
				message: `${component.module}:${component.name} could not be routed: ${message}`,
				module: component.module,
				name: component.name,
				source: component.source,
			},
		};
	}
}

function HcpClientcomponentselector(component: HcpClientcomponent, magnet: HcpMagnetproduct): string {
	if (component.product === "capability") return component.slot!;
	if (component.product === "resource") {
		const resource = magnet.toResource!();
		return `${resource.kind}:${resource.name}`;
	}
	if (component.module.startsWith("tools/")) return component.source;
	if (component.module !== "tools") return component.name;
	const tool = magnet.toTool!();
	return `tool:${tool.name}`;
}

function HcpClientcomponentaddress(component: HcpClientcomponent): string {
	if (component.product === "capability") return `capability:${component.slot}`;
	return `${component.product === "tool" ? "tool" : component.kind}:${component.name}`;
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
			component.product === "capability"
				? `capability:${component.slot}`
				: `${component.product}:${component.module}:${component.kind}:${component.name}`;
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
	packageResourceAddresses: string[];
};

/** Construct the one session Client, then delegate every component attachment to HcpClientassemble. */
export async function HcpClientbuildsession(
	options: HcpClientbuildsessionoptions = {},
): Promise<HcpClientbuildsessionresult> {
	const repoRoot = options.repoRoot ?? process.cwd();
	const packagesRoot = options.packagesRoot ?? options.overlay?.packagesRoot ?? getHarnessPackagesRoot(repoRoot);
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
	const disabledModules = new Set(options.disabledModules ?? []);
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
	for (const template of packageComponentTemplates.filter(
		(component) => component.product === "tool" && !HcpClientmoduledisabled(component.module, disabledModules),
	)) {
		const settings = template.settings as PackageToolBuildSettings;
		const expanded = await expandPackageToolBuildSettings(settings, {
			repoRoot,
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
		disabledModules: options.disabledModules,
		components: packageToolComponents,
	});
	const builtPackageToolComponents = new Set(packageAssembled.builtComponents.map(({ component }) => component));
	for (const component of packageToolComponents) {
		if (builtPackageToolComponents.has(component)) continue;
		const product = (component.settings as PackageToolBuildSettings | undefined)?.product;
		await product?.close?.();
	}
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
	const packageResourceComponentSet = new Set(
		packageComponentTemplates.filter((component) => component.product === "resource"),
	);
	const packageResourceAddresses = assembled.builtComponents
		.filter(({ component }) => packageResourceComponentSet.has(component))
		.flatMap(({ addresses }) => addresses);
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
		packageResourceAddresses: [...new Set(packageResourceAddresses)],
	};
}

function HcpClientpackagecomponents(
	overlay: PackageOverlay,
	diagnostics: PackageDiagnostic[],
	toolDiagnostics: PackageToolDiagnostic[],
): HcpClientcomponent[] {
	const components: HcpClientcomponent[] = [];
	const generatedComponents = HCP_MAGNETS as readonly HcpClientcomponent[];
	const packageContext = {
		components: overlay.components,
		componentMap: overlay.componentMap,
		diagnostics: toolDiagnostics,
	};
	const packageResourceTargets = new Set<string>();
	for (const component of overlay.components) {
		if (component.kind === "tool") {
			const root = generatedComponents.find(
				(entry) => entry.product === "tool" && entry.kind === component.kind && entry.source === "descriptor",
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
				overrideExisting: true,
			});
			continue;
		}

		const resourceKind = HcpClientpackagecomponentkind(component.kind);
		const resourceRoot = generatedComponents.find(
			(entry) => entry.product === "resource" && entry.kind === resourceKind && entry.source === "descriptor",
		);
		if (resourceRoot) {
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
				...resourceRoot,
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
	return components;
}

/** Normalize Package contract aliases; available Resource kinds come only from HCP_MAGNETS. */
function HcpClientpackagecomponentkind(kind: string): string {
	if (kind === "prompt") return "prompt-template";
	if (kind === "append-system-prompt") return "system-prompt";
	return kind;
}
