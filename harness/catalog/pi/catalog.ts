import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export type HarnessMigrationState =
	| "integrated"
	| "available"
	| "requires-migration"
	| "metadata-only"
	| "external-boundary"
	| "deferred-domain-pack";

export interface CountMap {
	[key: string]: number;
}

export interface HarnessCatalogSummary {
	component_count: number;
	module_count: number;
	by_layer?: CountMap;
	by_kind: CountMap;
	by_source: CountMap;
	by_language?: CountMap;
}

export interface HarnessCatalogSourceReference {
	label: string;
	relationship: string;
	reference_paths?: string[];
	description: string;
}

export interface HarnessInventoryComponent {
	id: string;
	name: string;
	kind: string;
	type: string;
	status: string;
	targets: string[];
	path: string | null;
	impl: string[];
	lang: string[];
	origin: string;
	origin_rel: string;
	origin_confidence?: string;
	refs: string[];
}

export interface HarnessInventoryModule {
	category: string;
	layer: string;
	summary: string;
	roots: string[];
	primary_languages: string[];
	source?: string;
	components: HarnessInventoryComponent[];
}

export interface HarnessComponentInventory {
	schema_version: string;
	generated_at: string;
	repository_root: string;
	scope: string;
	architecture_boundary?: string[];
	summary: HarnessCatalogSummary;
	origin_relationship_legend?: Record<string, string>;
	source_references: Record<string, HarnessCatalogSourceReference>;
	modules: Record<string, HarnessInventoryModule>;
}

export interface HarnessCatalogComponentRef {
	kind: string;
	name: string;
	path: string;
}

export interface HarnessIntegrationEntry {
	state: HarnessMigrationState;
	component?: HarnessCatalogComponentRef;
	relation?: string;
	notes?: string;
}

export interface HarnessIntegrationMap {
	schema_version: string;
	source_catalog: string;
	entries: Record<string, HarnessIntegrationEntry>;
}

export interface HarnessCatalogEntry extends HarnessInventoryComponent {
	module: {
		id: string;
		category: string;
		layer: string;
		summary: string;
		roots: string[];
		primaryLanguages: string[];
		source?: string;
	};
	migration: HarnessIntegrationEntry;
}

export interface HarnessComponentCatalog {
	name: string;
	inventoryPath: string;
	integrationMapPath?: string;
	inventory: HarnessComponentInventory;
	entries: HarnessCatalogEntry[];
	summary: HarnessCatalogSummary;
	sourceReferences: Record<string, HarnessCatalogSourceReference>;
}

export interface HarnessCatalogFilter {
	kinds?: readonly string[];
	origins?: readonly string[];
	statuses?: readonly string[];
	migrationStates?: readonly HarnessMigrationState[];
}

export interface HarnessCatalogComputedSummary {
	total: number;
	byKind: CountMap;
	byOrigin: CountMap;
	byStatus: CountMap;
	byMigrationState: CountMap;
}

