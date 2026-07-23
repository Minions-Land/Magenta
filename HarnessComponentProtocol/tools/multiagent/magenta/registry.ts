import { type Dirent, existsSync, mkdirSync, readFileSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { removeOwnedPathIfUnchanged, snapshotOwnedPath } from "../../../_magenta/owned-path.ts";
import type { TeammateWorktreeRecord } from "./worktree.ts";

export const DEFAULT_EMPTY_MULTIAGENT_REGISTRY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_EMPTY_REGISTRY_BYTES = 64 * 1024;

export type DesiredProcessState = "running" | "stopped";
export type ObservedProcessState =
	| "queued"
	| "starting"
	| "running"
	| "idle"
	| "active"
	| "interrupting"
	| "stopping"
	| "stopped"
	| "failed";

export type PendingInterrupt = {
	requestedAt: number;
	replacementMessage?: string;
};

export type MultiagentRecord = {
	schemaVersion: 1;
	parentSessionId: string;
	parentSessionFile?: string;
	sessionId: string;
	sessionFile?: string;
	label: string;
	requestedCwd: string;
	cwd: string;
	workspace: "shared" | "worktree";
	tools: string[];
	model?: string;
	provider?: string;
	thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	desiredProcessState: DesiredProcessState;
	observedProcessState: ObservedProcessState;
	createdAt: number;
	updatedAt: number;
	queuedAt?: number;
	startedAt?: number;
	endedAt?: number;
	processGeneration: number;
	processPid?: number;
	parentRuntimeId?: string;
	autoResumeAttemptedAt?: number;
	pendingInterrupt?: PendingInterrupt;
	pendingBootstrapMessage?: string;
	bootstrapMessageId?: string;
	lastError?: string;
	worktreeGeneration: number;
	worktrees: TeammateWorktreeRecord[];
};

type RegistryFile = {
	schemaVersion: 1;
	parentSessionId: string;
	updatedAt: number;
	records: MultiagentRecord[];
};

export type EmptyRegistryCleanupOptions = {
	registryDir: string;
	/** Complete, fail-closed set of parent Session ids known to still exist. */
	liveParentSessionIds: ReadonlySet<string>;
	maxAgeMs?: number;
	now?: number;
};

export type EmptyRegistryCleanupResult = {
	scannedFiles: number;
	deletedFiles: number;
};

function cloneRecord(record: MultiagentRecord): MultiagentRecord {
	return structuredClone(record);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseRegistry(value: unknown, parentSessionId: string): MultiagentRecord[] {
	if (!isRecord(value) || value.schemaVersion !== 1 || value.parentSessionId !== parentSessionId) {
		throw new Error("Multiagent registry identity or schema version is invalid");
	}
	if (!Array.isArray(value.records)) throw new Error("Multiagent registry records must be an array");
	const sessionIds = new Set<string>();
	return value.records.map((candidate) => {
		if (!isRecord(candidate) || candidate.schemaVersion !== 1) {
			throw new Error("Multiagent registry contains an invalid record");
		}
		if (candidate.parentSessionId !== parentSessionId || typeof candidate.sessionId !== "string") {
			throw new Error("Multiagent registry contains a record outside the owning Main lineage");
		}
		if (sessionIds.has(candidate.sessionId)) throw new Error("Multiagent registry contains duplicate Session ids");
		sessionIds.add(candidate.sessionId);
		return candidate as MultiagentRecord;
	});
}

function parseEmptyRegistry(value: unknown, fileName: string): RegistryFile | undefined {
	if (!isRecord(value)) return undefined;
	const keys = Object.keys(value).sort();
	if (keys.join("\u0000") !== ["parentSessionId", "records", "schemaVersion", "updatedAt"].join("\u0000")) {
		return undefined;
	}
	if (
		value.schemaVersion !== 1 ||
		typeof value.parentSessionId !== "string" ||
		!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(value.parentSessionId) ||
		`${value.parentSessionId}.json` !== fileName ||
		typeof value.updatedAt !== "number" ||
		!Number.isFinite(value.updatedAt) ||
		value.updatedAt < 0 ||
		!Array.isArray(value.records) ||
		value.records.length !== 0
	) {
		return undefined;
	}
	return value as RegistryFile;
}

/**
 * Delete only old, empty registries whose parent Session is proven absent.
 * The caller must supply a complete Session-id snapshot; an uncertain Session
 * scan must not call this function. Unknown schemas, links, locks, temporary
 * siblings, and concurrently replaced files are preserved.
 */
export async function cleanupEmptyOrphanMultiagentRegistries(
	options: EmptyRegistryCleanupOptions,
): Promise<EmptyRegistryCleanupResult> {
	const result: EmptyRegistryCleanupResult = { scannedFiles: 0, deletedFiles: 0 };
	if (!(await snapshotOwnedPath(options.registryDir, "directory"))) return result;
	let entries: Dirent<string>[];
	try {
		entries = await readdir(options.registryDir, { withFileTypes: true, encoding: "utf8" });
	} catch {
		return result;
	}
	const now = options.now ?? Date.now();
	const maxAgeMs = options.maxAgeMs ?? DEFAULT_EMPTY_MULTIAGENT_REGISTRY_MAX_AGE_MS;

	for (const entry of entries) {
		if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) continue;
		result.scannedFiles++;
		if (entries.some((candidate) => candidate.name.startsWith(`${entry.name}.`))) continue;
		const path = join(options.registryDir, entry.name);
		const snapshot = await snapshotOwnedPath(path, "file");
		if (!snapshot || snapshot.size > MAX_EMPTY_REGISTRY_BYTES) continue;
		let registry: RegistryFile | undefined;
		try {
			registry = parseEmptyRegistry(JSON.parse(await readFile(path, "utf8")) as unknown, entry.name);
		} catch {
			continue;
		}
		if (!registry || options.liveParentSessionIds.has(registry.parentSessionId)) continue;
		const newestTimestamp = Math.max(snapshot.mtimeMs, registry.updatedAt);
		if (maxAgeMs < 0 || now - newestTimestamp < maxAgeMs) continue;
		if (await removeOwnedPathIfUnchanged(path, snapshot)) result.deletedFiles++;
	}
	return result;
}

export class DurableMultiagentRegistry {
	readonly path: string;
	readonly parentSessionId: string;
	private readonly records = new Map<string, MultiagentRecord>();
	private writeChain: Promise<void> = Promise.resolve();

	constructor(path: string, parentSessionId: string) {
		this.path = path;
		this.parentSessionId = parentSessionId;
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		if (!existsSync(path)) return;
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		for (const record of parseRegistry(parsed, parentSessionId)) this.records.set(record.sessionId, record);
	}

	list(): MultiagentRecord[] {
		return [...this.records.values()].map(cloneRecord);
	}

	get(sessionId: string): MultiagentRecord | undefined {
		const record = this.records.get(sessionId);
		return record ? cloneRecord(record) : undefined;
	}

	async upsert(record: MultiagentRecord): Promise<void> {
		if (record.parentSessionId !== this.parentSessionId) {
			throw new Error("Cannot persist a Multiagent record outside the owning Main lineage");
		}
		this.records.set(record.sessionId, cloneRecord(record));
		await this.persist();
	}

	async replace(records: Iterable<MultiagentRecord>): Promise<void> {
		this.records.clear();
		for (const record of records) {
			if (record.parentSessionId !== this.parentSessionId) {
				throw new Error("Cannot persist a Multiagent record outside the owning Main lineage");
			}
			this.records.set(record.sessionId, cloneRecord(record));
		}
		await this.persist();
	}

	private persist(): Promise<void> {
		const snapshot: RegistryFile = {
			schemaVersion: 1,
			parentSessionId: this.parentSessionId,
			updatedAt: Date.now(),
			records: [...this.records.values()].map(cloneRecord),
		};
		const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
		const write = this.writeChain.then(async () => {
			await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
			await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
			await rename(temporary, this.path);
			await chmod(this.path, 0o600);
		});
		this.writeChain = write.catch(() => undefined);
		return write;
	}
}
