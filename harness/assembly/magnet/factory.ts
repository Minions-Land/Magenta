import type { HarnessCatalogEntry, HarnessComponentCatalog } from "../../catalog/pi/catalog.ts";
import {
	createHcpProcessMagnetFromCatalogEntry,
	type HcpProcessMagnet,
	type HcpProcessMagnetOptions,
} from "./hcp-process.ts";
import type { Magnet } from "./magnet.ts";
import {
	createProcessToolMagnetFromCatalogEntry,
	type ProcessToolMagnet,
	type ProcessToolMagnetOptions,
} from "./process.ts";

export interface CatalogMagnetFactoryOptions {
	cwd: string;
	env?: NodeJS.ProcessEnv;
	commandOverride?: string;
}

export type CatalogMagnet = ProcessToolMagnet | HcpProcessMagnet | Magnet;

function isMagentaProcessToolPath(path: string | undefined): boolean {
	return /^tools\/[^/]+\/magenta\/[^/]+\.toml$/.test(path ?? "");
}

export function canCreateMagnetFromCatalogEntry(entry: HarnessCatalogEntry): boolean {
	if (entry.kind === "hcp-process" || entry.type === "hcp-process") return true;
	if (isMagentaProcessToolPath(entry.migration.component?.path)) return true;
	return entry.kind === "mcp" && entry.type === "magnet" && entry.migration.state !== "integrated";
}

/**
 * Build a Magnet from a selected catalog entry when Magenta3 has a generic
 * adapter for that implementation family.
 */
export async function createMagnetFromCatalogEntry(
	catalog: HarnessComponentCatalog,
	entry: HarnessCatalogEntry,
	options: CatalogMagnetFactoryOptions,
): Promise<CatalogMagnet> {
	if (entry.kind === "hcp-process" || entry.type === "hcp-process") {
		const hcpOptions: Omit<HcpProcessMagnetOptions, "manifest"> = {
			cwd: options.cwd,
			env: options.env,
		};
		return createHcpProcessMagnetFromCatalogEntry(catalog, entry, hcpOptions);
	}

	if (isMagentaProcessToolPath(entry.migration.component?.path) || canCreateMagnetFromCatalogEntry(entry)) {
		const processOptions: Omit<ProcessToolMagnetOptions, "manifest" | "manifestRoot"> = {
			cwd: options.cwd,
			env: options.env,
			commandOverride: options.commandOverride,
		};
		return createProcessToolMagnetFromCatalogEntry(catalog, entry, processOptions);
	}

	throw new Error(`No generic Magnet is available for catalog entry ${entry.id} (${entry.kind}/${entry.type})`);
}
