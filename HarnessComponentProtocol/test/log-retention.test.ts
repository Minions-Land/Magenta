import { mkdir, mkdtemp, readFile, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	appendBoundedFileSync,
	BufferedBoundedLog,
	cleanupLogTree,
	createBoundedLogState,
	DEFAULT_LOG_FLUSH_BYTES,
	DEFAULT_LOG_FLUSH_INTERVAL_MS,
	LOG_TRUNCATION_MARKER,
	writeBoundedLog,
} from "../_magenta/log-retention.ts";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "magenta-log-retention-"));
	roots.push(root);
	return root;
}

afterEach(async () => {
	for (const root of roots.splice(0)) {
		await rm(root, { recursive: true, force: true });
	}
});

describe("bounded diagnostic logs", () => {
	it("batches small chunks until the 64 KiB or 100 ms boundary", async () => {
		vi.useFakeTimers();
		try {
			const timedStream = new PassThrough();
			const timedChunks: Buffer[] = [];
			timedStream.on("data", (chunk: Buffer) => timedChunks.push(Buffer.from(chunk)));
			const timedLog = new BufferedBoundedLog(timedStream);
			timedLog.write("first");
			timedLog.write("-second");
			expect(timedChunks).toHaveLength(0);
			await vi.advanceTimersByTimeAsync(DEFAULT_LOG_FLUSH_INTERVAL_MS - 1);
			expect(timedChunks).toHaveLength(0);
			await vi.advanceTimersByTimeAsync(1);
			expect(timedChunks).toHaveLength(1);
			expect(Buffer.concat(timedChunks).toString("utf8")).toBe("first-second");

			const thresholdStream = new PassThrough();
			const thresholdChunks: Buffer[] = [];
			thresholdStream.on("data", (chunk: Buffer) => thresholdChunks.push(Buffer.from(chunk)));
			const thresholdLog = new BufferedBoundedLog(thresholdStream);
			thresholdLog.write(Buffer.alloc(DEFAULT_LOG_FLUSH_BYTES / 2, 0x61));
			expect(thresholdChunks).toHaveLength(0);
			thresholdLog.write(Buffer.alloc(DEFAULT_LOG_FLUSH_BYTES / 2, 0x62));
			expect(thresholdChunks).toHaveLength(1);
			expect(Buffer.concat(thresholdChunks)).toHaveLength(DEFAULT_LOG_FLUSH_BYTES);
			timedLog.end();
			thresholdLog.end();
		} finally {
			vi.useRealTimers();
		}
	});

	it("flushes a terminal tail exactly once while preserving the hard cap", async () => {
		const stream = new PassThrough();
		const chunks: Buffer[] = [];
		stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
		const log = new BufferedBoundedLog(stream, { maxBytes: 64 });
		log.write("terminal-tail");
		expect(chunks).toHaveLength(0);
		log.end();
		log.end();
		log.write("ignored");
		await new Promise<void>((resolve) => stream.once("end", resolve));
		expect(Buffer.concat(chunks).toString("utf8")).toBe("terminal-tail");

		const cappedStream = new PassThrough();
		const cappedChunks: Buffer[] = [];
		cappedStream.on("data", (chunk: Buffer) => cappedChunks.push(Buffer.from(chunk)));
		const cappedLog = new BufferedBoundedLog(cappedStream, { maxBytes: 8 });
		cappedLog.write("more than eight bytes");
		cappedLog.write("ignored after truncation");
		cappedLog.end();
		await new Promise<void>((resolve) => cappedStream.once("end", resolve));
		expect(Buffer.concat(cappedChunks)).toHaveLength(8);
	});

	it("never writes beyond the per-file cap and emits one truncation marker", async () => {
		const stream = new PassThrough();
		const chunks: Buffer[] = [];
		stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
		const state = createBoundedLogState();

		writeBoundedLog(stream, state, "a".repeat(20), 32);
		writeBoundedLog(stream, state, "b".repeat(40), 32);
		writeBoundedLog(stream, state, "c".repeat(40), 32);
		stream.end();
		await new Promise<void>((resolve) => stream.once("end", resolve));

		const output = Buffer.concat(chunks).toString("utf8");
		expect(state.truncated).toBe(true);
		expect(state.bytes).toBeLessThanOrEqual(32);
		expect(Buffer.byteLength(output)).toBeLessThanOrEqual(32);
		expect(output).toContain(LOG_TRUNCATION_MARKER.slice(0, 8));
	});

	it("caps synchronous audit-file appends by UTF-8 bytes", async () => {
		const root = await makeRoot();
		const path = join(root, "workflow.jsonl");
		appendBoundedFileSync(path, "a".repeat(20), 32);
		const truncated = appendBoundedFileSync(path, "界".repeat(20), 32);
		const ignored = appendBoundedFileSync(path, "later", 32);
		const output = await readFile(path);

		expect(truncated.truncated).toBe(true);
		expect(ignored.bytesWritten).toBe(0);
		expect(output.byteLength).toBe(32);
		expect(output.toString("utf8")).toContain(LOG_TRUNCATION_MARKER.slice(0, 8));
	});
});

