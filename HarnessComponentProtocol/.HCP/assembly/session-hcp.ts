import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { HcpClient, HcpClientisbunbinaryurl } from "../../HcpClient.ts";
import type { HcpMagnetBinding, HcpMagnetBuildContext, HcpMagnetResource } from "../HcpMagnetTypes.ts";
import { HCP_MAGNETS, HCP_SERVERS } from "./sources.generated.ts";

// Detect Bun compiled binary: import.meta.url uses a Bun virtual filesystem path.
// In this case, resolve HCP_ROOT from the executable's directory instead.
const HCP_IS_BUN_BINARY = typeof (globalThis as any).Bun !== "undefined" && HcpClientisbunbinaryurl(import.meta.url);
const HCP_ROOT = HCP_IS_BUN_BINARY ? dirname(process.execPath) : fileURLToPath(new URL("../..", import.meta.url));

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

type HcpServerclass = new () => {
	readonly moduleName: string;
	readonly description?: string;
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
	/** A dynamically supplied component keeps its real owning Module Server. */
	HcpServer?: HcpServerclass;
	/** Host metadata merged into Resource products without changing Source code. */
	HcpClientresourcemetadata?: Readonly<Record<string, unknown>>;
	/** Explicitly allow one descriptor component to expand into multiple Tool magnets. */
	HcpClientallowfanout?: boolean;
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
		| "component_server_collision"
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
	/** Host-owned cache root; components must not write reconstructable state into repoRoot. */
	cacheRoot?: string;
	cwd?: string;
	/** Allow generated rows to be selected directly by autoload/modules/settings. Default true. */
	includeGenerated?: boolean;
	/** Include TOML-selected entries marked autoload=true. Default true. */
	includeAutoload?: boolean;
	/** Additionally assemble these real module paths through the same pipeline. */
	modules?: readonly string[];
	/** Additionally assemble selected generated rows for these Magnet products. */
	includeSelectedProducts?: readonly HcpClientcomponent["product"][];
	/** Dynamic entries supplied by a host adapter and merged into this assembly pass. */
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
 * Every input names a generated module Server, source Magnet, product, slot,
 * and dependency edges. Host adapters may add components or settings, but the
 * Client does not interpret where those inputs came from.
 */
export async function HcpClientassemble(options: HcpClientassembleoptions): Promise<HcpClientassembleresult> {
	const disabledModules = new Set(options.disabledModules ?? []);
	const requestedModules = new Set(options.modules ?? []);
	const selectedProducts = new Set(options.includeSelectedProducts ?? []);
	const generatedComponents: readonly HcpClientcomponent[] = HCP_MAGNETS;
	const generated =
		options.includeGenerated === false
			? []
			: generatedComponents.filter((entry) => {
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
		const result = await HcpClientbuildcomponent(component, options);
		if (result.diagnostic) {
			diagnostics.push(result.diagnostic);
			continue;
		}
		if (!result.magnets) continue;
		const componentAddresses: string[] = [];
		for (const magnet of result.magnets) {
			const product = HcpClientwithresourcemetadata(component, magnet);
			const routed = HcpClientregistercomponent(options.hcp, component, product, options.replaceExisting !== false);
			if (routed.diagnostic) {
				await HcpClientdisposeproduct(product);
				diagnostics.push(routed.diagnostic);
				continue;
			}
			componentAddresses.push(...routed.addresses);
		}
		if (componentAddresses.length === 0) continue;
		addresses.push(...componentAddresses);
		builtComponents.push({ component, addresses: componentAddresses });
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

function HcpClientwithresourcemetadata(component: HcpClientcomponent, magnet: HcpMagnetproduct): HcpMagnetproduct {
	if (!component.HcpClientresourcemetadata || typeof magnet.toResource !== "function") return magnet;
	const toResource = magnet.toResource.bind(magnet);
	return {
		kind: magnet.kind,
		source: magnet.source,
		hotSwappable: magnet.hotSwappable,
		toResource: (): HcpMagnetResource => {
			const resource = toResource();
			return {
				...resource,
				metadata: { ...resource.metadata, ...component.HcpClientresourcemetadata },
			};
		},
		...(typeof magnet.dispose === "function" ? { dispose: magnet.dispose.bind(magnet) } : {}),
	};
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
): Promise<{ magnets?: HcpMagnetproduct[]; diagnostic?: HcpClientassemblydiagnostic }> {
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
			cacheRoot: options.cacheRoot,
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
		const magnets = Array.isArray(built) ? built : [built];
		if (magnets.length === 0) {
			if (component.product === "tool" && component.autoload === false) return {};
			throw new Error("build returned an empty HcpMagnet product list");
		}
		if (!magnets.every(HcpMagnetisproduct)) {
			await Promise.all(magnets.filter(HcpMagnetisproduct).map(HcpClientdisposeproduct));
			throw new Error("build returned a value that is not an HcpMagnet product");
		}
		if (magnets.length > 1 && !HcpClientcomponentallowsfanout(component)) {
			await Promise.all(magnets.map(HcpClientdisposeproduct));
			return {
				diagnostic: {
					type: "error",
					code: "component_product_invalid",
					message: `${component.module}:${component.source} returned ${magnets.length} products, but this Module requires one product per component.`,
					module: component.module,
					name: component.name,
					source: component.source,
				},
			};
		}
		return { magnets };
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

	const HcpServer = component.HcpServer ?? HCP_SERVERS.get(component.module);
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
		const existingServer = hcp.resolveModule(component.module);
		const candidateServer = new HcpServer();
		if (
			existingServer &&
			existingServer.constructor !== candidateServer.constructor &&
			(HcpClientserverhascustomrouting(existingServer) || HcpClientserverhascustomrouting(candidateServer))
		) {
			return {
				addresses: [],
				diagnostic: {
					type: "error",
					code: "component_server_collision",
					message: `${component.module}:${component.name} declares a different HcpServer with custom Source routing, but that Module already has an owning HcpServer.`,
					module: component.module,
					name: component.name,
					source: component.source,
				},
			};
		}
		const server = existingServer ?? candidateServer;
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

function HcpClientserverhascustomrouting(server: object): boolean {
	const candidate = server as Record<string, unknown>;
	return ["describeSource", "sourceAddresses", "callSource"].some((method) => typeof candidate[method] === "function");
}

function HcpClientcomponentselector(component: HcpClientcomponent, magnet: HcpMagnetproduct): string {
	if (component.product === "capability") return component.slot!;
	if (component.product === "resource") {
		const resource = magnet.toResource!();
		return `${resource.kind}:${resource.name}`;
	}
	if (component.module.startsWith("tools/")) {
		const tool = magnet.toTool!();
		return `tool:${tool.name}`;
	}
	if (component.module !== "tools") return component.name;
	const tool = magnet.toTool!();
	return `tool:${tool.name}`;
}

function HcpClientcomponentaddress(component: HcpClientcomponent): string {
	if (component.product === "capability") return `capability:${component.slot}`;
	return `${component.product === "tool" ? "tool" : component.kind}:${component.name}`;
}

function HcpClientcomponentallowsfanout(component: HcpClientcomponent): boolean {
	return (
		component.product === "resource" ||
		(component.product === "tool" && (component.module === "tools" || component.HcpClientallowfanout === true))
	);
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
	cacheRoot?: string;
	cwd?: string;
	components?: readonly HcpClientcomponent[];
	disabledModules?: readonly string[];
	settings?: Readonly<Record<string, unknown>>;
	descriptions?: Readonly<Record<string, string | undefined>>;
	modules?: readonly string[];
};

export type HcpClientbuildsessionresult = HcpClientassembleresult & {
	toolAddresses: string[];
};

/** Construct the one session Client, then delegate every component attachment to HcpClientassemble. */
export async function HcpClientbuildsession(
	options: HcpClientbuildsessionoptions = {},
): Promise<HcpClientbuildsessionresult> {
	const repoRoot = options.repoRoot ?? process.cwd();
	const hcp = new HcpClient();
	let HcpClientresultpublished = false;
	try {
		const suppliedComponents = options.components ?? [];
		const HcpClientsuppliednontools = await HcpClientassemble({
			hcp,
			repoRoot,
			cacheRoot: options.cacheRoot,
			cwd: options.cwd ?? repoRoot,
			includeGenerated: false,
			includeAutoload: false,
			disabledModules: options.disabledModules,
			components: suppliedComponents.filter((component) => component.product !== "tool"),
			settings: options.settings,
			descriptions: options.descriptions,
		});
		const HcpClientdefaults = await HcpClientassemble({
			hcp,
			repoRoot,
			cacheRoot: options.cacheRoot,
			cwd: options.cwd ?? repoRoot,
			includeAutoload: true,
			disabledModules: options.disabledModules,
			modules: options.modules,
			skipOccupied: true,
			settings: options.settings,
			descriptions: options.descriptions,
		});
		const HcpClientsuppliedtools = await HcpClientassemble({
			hcp,
			repoRoot,
			cacheRoot: options.cacheRoot,
			cwd: options.cwd ?? repoRoot,
			includeGenerated: false,
			includeAutoload: false,
			disabledModules: options.disabledModules,
			components: suppliedComponents.filter((component) => component.product === "tool"),
			settings: options.settings,
			descriptions: options.descriptions,
		});
		const HcpClientassembled: HcpClientassembleresult = {
			hcp,
			addresses: [
				...new Set([
					...HcpClientsuppliednontools.addresses,
					...HcpClientdefaults.addresses,
					...HcpClientsuppliedtools.addresses,
				]),
			],
			builtComponents: [
				...HcpClientsuppliednontools.builtComponents,
				...HcpClientdefaults.builtComponents,
				...HcpClientsuppliedtools.builtComponents,
			],
			diagnostics: [
				...HcpClientsuppliednontools.diagnostics,
				...HcpClientdefaults.diagnostics,
				...HcpClientsuppliedtools.diagnostics,
			],
		};
		const toolAddresses = HcpClientassembled.addresses.filter((address) => address.startsWith("tool:"));
		const result = {
			...HcpClientassembled,
			toolAddresses: [...new Set(toolAddresses)],
		};
		HcpClientresultpublished = true;
		return result;
	} finally {
		if (!HcpClientresultpublished) await hcp.dispose();
	}
}
