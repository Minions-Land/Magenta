import { existsSync, lstatSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	BASH_FULL_OUTPUT_MAX_BYTES,
	cleanupBashFullOutputFiles,
	executeBashWithOperations,
} from "../src/core/bash-executor.ts";

const roots: string[] = [];

function makeRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "magenta-bash-output-retention-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("bash full-output retention", () => {
	it.skipIf(process.platform === "win32")("removes expired files but protects output owned by a live process", () => {
		const root = makeRoot();
		const legacy = join(root, "pi-bash-aaaaaaaaaaaaaaaa.log");
		const dead = join(root, "pi-bash-2147483646-bbbbbbbbbbbbbbbb.log");
		const live = join(root, `pi-bash-${process.ppid}-cccccccccccccccc.log`);
		const unknown = join(root, "keep.log");
		const link = join(root, "pi-bash-dddddddddddddddd.log");
		for (const path of [legacy, dead, live, unknown]) writeFileSync(path, "payload");
		symlinkSync(unknown, link);
		const old = new Date(0);
		for (const path of [legacy, dead, live, unknown]) utimesSync(path, old, old);

		const result = cleanupBashFullOutputFiles(root, {
			maxAgeMs: 1,
			maxFiles: 100,
			maxTotalBytes: 1024,
			now: Date.now(),
		});

		expect(result.deletedFiles).toBe(2);
		expect(existsSync(legacy)).toBe(false);
		expect(existsSync(dead)).toBe(false);
		expect(existsSync(live)).toBe(true);
		expect(existsSync(unknown)).toBe(true);
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
	});

	it("enforces file-count and total-byte budgets oldest first", () => {
		const root = makeRoot();
		for (let index = 0; index < 4; index++) {
			const path = join(root, `pi-bash-${String(index).repeat(16)}.log`);
			writeFileSync(path, "12345678");
			const timestamp = new Date(10_000 + index * 1_000);
			utimesSync(path, timestamp, timestamp);
		}

		const result = cleanupBashFullOutputFiles(root, {
			maxAgeMs: Number.MAX_SAFE_INTEGER,
			maxFiles: 2,
			maxTotalBytes: 16,
			now: 20_000,
		});

		expect(result).toEqual({ deletedFiles: 2, deletedBytes: 16 });
		expect(existsSync(join(root, "pi-bash-0000000000000000.log"))).toBe(false);
		expect(existsSync(join(root, "pi-bash-1111111111111111.log"))).toBe(false);
		expect(existsSync(join(root, "pi-bash-2222222222222222.log"))).toBe(true);
		expect(existsSync(join(root, "pi-bash-3333333333333333.log"))).toBe(true);
	});

	it.skipIf(process.platform === "win32")("creates private PID-qualified full-output files", async () => {
		const result = await executeBashWithOperations("chatty", process.cwd(), {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.from("x".repeat(60 * 1024), "utf8"));
				return { exitCode: 0 };
			},
		});
		expect(result.fullOutputPath).toMatch(new RegExp(`pi-bash-${process.pid}-[a-f0-9]{16}\\.log$`));
		if (!result.fullOutputPath) throw new Error("missing full output path");
		for (let index = 0; index < 20 && !existsSync(result.fullOutputPath); index++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(lstatSync(result.fullOutputPath).mode & 0o777).toBe(0o600);
		rmSync(result.fullOutputPath, { force: true });
	});

	it("hard-caps one live full-output file", async () => {
		const result = await executeBashWithOperations("very-chatty", process.cwd(), {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.alloc(BASH_FULL_OUTPUT_MAX_BYTES + 4096, 0x78));
				return { exitCode: 0 };
			},
		});
		if (!result.fullOutputPath) throw new Error("missing full output path");
		for (let index = 0; index < 50; index++) {
			try {
				if (lstatSync(result.fullOutputPath).size === BASH_FULL_OUTPUT_MAX_BYTES) break;
			} catch {}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(lstatSync(result.fullOutputPath).size).toBe(BASH_FULL_OUTPUT_MAX_BYTES);
		rmSync(result.fullOutputPath, { force: true });
	});
});
