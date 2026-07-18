import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TeammateWorktreeRecord } from "./worktree.ts";

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
