import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getProcessStartIdentity } from "../_magenta/process-instance.ts";
import { materializeContentAddressedExecutable } from "../_magenta/utils/pi/atomic-executable.ts";
import {
	cleanupContentAddressedHelperCache,
	getRegisteredHelperLeaseCacheForTests,
	MAX_REGISTERED_HELPER_LEASES,
	materializeLeasedContentAddressedExecutable,
} from "../_magenta/utils/pi/helper-cache-maintenance.ts";

describe("content-addressed helper cache maintenance", () => {
	let root: string | undefined;
	let child: ChildProcess | undefined;

	afterEach(async () => {
		vi.useRealTimers();
		if (child && child.exitCode === null && child.signalCode === null) {
			child.kill();
			await new Promise<void>((resolve) => child?.once("exit", () => resolve()));
		}
		child = undefined;
		if (root) rmSync(root, { force: true, recursive: true });
		root = undefined;
	});

	function fixture(tool = "fd"): { cacheDirectory: string; trustedRoot: string } {
		root = mkdtempSync(join(tmpdir(), "magenta-helper-cache-maintenance-"));
		return { cacheDirectory: join(root, "cache", tool), trustedRoot: root };
	}

	function materialize(
		fixture: { cacheDirectory: string; trustedRoot: string },
		content: string,
		processInstance: { pid: number; processStartId: string | null },
		createdAt: number,
	): string {
		return materializeLeasedContentAddressedExecutable({
			...fixture,
			content: Buffer.from(content),
			executableName: "fd",
			testNowMs: createdAt,
			testProcessInstance: processInstance,
			testScheduleCleanup: false,
		});
	}

	it("registers once and makes repeated lookup a read-only fast path", () => {
		const fx = fixture();
		const options = {
			...fx,
			content: Buffer.from("one helper generation\n"),
			executableName: "fd",
			testNowMs: 100,
			testProcessInstance: { pid: 101, processStartId: "start-101" },
			testScheduleCleanup: false,
		} as const;
		const executable = materializeLeasedContentAddressedExecutable(options);
		const leaseDirectory = join(dirname(executable), ".magenta-leases");
		const leasePath = join(leaseDirectory, readdirSync(leaseDirectory)[0]);
		const executableBefore = statSync(executable, { bigint: true });
		const leaseBefore = statSync(leasePath, { bigint: true });

		expect(materializeLeasedContentAddressedExecutable({ ...options, testNowMs: 200 })).toBe(executable);
		const executableAfter = statSync(executable, { bigint: true });
		const leaseAfter = statSync(leasePath, { bigint: true });
		expect(executableAfter.ino).toBe(executableBefore.ino);
		expect(executableAfter.mtimeNs).toBe(executableBefore.mtimeNs);
		expect(leaseAfter.ino).toBe(leaseBefore.ino);
		expect(leaseAfter.mtimeNs).toBe(leaseBefore.mtimeNs);
		expect(existsSync(join(fx.cacheDirectory, ".magenta-helper-cache.lock"))).toBe(false);
	});

	it("schedules another bounded cleanup pass after the first one completes", async () => {
		if (typeof process.getuid !== "function") return;
		const fx = fixture();
		vi.useFakeTimers();
		const countGenerations = () =>
			readdirSync(fx.cacheDirectory).filter((name) => /^[0-9a-f]{64}$/u.test(name)).length;
		for (let generation = 0; generation < 4; generation++) {
			materialize(
				fx,
				`scheduled helper generation ${generation}\n`,
				{
					pid: 2_147_483_646,
					processStartId: `scheduled-dead-${generation}`,
				},
				0,
			);
		}

		materializeLeasedContentAddressedExecutable({
			...fx,
			content: Buffer.from("scheduled helper generation 4\n"),
			executableName: "fd",
			testNowMs: 0,
			testProcessInstance: { pid: 2_147_483_646, processStartId: "scheduled-dead-4" },
		});
		await vi.runAllTimersAsync();
		vi.useRealTimers();
		await vi.waitFor(() => expect(countGenerations()).toBe(3), { timeout: 2_000, interval: 10 });

		materializeLeasedContentAddressedExecutable({
			...fx,
			content: Buffer.from("scheduled helper generation 5\n"),
			executableName: "fd",
			testNowMs: 0,
			testProcessInstance: { pid: 2_147_483_646, processStartId: "scheduled-dead-5" },
		});
		await vi.waitFor(() => expect(countGenerations()).toBe(2), { timeout: 2_000, interval: 10 });
	});

	it("coalesces materialization races into one bounded follow-up cleanup", async () => {
		if (typeof process.getuid !== "function") return;
		const fx = fixture();
		vi.useFakeTimers();
		const countGenerations = () =>
			readdirSync(fx.cacheDirectory).filter((name) => /^[0-9a-f]{64}$/u.test(name)).length;
		for (let generation = 0; generation < 4; generation++) {
			materialize(
				fx,
				`racing helper generation ${generation}\n`,
				{
					pid: 2_147_483_646,
					processStartId: `racing-dead-${generation}`,
				},
				0,
			);
		}

		// The first scheduled timer is still pending while another generation is
		// published. That second publication must dirty the existing task rather
		// than enqueue an unbounded chain of overlapping timers.
		materializeLeasedContentAddressedExecutable({
			...fx,
			content: Buffer.from("racing helper generation 5\n"),
			executableName: "fd",
			testNowMs: 0,
			testProcessInstance: { pid: 2_147_483_646, processStartId: "racing-dead-5" },
		});
		materializeLeasedContentAddressedExecutable({
			...fx,
			content: Buffer.from("racing helper generation 6\n"),
			executableName: "fd",
			testNowMs: 0,
			testProcessInstance: { pid: 2_147_483_646, processStartId: "racing-dead-6" },
		});
		await vi.runOnlyPendingTimersAsync();
		vi.useRealTimers();
		await vi.waitFor(() => expect(countGenerations()).toBe(2), { timeout: 2_000, interval: 10 });
		// No further materialization means the dirty bit is consumed exactly once.
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(countGenerations()).toBe(2);
	});

	it("bounds the in-memory lease index with least-recently-used eviction", () => {
		if (typeof process.getuid !== "function") return;
		const fx = fixture();
		const contents = Array.from(
			{ length: MAX_REGISTERED_HELPER_LEASES + 1 },
			(_, index) => `lru helper generation ${index}\n`,
		);
		const keyFor = (content: string) =>
			`${resolve(fx.cacheDirectory)}\u0000${createHash("sha256").update(content).digest("hex")}\u0000fd`;
		for (const [index, content] of contents.entries()) {
			materialize(fx, content, { pid: 2_147_483_646, processStartId: `lru-${index}` }, index);
		}

		let keys = getRegisteredHelperLeaseCacheForTests().filter((key) =>
			key.startsWith(`${resolve(fx.cacheDirectory)}\u0000`),
		);
		expect(keys).toHaveLength(MAX_REGISTERED_HELPER_LEASES);
		expect(keys).not.toContain(keyFor(contents[0]));
		expect(keys).toContain(keyFor(contents[1]));

		// Touch the oldest retained entry, then add one more generation. The
		// untouched next-oldest entry should be evicted instead.
		materialize(fx, contents[1], { pid: 2_147_483_646, processStartId: "lru-1" }, 100);
		materialize(fx, "lru helper generation tail\n", { pid: 2_147_483_646, processStartId: "lru-tail" }, 101);
		keys = getRegisteredHelperLeaseCacheForTests().filter((key) =>
			key.startsWith(`${resolve(fx.cacheDirectory)}\u0000`),
		);
		expect(keys).toHaveLength(MAX_REGISTERED_HELPER_LEASES);
		expect(keys).toContain(keyFor(contents[1]));
		expect(keys).not.toContain(keyFor(contents[2]));
	});

	it("prunes an evicted generation's in-memory lease after disk deletion", async () => {
		if (typeof process.getuid !== "function") return;
		const fx = fixture();
		const content = "prunable helper generation\n";
		materialize(fx, content, { pid: 2_147_483_646, processStartId: "prunable-dead" }, 0);
		const key = `${resolve(fx.cacheDirectory)}\u0000${createHash("sha256").update(content).digest("hex")}\u0000fd`;
		expect(getRegisteredHelperLeaseCacheForTests()).toContain(key);

		const result = await cleanupContentAddressedHelperCache({
			...fx,
			maxGenerations: 0,
			maxUnusedAgeMs: 0,
			maxDeletions: 1,
			nowMs: 1,
			testProcessInstanceStatus: () => "dead",
		});
		expect(result.deletedGenerations).toBe(1);
		expect(getRegisteredHelperLeaseCacheForTests()).not.toContain(key);
	});

	it("retains a generation for an exact live process instance until that process exits", async () => {
		if (typeof process.getuid !== "function") return;
		const fx = fixture();
		child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
		if (!child.pid) throw new Error("test child did not expose a PID");
		let processStartId: string | null = null;
		for (let attempt = 0; attempt < 40 && !processStartId; attempt++) {
			processStartId = getProcessStartIdentity(child.pid);
			if (!processStartId) await new Promise((resolve) => setTimeout(resolve, 25));
		}
		expect(processStartId).not.toBeNull();
		const executable = materialize(fx, "live helper generation\n", { pid: child.pid, processStartId }, 0);

		const whileAlive = await cleanupContentAddressedHelperCache({
			...fx,
			maxDeletions: 4,
			maxGenerations: 0,
			maxUnusedAgeMs: 0,
			nowMs: 10,
		});
		expect(whileAlive.protectedGenerations).toBe(1);
		expect(whileAlive.deletedGenerations).toBe(0);
		expect(existsSync(executable)).toBe(true);

		child.kill();
		await new Promise<void>((resolve) => child?.once("exit", () => resolve()));
		const afterExit = await cleanupContentAddressedHelperCache({
			...fx,
			maxDeletions: 4,
			maxGenerations: 0,
			maxUnusedAgeMs: 0,
			nowMs: 10,
		});
		expect(afterExit.deletedGenerations).toBe(1);
		expect(existsSync(executable)).toBe(false);
	});

	it("rejects PID reuse while retaining an unprobeable process identity", async () => {
		if (typeof process.getuid !== "function") return;
		const fx = fixture();
		const reused = materialize(fx, "reused pid generation\n", { pid: 202, processStartId: "old-start" }, 0);
		const unknown = materialize(fx, "unknown pid generation\n", { pid: 303, processStartId: null }, 1);

		const result = await cleanupContentAddressedHelperCache({
			...fx,
			maxDeletions: 4,
			maxGenerations: 0,
			maxUnusedAgeMs: 0,
			nowMs: 10,
			testProcessInstanceStatus: (_pid, startId) => (startId === "old-start" ? "dead" : "unknown"),
		});

		expect(result.protectedGenerations).toBe(1);
		expect(result.deletedGenerations).toBe(1);
		expect(existsSync(reused)).toBe(false);
		expect(existsSync(unknown)).toBe(true);
	});

	it("bounds each pass while converging to the configured generation count", async () => {
		if (typeof process.getuid !== "function") return;
		const fx = fixture();
		for (let generation = 0; generation < 5; generation++) {
			materialize(
				fx,
				`bounded helper generation ${generation}\n`,
				{ pid: 400 + generation, processStartId: `dead-${generation}` },
				generation,
			);
		}
		const options = {
			...fx,
			maxDeletions: 2,
			maxGenerations: 1,
			maxUnusedAgeMs: 1_000_000,
			nowMs: 10,
			testProcessInstanceStatus: () => "dead" as const,
		};

		const first = await cleanupContentAddressedHelperCache(options);
		expect(first.deletedGenerations).toBe(2);
		expect(readdirSync(fx.cacheDirectory).filter((name) => /^[0-9a-f]{64}$/u.test(name))).toHaveLength(3);
		const second = await cleanupContentAddressedHelperCache(options);
		expect(second.deletedGenerations).toBe(2);
		expect(readdirSync(fx.cacheDirectory).filter((name) => /^[0-9a-f]{64}$/u.test(name))).toHaveLength(1);
	});

	it("inspects and reclaims helper executables larger than the metadata ceiling", async () => {
		if (typeof process.getuid !== "function") return;
		const fx = fixture("process-tools");
		const content = Buffer.alloc(9 * 1024 * 1024, 0x5a);
		const executable = materializeLeasedContentAddressedExecutable({
			...fx,
			content,
			executableName: "magenta-process-tools",
			testNowMs: 0,
			testProcessInstance: { pid: 450, processStartId: "dead-large-helper" },
			testScheduleCleanup: false,
		});

		const result = await cleanupContentAddressedHelperCache({
			...fx,
			maxDeletions: 1,
			maxGenerations: 0,
			maxUnusedAgeMs: 0,
			nowMs: 10,
			testProcessInstanceStatus: () => "dead",
		});
		expect(result.managedGenerations).toBe(1);
		expect(result.deletedGenerations).toBe(1);
		expect(result.deletedBytes).toBeGreaterThanOrEqual(content.byteLength);
		expect(existsSync(executable)).toBe(false);
	});

	it("never adopts an unmarked legacy content-addressed directory", async () => {
		if (typeof process.getuid !== "function") return;
		const fx = fixture();
		const content = Buffer.from("legacy generation\n");
		const legacy = materializeContentAddressedExecutable({
			...fx,
			content,
			executableName: "fd",
		});
		expect(materialize(fx, content.toString("utf8"), { pid: 501, processStartId: "dead" }, 0)).toBe(legacy);

		const result = await cleanupContentAddressedHelperCache({
			...fx,
			maxDeletions: 4,
			maxGenerations: 0,
			maxUnusedAgeMs: 0,
			nowMs: 10,
			testProcessInstanceStatus: () => "dead",
		});
		expect(result.managedGenerations).toBe(0);
		expect(existsSync(legacy)).toBe(true);
		expect(readdirSync(dirname(legacy))).toEqual(["fd"]);
	});

	it("preserves hard-linked generations and does not unlink the external name", async () => {
		if (typeof process.getuid !== "function") return;
		const fx = fixture();
		const executable = materialize(fx, "hard-linked generation\n", { pid: 601, processStartId: "dead" }, 0);
		const externalLink = join(root!, "external-helper-link");
		linkSync(executable, externalLink);

		const result = await cleanupContentAddressedHelperCache({
			...fx,
			maxDeletions: 4,
			maxGenerations: 0,
			maxUnusedAgeMs: 0,
			nowMs: 10,
			testProcessInstanceStatus: () => "dead",
		});
		expect(result.deletedGenerations).toBe(0);
		expect(readFileSync(externalLink, "utf8")).toBe("hard-linked generation\n");
		expect(existsSync(executable)).toBe(true);
	});

	it("restores a substituted symlink after the final pre-rename inspection", async () => {
		if (typeof process.getuid !== "function") return;
		const fx = fixture();
		const executable = materialize(fx, "race generation\n", { pid: 701, processStartId: "dead" }, 0);
		const generationDirectory = dirname(executable);
		const preservedDirectory = join(root!, "preserved-generation");
		const externalDirectory = join(root!, "external-directory");
		mkdirSync(externalDirectory);
		writeFileSync(join(externalDirectory, "keep"), "preserve me");

		const result = await cleanupContentAddressedHelperCache({
			...fx,
			maxDeletions: 4,
			maxGenerations: 0,
			maxUnusedAgeMs: 0,
			nowMs: 10,
			testBeforeClaim: (path) => {
				renameSync(path, preservedDirectory);
				symlinkSync(externalDirectory, path, "dir");
			},
			testProcessInstanceStatus: () => "dead",
		});

		expect(result.deletedGenerations).toBe(0);
		expect(readFileSync(join(externalDirectory, "keep"), "utf8")).toBe("preserve me");
		expect(readFileSync(join(preservedDirectory, "fd"), "utf8")).toBe("race generation\n");
		expect(existsSync(generationDirectory)).toBe(true);
	});

	it("ignores symbolic-link generation entries entirely", async () => {
		if (typeof process.getuid !== "function") return;
		const fx = fixture();
		const content = Buffer.from("symlink target\n");
		const digest = createHash("sha256").update(content).digest("hex");
		const externalDirectory = join(root!, "external-generation");
		mkdirSync(externalDirectory);
		writeFileSync(join(externalDirectory, "keep"), content);
		mkdirSync(fx.cacheDirectory, { recursive: true });
		symlinkSync(externalDirectory, join(fx.cacheDirectory, digest), "dir");

		const result = await cleanupContentAddressedHelperCache({
			...fx,
			maxDeletions: 4,
			maxGenerations: 0,
			maxUnusedAgeMs: 0,
			nowMs: 10,
			testProcessInstanceStatus: () => "dead",
		});
		expect(result.scannedGenerations).toBe(0);
		expect(readFileSync(join(externalDirectory, "keep"))).toEqual(content);
	});
});
