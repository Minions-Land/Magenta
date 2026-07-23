import { spawn } from "node:child_process";
import { lstat, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupStaleWakeSockets } from "../../tools/send-message/magenta/wake-socket-gc.ts";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
	// Unix socket pathname limits are much shorter than ordinary filesystem
	// paths; keep the fixture root deliberately compact.
	const root = await mkdtemp("/tmp/mw-");
	roots.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createSocketProcess(path: string): Promise<ReturnType<typeof spawn>> {
	const child = spawn(
		process.execPath,
		["-e", `require("node:net").createServer().listen(process.argv[1],()=>console.log("ready"));`, path],
		{
			stdio: ["ignore", "pipe", "ignore"],
		},
	);
	await new Promise<void>((resolve, reject) => {
		child.stdout?.once("data", (chunk) =>
			chunk.toString().includes("ready") ? resolve() : reject(new Error("socket child did not start")),
		);
		child.once("error", reject);
	});
	return child;
}

async function killSocketProcess(child: ReturnType<typeof spawn>): Promise<void> {
	await new Promise<void>((resolve) => {
		child.once("exit", () => resolve());
		child.kill("SIGKILL");
	});
}

describe("stale wake socket cleanup", () => {
	it("removes a dead, refused, old socket and preserves live or uncertain paths", async () => {
		if (process.platform === "win32" || typeof process.getuid !== "function") return;
		const root = await makeRoot();
		const stalePath = join(root, "magenta-wake-2147483646-0123456789abcdef0123.sock");
		const staleChild = await createSocketProcess(stalePath);
		await killSocketProcess(staleChild);
		const old = new Date(1);
		await utimes(stalePath, old, old);

		const livePath = join(root, `magenta-wake-${process.pid}-0123456789abcdef0124.sock`);
		const liveChild = await createSocketProcess(livePath);
		await utimes(livePath, old, old);

		const regular = join(root, "magenta-wake-2147483646-0123456789abcdef0125.sock");
		await writeFile(regular, "regular");

		const result = await cleanupStaleWakeSockets({
			tempRoot: root,
			maxAgeMs: 0,
			probeTimeoutMs: 100,
			now: Date.now(),
		});
		expect(result.deletedSockets).toBe(1);
		await expect(lstat(stalePath)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(lstat(livePath)).resolves.toBeTruthy();
		await expect(readFile(regular, "utf8")).resolves.toBe("regular");

		await killSocketProcess(liveChild);
	});

	it("bounds each maintenance pass", async () => {
		if (process.platform === "win32" || typeof process.getuid !== "function") return;
		const root = await makeRoot();
		const stalePath = join(root, "magenta-wake-2147483646-0123456789abcdef0126.sock");
		const staleChild = await createSocketProcess(stalePath);
		await killSocketProcess(staleChild);
		await utimes(stalePath, new Date(1), new Date(1));

		const result = await cleanupStaleWakeSockets({
			tempRoot: root,
			maxAgeMs: 0,
			maxScannedSockets: 0,
			maxDeletedSockets: 0,
			now: Date.now(),
		});
		expect(result).toEqual({ scannedSockets: 0, deletedSockets: 0 });
		await expect(lstat(stalePath)).resolves.toBeTruthy();
	});
});
