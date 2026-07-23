import { basename, join } from "node:path";
import { secureAtomicWriteFile, secureFileExists, secureReadFile, withSecureFileLock } from "@magenta/harness";

export const SESSION_METADATA_INDEX_NAME = ".magenta-session-index.json";
export const SESSION_SEARCH_TEXT_MAX_BYTES = 128 * 1024;
export const SESSION_FIRST_MESSAGE_MAX_BYTES = 4 * 1024;

const SESSION_METADATA_INDEX_VERSION = 1;
export const SESSION_METADATA_INDEX_MAX_BYTES = 16 * 1024 * 1024;
const SESSION_METADATA_INDEX_MAX_ENTRIES = 10_000;

export type SessionFileIdentity = {
	device: string;
	inode: string;
	size: string;
	mtimeNs: string;
	ctimeNs: string;
};

export type CachedSessionMetadata = {
	id: string;
	cwd: string;
	name?: string;
	parentSessionPath?: string;
	created: string;
	modified: string;
	messageCount: number;
	firstMessage: string;
	allMessagesText: string;
};

export type SessionMetadataIndexRecord = {
	identity: SessionFileIdentity;
	metadata: CachedSessionMetadata | null;
};

export type SessionMetadataIndexSnapshot = {
	records: Map<string, SessionMetadataIndexRecord>;
	writable: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeSessionBasename(value: string): boolean {
	return value === basename(value) && value.endsWith(".jsonl") && !value.includes("\0");
}

function parseIdentity(value: unknown): SessionFileIdentity | undefined {
	if (!isRecord(value)) return undefined;
	const isBoundedDecimal = (candidate: unknown): candidate is string =>
		typeof candidate === "string" && candidate.length <= 32 && /^\d+$/.test(candidate);
	if (
		!isBoundedDecimal(value.device) ||
		!isBoundedDecimal(value.inode) ||
		!isBoundedDecimal(value.size) ||
		!isBoundedDecimal(value.mtimeNs) ||
		!isBoundedDecimal(value.ctimeNs)
	) {
		return undefined;
	}
	return {
		device: value.device,
		inode: value.inode,
		size: value.size,
		mtimeNs: value.mtimeNs,
		ctimeNs: value.ctimeNs,
	};
}

function parseMetadata(value: unknown): CachedSessionMetadata | null | undefined {
	if (value === null) return null;
	if (!isRecord(value)) return undefined;
	if (
		typeof value.id !== "string" ||
		typeof value.cwd !== "string" ||
		(value.name !== undefined && typeof value.name !== "string") ||
		(value.parentSessionPath !== undefined && typeof value.parentSessionPath !== "string") ||
		typeof value.created !== "string" ||
		!Number.isFinite(Date.parse(value.created)) ||
		typeof value.modified !== "string" ||
		!Number.isFinite(Date.parse(value.modified)) ||
		typeof value.messageCount !== "number" ||
		!Number.isSafeInteger(value.messageCount) ||
		value.messageCount < 0 ||
		typeof value.firstMessage !== "string" ||
		Buffer.byteLength(value.firstMessage, "utf8") > SESSION_FIRST_MESSAGE_MAX_BYTES ||
		typeof value.allMessagesText !== "string" ||
		Buffer.byteLength(value.allMessagesText, "utf8") > SESSION_SEARCH_TEXT_MAX_BYTES
	) {
		return undefined;
	}
	return {
		id: value.id,
		cwd: value.cwd,
		...(value.name === undefined ? {} : { name: value.name }),
		...(value.parentSessionPath === undefined ? {} : { parentSessionPath: value.parentSessionPath }),
		created: value.created,
		modified: value.modified,
		messageCount: value.messageCount,
		firstMessage: value.firstMessage,
		allMessagesText: value.allMessagesText,
	};
}

function parseIndex(content: string): Map<string, SessionMetadataIndexRecord> {
	const parsed = JSON.parse(content) as unknown;
	if (!isRecord(parsed) || parsed.version !== SESSION_METADATA_INDEX_VERSION || !isRecord(parsed.entries)) {
		throw new Error("Session metadata index has an unsupported schema");
	}
	const entries = Object.entries(parsed.entries);
	if (entries.length > SESSION_METADATA_INDEX_MAX_ENTRIES) {
		throw new Error("Session metadata index contains too many entries");
	}
	const records = new Map<string, SessionMetadataIndexRecord>();
	for (const [name, rawRecord] of entries) {
		if (!safeSessionBasename(name) || !isRecord(rawRecord)) continue;
		const identity = parseIdentity(rawRecord.identity);
		const metadata = parseMetadata(rawRecord.metadata);
		if (!identity || metadata === undefined) continue;
		records.set(name, { identity, metadata });
	}
	return records;
}

export function sessionFileIdentity(stats: {
	dev: number | bigint;
	ino: number | bigint;
	size: number | bigint;
	mtimeNs: bigint;
	ctimeNs: bigint;
}): SessionFileIdentity {
	return {
		device: String(stats.dev),
		inode: String(stats.ino),
		size: String(stats.size),
		mtimeNs: String(stats.mtimeNs),
		ctimeNs: String(stats.ctimeNs),
	};
}

export function sessionFileIdentityMatches(left: SessionFileIdentity, right: SessionFileIdentity): boolean {
	return (
		left.device === right.device &&
		left.inode === right.inode &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

export async function readSessionMetadataIndex(sessionDir: string): Promise<SessionMetadataIndexSnapshot> {
	const indexPath = join(sessionDir, SESSION_METADATA_INDEX_NAME);
	let content: string;
	try {
		if (!(await secureFileExists(indexPath))) return { records: new Map(), writable: true };
		const bytes = await secureReadFile(indexPath, { maxBytes: SESSION_METADATA_INDEX_MAX_BYTES });
		content = bytes.toString("utf8");
	} catch {
		// An unsafe index is never followed or replaced. Session files remain readable
		// through the slow path because this cache is entirely reproducible.
		return { records: new Map(), writable: false };
	}
	try {
		return { records: parseIndex(content), writable: true };
	} catch {
		return { records: new Map(), writable: true };
	}
}

function serializeIndex(records: ReadonlyMap<string, SessionMetadataIndexRecord>): string {
	const candidates = [...records.entries()]
		.filter(([name]) => safeSessionBasename(name))
		.sort((left, right) => {
			const byMtime = BigInt(right[1].identity.mtimeNs) - BigInt(left[1].identity.mtimeNs);
			return byMtime < 0n ? -1 : byMtime > 0n ? 1 : left[0].localeCompare(right[0]);
		});
	const prefix = `{"version":${SESSION_METADATA_INDEX_VERSION},"entries":{`;
	const suffix = "}}\n";
	let retainedCount = 0;
	let bytes = Buffer.byteLength(prefix) + Buffer.byteLength(suffix);
	const fragments: string[] = [];
	for (const [name, record] of candidates) {
		if (retainedCount >= SESSION_METADATA_INDEX_MAX_ENTRIES) break;
		const body = `${JSON.stringify(name)}:${JSON.stringify(record)}`;
		const fragment = fragments.length === 0 ? body : `,${body}`;
		const fragmentBytes = Buffer.byteLength(fragment);
		if (bytes + fragmentBytes > SESSION_METADATA_INDEX_MAX_BYTES) continue;
		fragments.push(fragment);
		bytes += fragmentBytes;
		retainedCount++;
	}
	return `${prefix}${fragments.join("")}${suffix}`;
}

export async function writeSessionMetadataIndex(
	sessionDir: string,
	records: ReadonlyMap<string, SessionMetadataIndexRecord>,
	writable: boolean,
): Promise<void> {
	if (!writable) return;
	const indexPath = join(sessionDir, SESSION_METADATA_INDEX_NAME);
	const content = serializeIndex(records);
	await withSecureFileLock(indexPath, async () => {
		let current: string | undefined;
		try {
			if (await secureFileExists(indexPath)) {
				const bytes = await secureReadFile(indexPath, { maxBytes: SESSION_METADATA_INDEX_MAX_BYTES });
				current = bytes.toString("utf8");
			}
		} catch {
			return;
		}
		if (current === content) return;
		await secureAtomicWriteFile(indexPath, content, { maxBytes: SESSION_METADATA_INDEX_MAX_BYTES });
	});
}