describe("log cleanup", () => {
	it("deletes only selected old logs, preserves protected logs, and does not follow symlinks", async () => {
		const root = await makeRoot();
		const nested = join(root, "session");
		await mkdir(nested);
		const oldLog = join(nested, "old.rpc.log");
		const protectedLog = join(nested, "live.rpc.log");
		const unknown = join(nested, "keep.txt");
		const outsideRoot = await mkdtemp(join(tmpdir(), "magenta-log-outside-"));
		roots.push(outsideRoot);
		const outside = join(outsideRoot, "outside.rpc.log");
		await writeFile(oldLog, "old");
		await writeFile(protectedLog, "live");
		await writeFile(unknown, "unknown");
		await writeFile(outside, "outside");
		const outsidePath = await realpath(outsideRoot);
		const link = join(root, "linked");
		await symlink(outsidePath, link, "dir");
		const old = new Date(0);
		await utimes(oldLog, old, old);
		await utimes(protectedLog, old, old);

		const result = await cleanupLogTree({
			root,
			fileFilter: (path) => path.endsWith(".rpc.log"),
			protectedPaths: [protectedLog],
			maxAgeMs: 1,
			now: Date.now(),
		});

		expect(result.deletedFiles).toBe(1);
		await expect(readFile(oldLog)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(protectedLog, "utf8")).toBe("live");
		expect(await readFile(unknown, "utf8")).toBe("unknown");
		expect(await readFile(outside, "utf8")).toBe("outside");
		expect(await readFile(join(link, "outside.rpc.log"), "utf8")).toBe("outside");
	});

	it("removes oldest logs until the namespace total and file count are bounded", async () => {
		const root = await makeRoot();
		for (const [index, name] of ["a.log", "b.log", "c.log"].entries()) {
			const path = join(root, name);
			await writeFile(path, String(index).repeat(10));
			const stamp = new Date(index * 1000);
			await utimes(path, stamp, stamp);
		}

		const result = await cleanupLogTree({
			root,
			fileFilter: (path) => path.endsWith(".log"),
			maxAgeMs: Number.MAX_SAFE_INTEGER,
			maxTotalBytes: 10,
			maxFiles: 1,
			now: Date.now(),
		});

		expect(result.deletedFiles).toBe(2);
		await expect(readFile(join(root, "a.log"))).rejects.toMatchObject({ code: "ENOENT" });
		await expect(readFile(join(root, "b.log"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(join(root, "c.log"), "utf8")).toBe("2222222222");
	});

	it("removes only approved empty directories after known artifacts are deleted", async () => {
		const root = await makeRoot();
		const removable = join(root, "known", "nested");
		const unknown = join(root, "unknown");
		const protectedDirectory = join(root, "known", "live");
		await mkdir(removable, { recursive: true });
		await mkdir(unknown);
		await mkdir(protectedDirectory);
		const artifact = join(removable, "old.log");
		await writeFile(artifact, "old");
		const old = new Date(0);
		await utimes(artifact, old, old);

		const result = await cleanupLogTree({
			root,
			fileFilter: (path) => path.endsWith(".log"),
			protectedPrefixes: [protectedDirectory],
			emptyDirectoryFilter: (path) => path.startsWith(join(root, "known")),
			maxAgeMs: 1,
			now: Date.now(),
		});

		expect(result.deletedFiles).toBe(1);
		expect(result.deletedDirectories).toBe(1);
		await expect(readFile(artifact)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(realpath(removable)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await realpath(unknown)).toBe(
			await realpath(root).then((canonicalRoot) => join(canonicalRoot, "unknown")),
		);
		expect(await realpath(protectedDirectory)).toBe(
			await realpath(root).then((canonicalRoot) => join(canonicalRoot, "known", "live")),
		);
	});
});
