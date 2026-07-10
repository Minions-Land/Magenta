import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { parseToml, type TomlTable } from "../../.HCP/registry/registry.ts";
import type {
	SandboxDiscoverResult,
	SandboxProfile,
	SandboxProviderOptions,
	SandboxSelection,
	SandboxSelectionTool,
} from "../HcpServer.ts";

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function profileFromToml(table: TomlTable, path?: string): SandboxProfile {
	const kind = asString(table.kind) ?? "sandbox";
	const name = asString(table.name);
	const description = asString(table.description);
	if (!name || !description) {
		throw new Error(`sandbox profile ${path ?? "<inline>"} requires name and description`);
	}
	if (kind !== "sandbox") {
		throw new Error(`sandbox profile ${path ?? name} has unsupported kind "${kind}"`);
	}
	return {
		kind,
		name,
		description,
		fs_read: asStringArray(table.fs_read),
		fs_write: asStringArray(table.fs_write),
		network: asString(table.network) ?? "deny",
		network_allowlist: asStringArray(table.network_allowlist),
		max_memory_mb: asNumber(table.max_memory_mb) ?? 0,
		max_wall_seconds: asNumber(table.max_wall_seconds) ?? 0,
		env_allowlist: asStringArray(table.env_allowlist),
		backend: asString(table.backend) ?? "auto",
		source: asString(table.source),
		origin: asString(table.origin),
		origin_rel: asString(table.origin_rel),
		path,
	};
}

function toolFromInput(input: unknown): SandboxSelectionTool {
	const record = asRecord(input);
	const rawTool = asRecord(record?.tool) ?? record ?? {};
	return {
		read_only: asBoolean(rawTool.read_only),
		destructive: asBoolean(rawTool.destructive),
		tags: asStringArray(rawTool.tags),
		operation: asString(rawTool.operation),
		name: asString(rawTool.name),
	};
}

export function selectSandboxProfile(input: unknown): SandboxSelection {
	const tool = toolFromInput(input);
	const tags = tool.tags ?? [];
	const readOnly = tool.read_only ?? false;
	const destructive = tool.destructive ?? false;
	const writesWorkspace = tool.operation === "write" || tool.operation === "edit";
	const trusted = tags.includes("trusted");
	const networkRead = tags.includes("network-read");
	const workspaceWrite = writesWorkspace || tags.includes("workspace-write");
	const profile = trusted
		? "trusted"
		: networkRead
			? "network-read"
			: workspaceWrite
				? "workspace-write"
				: readOnly
					? "readonly-fs"
					: "restricted";

	return {
		profile,
		reason: {
			read_only: readOnly,
			destructive,
			trusted,
			network_read: networkRead,
			workspace_write: workspaceWrite,
		},
	};
}

export function loadSandboxProfileSync(path: string): SandboxProfile {
	const abs = isAbsolute(path) ? path : resolve(path);
	return profileFromToml(parseToml(readFileSync(abs, "utf-8")), abs);
}

export async function loadSandboxProfile(path: string): Promise<SandboxProfile> {
	const abs = isAbsolute(path) ? path : resolve(path);
	return profileFromToml(parseToml(await readFile(abs, "utf-8")), abs);
}

export function loadSandboxProfilesSync(paths: readonly string[], root = process.cwd()): SandboxProfile[] {
	return paths.map((path) => loadSandboxProfileSync(isAbsolute(path) ? path : resolve(root, path)));
}

export async function loadSandboxProfiles(paths: readonly string[], root = process.cwd()): Promise<SandboxProfile[]> {
	return Promise.all(paths.map((path) => loadSandboxProfile(isAbsolute(path) ? path : resolve(root, path))));
}

export function loadSandboxProviderFromPackSync(path: string): SandboxProvider {
	const abs = isAbsolute(path) ? path : resolve(path);
	const root = dirname(abs);
	const pack = parseToml(readFileSync(abs, "utf-8"));
	const profiles = asStringArray(pack.profiles);
	if (profiles.length === 0) {
		throw new Error(`sandbox pack ${abs} declares no profiles`);
	}
	return new SandboxProvider({
		profiles: loadSandboxProfilesSync(profiles, root),
	});
}

export async function loadSandboxProviderFromPack(path: string): Promise<SandboxProvider> {
	const abs = isAbsolute(path) ? path : resolve(path);
	const root = dirname(abs);
	const pack = parseToml(await readFile(abs, "utf-8"));
	const profiles = asStringArray(pack.profiles);
	if (profiles.length === 0) {
		throw new Error(`sandbox pack ${abs} declares no profiles`);
	}
	return new SandboxProvider({
		profiles: await loadSandboxProfiles(profiles, root),
	});
}

export class SandboxProvider {
	private readonly profiles = new Map<string, SandboxProfile>();

	constructor(options: SandboxProviderOptions) {
		for (const profile of options.profiles) {
			this.profiles.set(profile.name, profile);
		}
	}

	get(name: string): SandboxProfile {
		const profile = this.profiles.get(name);
		if (!profile) {
			throw new Error(`sandbox profile not found: ${name}`);
		}
		return profile;
	}

	list(): SandboxProfile[] {
		return [...this.profiles.values()].sort((a, b) => a.name.localeCompare(b.name));
	}

	discover(): SandboxDiscoverResult {
		return {
			provider: "sandbox",
			targets: this.list().map((profile) => `sandbox://${profile.name}`),
			profiles: this.list(),
			selectionTarget: "hook://sandbox-select",
			enforcement: "not-ported",
		};
	}

	resolve(input: unknown, fallbackName?: string): { selection: SandboxSelection; profile: SandboxProfile } {
		const record = asRecord(input);
		const explicitName = asString(record?.name) ?? asString(record?.profile) ?? fallbackName;
		const selection = explicitName
			? { ...selectSandboxProfile({}), profile: explicitName }
			: selectSandboxProfile(input);
		return {
			selection,
			profile: this.get(selection.profile),
		};
	}
}

// 重新导出供外部使用
export type { SandboxProfile, SandboxSelection } from "../HcpServer.ts";