export interface HarnessSelectionItem {
	id: string;
	label: string;
	kind: string;
	type: string;
	status: string;
	origin: string;
	originRel: string;
	targets: string[];
	sourceCatalog: string;
	sourcePath: string | null;
	refs: string[];
	migrationState: HarnessMigrationState;
	readiness: "ready" | "requires-migration" | "metadata-only" | "external-boundary" | "domain-pack";
	component?: HarnessCatalogComponentRef;
	notes?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function countBy<T>(items: readonly T[], keyOf: (item: T) => string): CountMap {
	const counts: CountMap = {};
	for (const item of items) {
		const key = keyOf(item);
		counts[key] = (counts[key] ?? 0) + 1;
	}
	return counts;
}

function readString(record: Record<string, unknown>, key: string, errors: string[], context: string): string {
	const value = record[key];
	if (typeof value === "string") return value;
	errors.push(`${context}.${key} must be a string`);
	return "";
}

function readStringArray(record: Record<string, unknown>, key: string, errors: string[], context: string): string[] {
	const value = record[key];
	if (isStringArray(value)) return value;
	errors.push(`${context}.${key} must be an array of strings`);
	return [];
}

export function validateHarnessComponentInventory(value: unknown): string[] {
	const errors: string[] = [];
	if (!isRecord(value)) return ["catalog must be a JSON object"];

	for (const key of ["schema_version", "generated_at", "repository_root", "scope"]) {
		readString(value, key, errors, "catalog");
	}

	if (!isRecord(value.summary)) {
		errors.push("catalog.summary must be an object");
	} else {
		if (typeof value.summary.component_count !== "number") {
			errors.push("catalog.summary.component_count must be a number");
		}
		if (typeof value.summary.module_count !== "number") {
			errors.push("catalog.summary.module_count must be a number");
		}
	}

	if (!isRecord(value.source_references)) {
		errors.push("catalog.source_references must be an object");
	}

	if (!isRecord(value.modules)) {
		errors.push("catalog.modules must be an object");
		return errors;
	}

	let componentCount = 0;
	for (const [moduleId, rawModule] of Object.entries(value.modules)) {
		const moduleContext = `catalog.modules.${moduleId}`;
		if (!isRecord(rawModule)) {
			errors.push(`${moduleContext} must be an object`);
			continue;
		}
		for (const key of ["category", "layer", "summary"]) {
			readString(rawModule, key, errors, moduleContext);
		}
		readStringArray(rawModule, "roots", errors, moduleContext);
		readStringArray(rawModule, "primary_languages", errors, moduleContext);
		if (!Array.isArray(rawModule.components)) {
			errors.push(`${moduleContext}.components must be an array`);
			continue;
		}
		for (let index = 0; index < rawModule.components.length; index++) {
			const componentContext = `${moduleContext}.components.${index}`;
			const rawComponent = rawModule.components[index];
			componentCount++;
			if (!isRecord(rawComponent)) {
				errors.push(`${componentContext} must be an object`);
				continue;
			}
			for (const key of ["id", "name", "kind", "type", "status", "origin", "origin_rel"]) {
				readString(rawComponent, key, errors, componentContext);
			}
			if (rawComponent.path !== null && rawComponent.path !== undefined && typeof rawComponent.path !== "string") {
				errors.push(`${componentContext}.path must be a string or null`);
			}
			for (const key of ["targets", "impl", "lang", "refs"]) {
				readStringArray(rawComponent, key, errors, componentContext);
			}
		}
	}

	if (isRecord(value.summary) && typeof value.summary.component_count === "number") {
		if (value.summary.component_count !== componentCount) {
			errors.push(
				`catalog.summary.component_count is ${value.summary.component_count}, but modules contain ${componentCount}`,
			);
		}
	}

	return errors;
}

export function assertHarnessComponentInventory(value: unknown): asserts value is HarnessComponentInventory {
	const errors = validateHarnessComponentInventory(value);
	if (errors.length > 0) {
		throw new Error(`Invalid harness component catalog:\n${errors.map((error) => `- ${error}`).join("\n")}`);
	}
}

function deriveMigration(
	component: HarnessInventoryComponent,
	override?: HarnessIntegrationEntry,
): HarnessIntegrationEntry {
	if (override) return override;
	if (component.origin === "domain-pack" || component.status.startsWith("deferred/")) {
		return { state: "deferred-domain-pack" };
	}
	if (component.status === "metadata-only") {
		return { state: "metadata-only" };
	}
	if (
		component.origin === "external-upstream" ||
		component.origin_rel.includes("external") ||
		component.origin_rel.includes("adapter-boundary")
	) {
		return { state: "external-boundary" };
	}
	return { state: "requires-migration" };
}

export function flattenHarnessCatalogEntries(
	inventory: HarnessComponentInventory,
	integrationMap?: HarnessIntegrationMap,
): HarnessCatalogEntry[] {
	const entries: HarnessCatalogEntry[] = [];
	for (const [moduleId, module] of Object.entries(inventory.modules)) {
		for (const component of module.components) {
			entries.push({
				...component,
				module: {
					id: moduleId,
					category: module.category,
					layer: module.layer,
					summary: module.summary,
					roots: module.roots,
					primaryLanguages: module.primary_languages,
					source: module.source,
				},
				migration: deriveMigration(component, integrationMap?.entries[component.id]),
			});
		}
	}
	return entries;
}

export async function loadHarnessIntegrationMap(path: string): Promise<HarnessIntegrationMap> {
	const raw = JSON.parse(await readFile(path, "utf-8")) as unknown;
	if (!isRecord(raw) || typeof raw.schema_version !== "string" || typeof raw.source_catalog !== "string") {
		throw new Error(`Invalid harness integration map: ${path}`);
	}
	if (!isRecord(raw.entries)) {
		throw new Error(`Invalid harness integration map: ${path}`);
	}
	return raw as unknown as HarnessIntegrationMap;
}

export async function loadHarnessComponentCatalog(
	name: string,
	inventoryPath: string,
	options?: { integrationMapPath?: string },
): Promise<HarnessComponentCatalog> {
	const inventoryAbs = isAbsolute(inventoryPath) ? inventoryPath : resolve(inventoryPath);
	const rawInventory = JSON.parse(await readFile(inventoryAbs, "utf-8")) as unknown;
	assertHarnessComponentInventory(rawInventory);

	const integrationMapPath = options?.integrationMapPath
		? isAbsolute(options.integrationMapPath)
			? options.integrationMapPath
			: resolve(options.integrationMapPath)
		: undefined;
	const integrationMap = integrationMapPath ? await loadHarnessIntegrationMap(integrationMapPath) : undefined;
	const entries = flattenHarnessCatalogEntries(rawInventory, integrationMap);

	return {
		name,
		inventoryPath: inventoryAbs,
		integrationMapPath,
		inventory: rawInventory,
		entries,
		summary: rawInventory.summary,
		sourceReferences: rawInventory.source_references,
	};
}

export function filterHarnessCatalogEntries(
	entries: readonly HarnessCatalogEntry[],
	filter: HarnessCatalogFilter,
): HarnessCatalogEntry[] {
	return entries.filter((entry) => {
		if (filter.kinds && !filter.kinds.includes(entry.kind)) return false;
		if (filter.origins && !filter.origins.includes(entry.origin)) return false;
		if (filter.statuses && !filter.statuses.includes(entry.status)) return false;
		if (filter.migrationStates && !filter.migrationStates.includes(entry.migration.state)) return false;
		return true;
	});
}

export function summarizeHarnessCatalogEntries(entries: readonly HarnessCatalogEntry[]): HarnessCatalogComputedSummary {
	return {
		total: entries.length,
		byKind: countBy(entries, (entry) => entry.kind),
		byOrigin: countBy(entries, (entry) => entry.origin),
		byStatus: countBy(entries, (entry) => entry.status),
		byMigrationState: countBy(entries, (entry) => entry.migration.state),
	};
}

function readinessFor(entry: HarnessCatalogEntry): HarnessSelectionItem["readiness"] {
	const state = entry.migration.state;
	switch (state) {
		case "integrated":
			return "ready";
		case "available":
			return entry.migration.component ? "ready" : "requires-migration";
		case "requires-migration":
			return "requires-migration";
		case "metadata-only":
			return "metadata-only";
		case "external-boundary":
			return "external-boundary";
		case "deferred-domain-pack":
			return "domain-pack";
	}
}

export function toHarnessSelectionItems(
	catalog: HarnessComponentCatalog,
	entries: readonly HarnessCatalogEntry[] = catalog.entries,
): HarnessSelectionItem[] {
	return entries.map((entry) => ({
		id: entry.id,
		label: entry.name,
		kind: entry.kind,
		type: entry.type,
		status: entry.status,
		origin: entry.origin,
		originRel: entry.origin_rel,
		targets: entry.targets,
		sourceCatalog: catalog.name,
		sourcePath: entry.path,
		refs: entry.refs,
		migrationState: entry.migration.state,
		readiness: readinessFor(entry),
		component: entry.migration.component,
		notes: entry.migration.notes,
	}));
}
