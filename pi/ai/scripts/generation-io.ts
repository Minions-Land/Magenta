import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type GenerationFetchOptions = {
	label: string;
	url: string;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
};

/** Fetch one required catalog. Network, HTTP, and JSON failures are fatal. */
export async function fetchRequiredJson<T>(options: GenerationFetchOptions): Promise<T> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const timeoutMs = options.timeoutMs ?? 30_000;
	let response: Response;
	try {
		response = await fetchImpl(options.url, { signal: AbortSignal.timeout(timeoutMs) });
	} catch (error) {
		throw new Error(`Failed to fetch required ${options.label} catalog: ${error instanceof Error ? error.message : String(error)}`, {
			cause: error,
		});
	}
	if (!response.ok) {
		throw new Error(`Failed to fetch required ${options.label} catalog: HTTP ${response.status}`);
	}
	try {
		return (await response.json()) as T;
	} catch (error) {
		throw new Error(`Required ${options.label} catalog returned invalid JSON`, { cause: error });
	}
}

/** Refuse unexpectedly tiny remote catalogs before any generated file is staged. */
export function assertMinimumCatalogSize(label: string, actual: number, minimum: number): void {
	if (!Number.isInteger(actual) || actual < minimum) {
		throw new Error(`Required ${label} catalog is incomplete: received ${actual}, minimum is ${minimum}`);
	}
}

export type AtomicGeneratedFile = {
	path: string;
	content: string;
};

/**
 * Stage every output beside its destination, then replace each destination with
 * an atomic same-directory rename only after all staging writes succeed. A
 * fetch/serialization/staging failure therefore leaves the previous set intact.
 * Callers order dependency files first and aggregators last, so even a rare
 * commit-phase filesystem failure cannot publish an aggregator that references
 * files which were never staged.
 */
export function writeGeneratedFilesAtomically(files: readonly AtomicGeneratedFile[]): void {
	const seen = new Set<string>();
	const staged: Array<{ path: string; temporaryPath: string }> = [];
	try {
		for (const file of files) {
			if (seen.has(file.path)) throw new Error(`Duplicate generated output path: ${file.path}`);
			seen.add(file.path);
			mkdirSync(dirname(file.path), { recursive: true });
			const temporaryPath = `${file.path}.tmp-${process.pid}-${randomUUID()}`;
			staged.push({ path: file.path, temporaryPath });
			writeFileSync(temporaryPath, file.content, { encoding: "utf8", flag: "wx", flush: true });
		}
		for (const file of staged) renameSync(file.temporaryPath, file.path);
	} finally {
		for (const file of staged) rmSync(file.temporaryPath, { force: true });
	}
}
