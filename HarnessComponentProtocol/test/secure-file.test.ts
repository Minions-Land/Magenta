import {
	chmodSync,
	linkSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	secureAppendFileSync,
	secureAtomicReplaceFileSync,
	secureAtomicWriteFile,
	secureAtomicWriteFileSync,
	secureReadFile,
	secureReadFileSync,
	withSecureFileLock,
} from "../_magenta/utils/secure-file.ts";

const roots: string[] = [];

async function fixture(): Promise<{ root: string; path: string }> {
	const root = await mkdtemp(join(tmpdir(), "magenta-secure-file-"));
	roots.push(root);
	return { root, path: join(root, "state.json") };
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("secure state files", () => {
	it("publishes complete private bytes and leaves no temporary file", async () => {
		const { root, path } = await fixture();
		await secureAtomicWriteFile(path, "complete\n");

		await expect(readFile(path, "utf8")).resolves.toBe("complete\n");
		expect(lstatSync(path).mode & 0o777).toBe(0o600);
		expect(readdirSync(root)).toEqual(["state.json"]);
		await expect(secureReadFile(path, { maxBytes: 1024 })).resolves.toEqual(Buffer.from("complete\n"));
		expect(secureReadFileSync(path, { maxBytes: 1024 })).toEqual(Buffer.from("complete\n"));
	});

	it("appends through the verified file descriptor", async () => {
		const { path } = await fixture();
		secureAtomicWriteFileSync(path, "first\n");
		secureAppendFileSync(path, "second\n");

		expect(secureReadFileSync(path, { maxBytes: 1024 }).toString("utf8")).toBe("first\nsecond\n");
		expect(lstatSync(path).mode & 0o777).toBe(0o600);
	});

	it("enforces sync and async byte limits before retaining oversized state", async () => {
		const { path } = await fixture();
		secureAtomicWriteFileSync(path, "12345");

		expect(secureReadFileSync(path, { maxBytes: 5 }).toString("utf8")).toBe("12345");
		await expect(secureReadFile(path, { maxBytes: 5 })).resolves.toEqual(Buffer.from("12345"));
		expect(() => secureReadFileSync(path, { maxBytes: 4 })).toThrow(/secure read limit/u);
		await expect(secureReadFile(path, { maxBytes: 4 })).rejects.toThrow(/secure read limit/u);
	});

	it("rejects invalid byte limits", async () => {
		const { path } = await fixture();
		secureAtomicWriteFileSync(path, "state");

		expect(() => secureReadFileSync(path, { maxBytes: -1 })).toThrow(RangeError);
		await expect(secureReadFile(path, { maxBytes: Number.NaN })).rejects.toThrow(RangeError);
	});

	it("refuses to publish content above a write limit", async () => {
		const { root, path } = await fixture();

		expect(() => secureAtomicWriteFileSync(path, "12345", { maxBytes: 4 })).toThrow(/secure write limit/u);
		await expect(secureAtomicWriteFile(path, "12345", { maxBytes: 4 })).rejects.toThrow(/secure write limit/u);
		expect(readdirSync(root)).toEqual([]);
	});

	it("preserves the previous bytes when a replacement writer fails", async () => {
		const { root, path } = await fixture();
		secureAtomicWriteFileSync(path, "old\n");

		expect(() =>
			secureAtomicReplaceFileSync(path, (fd) => {
				writeFileSync(fd, "partial");
				throw new Error("injected write failure");
			}),
		).toThrow(/injected write failure/u);
		expect(readFileSync(path, "utf8")).toBe("old\n");
		expect(readdirSync(root)).toEqual(["state.json"]);
	});

	it("refuses symbolic links, hard links, and read-only targets", async () => {
		const linked = await fixture();
		const outside = join(linked.root, "outside");
		writeFileSync(outside, "outside");
		symlinkSync(outside, linked.path);
		expect(() => secureAtomicWriteFileSync(linked.path, "replace")).toThrow(/plain file/u);
		expect(() => secureReadFileSync(linked.path, { maxBytes: 1024 })).toThrow(/plain file/u);
		expect(() => secureAppendFileSync(linked.path, "append")).toThrow(/plain file/u);
		expect(readFileSync(outside, "utf8")).toBe("outside");

		const hardLinked = await fixture();
		writeFileSync(hardLinked.path, "shared");
		linkSync(hardLinked.path, join(hardLinked.root, "alias"));
		expect(() => secureAtomicWriteFileSync(hardLinked.path, "replace")).toThrow(/hard links/u);
		expect(() => secureReadFileSync(hardLinked.path, { maxBytes: 1024 })).toThrow(/hard links/u);
		expect(() => secureAppendFileSync(hardLinked.path, "append")).toThrow(/hard links/u);

		if (process.platform !== "win32") {
			const readOnly = await fixture();
			writeFileSync(readOnly.path, "keep");
			chmodSync(readOnly.path, 0o400);
			expect(secureReadFileSync(readOnly.path, { maxBytes: 1024 }).toString("utf8")).toBe("keep");
			expect(() => secureAtomicWriteFileSync(readOnly.path, "replace")).toThrow(/owner-writable/u);
			expect(() => secureAppendFileSync(readOnly.path, "append")).toThrow(/owner-writable/u);
			chmodSync(readOnly.path, 0o600);
		}
	});

	it("serializes asynchronous read-modify-write operations", async () => {
		const { path } = await fixture();
		mkdirSync(join(path, ".."), { recursive: true });
		await secureAtomicWriteFile(path, "0");
		await Promise.all(
			Array.from({ length: 8 }, () =>
				withSecureFileLock(path, async () => {
					const current = Number(await readFile(path, "utf8"));
					await new Promise((resolve) => setTimeout(resolve, 2));
					await secureAtomicWriteFile(path, String(current + 1));
				}),
			),
		);
		expect(await readFile(path, "utf8")).toBe("8");
	});
});
