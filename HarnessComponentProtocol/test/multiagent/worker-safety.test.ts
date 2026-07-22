import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LOG_MAX_BYTES } from "../../_magenta/log-retention.ts";
import { NODE_MAX_TIMEOUT_MS } from "../../_magenta/timeout.ts";
import { currentDepth, sanitizeWorkerTools, spawnWorker } from "../../tools/sub-agent/magenta/workflow/worker.ts";

/**
 * Safety guards for worker spawning. These invariants keep a workflow worker
 * from gaining orchestration, background-delegation, teammate-control, or peer
 * mailbox powers, and prevent the fork-bomb class of failure.
 */
describe("worker capability denial", () => {
	it("strips delegation controllers and peer messaging from any requested whitelist", () => {
		expect(sanitizeWorkerTools(["read", "sub_agent", "bg_shell", "multiagent", "send_message", "ls"])).toEqual([
			"read",
			"ls",
		]);
	});

	it("falls back to read-only when only forbidden tools are requested", () => {
		expect(sanitizeWorkerTools(["sub_agent", "bg_shell", "multiagent", "send_message"])).toEqual([
			"read",
			"grep",
			"find",
			"ls",
		]);
	});

	it("falls back to read-only when no tools are requested", () => {
		expect(sanitizeWorkerTools(undefined)).toEqual(["read", "grep", "find", "ls"]);
		expect(sanitizeWorkerTools([])).toEqual(["read", "grep", "find", "ls"]);
	});

	it("keeps allowed tools untouched", () => {
		expect(sanitizeWorkerTools(["read", "edit", "bash"])).toEqual(["read", "edit", "bash"]);
	});
});

describe("worker depth guard (defense in depth)", () => {
	const original = process.env.PI_MAORCH_DEPTH;
	afterEach(() => {
		if (original === undefined) delete process.env.PI_MAORCH_DEPTH;
		else process.env.PI_MAORCH_DEPTH = original;
	});

	it("reports depth 0 at the top level", () => {
		delete process.env.PI_MAORCH_DEPTH;
		expect(currentDepth()).toBe(0);
	});

	it("reads the depth from the environment", () => {
		process.env.PI_MAORCH_DEPTH = "1";
		expect(currentDepth()).toBe(1);
	});

	it("refuses to spawn (never launches a process) when already inside a worker", async () => {
		process.env.PI_MAORCH_DEPTH = "1";
		const result = await spawnWorker({ workerId: "w1", prompt: "anything" });
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/depth limit/);
		// durationMs is 0 because we bail before spawning anything.
		expect(result.durationMs).toBe(0);
	});
});

describe("worker isolation guard", () => {
	const original = process.env.PI_MAORCH_DEPTH;
	afterEach(() => {
		if (original === undefined) delete process.env.PI_MAORCH_DEPTH;
		else process.env.PI_MAORCH_DEPTH = original;
	});

	it("refuses an unimplemented isolation instead of silently downgrading to process", async () => {
		delete process.env.PI_MAORCH_DEPTH;
		const result = await spawnWorker({ workerId: "w1", prompt: "anything", isolation: "worktree" });
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/isolation "worktree" is not implemented/);
		// Bails before spawning, so no time is spent.
		expect(result.durationMs).toBe(0);
	});
});

describe("worker timeout guard", () => {
	const original = process.env.PI_MAORCH_DEPTH;
	afterEach(() => {
		if (original === undefined) delete process.env.PI_MAORCH_DEPTH;
		else process.env.PI_MAORCH_DEPTH = original;
	});

	it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, NODE_MAX_TIMEOUT_MS + 1])(
		"refuses invalid timeout %s before resolving or spawning a worker",
		async (timeoutMs) => {
			delete process.env.PI_MAORCH_DEPTH;
			let resolved = false;
			const result = await spawnWorker({ workerId: "bad-timeout", prompt: "anything", timeoutMs }, undefined, () => {
				resolved = true;
				return { command: process.execPath, args: [] };
			});
			expect(result).toMatchObject({ success: false, durationMs: 0 });
			expect(result.error).toMatch(/Invalid workflow worker timeoutMs/);
			expect(resolved).toBe(false);
		},
	);
});

describe("worker output collector bounds", () => {
	const original = process.env.PI_MAORCH_DEPTH;
	afterEach(() => {
		if (original === undefined) delete process.env.PI_MAORCH_DEPTH;
		else process.env.PI_MAORCH_DEPTH = original;
	});

	it("terminates on continuous assistant frames that exceed retained history", async () => {
		delete process.env.PI_MAORCH_DEPTH;
		const oneMiB = 1024 * 1024;
		const fixture = [
			`const text = "x".repeat(${oneMiB});`,
			'const line = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } }) + "\\n";',
			`for (let index = 0; index < ${Math.ceil(DEFAULT_LOG_MAX_BYTES / oneMiB) + 2}; index++) process.stdout.write(line);`,
		].join("\n");

		const result = await spawnWorker(
			{ workerId: "retained-overflow", prompt: "anything", timeoutMs: 10_000 },
			undefined,
			() => ({ command: process.execPath, args: ["-e", fixture] }),
		);

		expect(result.success).toBe(false);
		expect(result.error).toBe(`workflow worker retained assistant messages exceeded ${DEFAULT_LOG_MAX_BYTES} bytes`);
	});

	it("terminates when stdout never completes a bounded NDJSON frame", async () => {
		delete process.env.PI_MAORCH_DEPTH;
		const oneMiB = 1024 * 1024;
		const fixture = [
			`const chunk = Buffer.alloc(${oneMiB}, 0x78);`,
			`for (let index = 0; index < ${Math.ceil(DEFAULT_LOG_MAX_BYTES / oneMiB) + 2}; index++) process.stdout.write(chunk);`,
		].join("\n");

		const result = await spawnWorker(
			{ workerId: "frame-overflow", prompt: "anything", timeoutMs: 10_000 },
			undefined,
			() => ({ command: process.execPath, args: ["-e", fixture] }),
		);

		expect(result.success).toBe(false);
		expect(result.error).toBe(`workflow worker stdout NDJSON frame exceeded ${DEFAULT_LOG_MAX_BYTES} bytes`);
	});

	it("terminates when continuous stderr exceeds the shared byte cap", async () => {
		delete process.env.PI_MAORCH_DEPTH;
		const oneMiB = 1024 * 1024;
		const fixture = [
			`const chunk = Buffer.alloc(${oneMiB}, 0x78);`,
			`for (let index = 0; index < ${Math.ceil(DEFAULT_LOG_MAX_BYTES / oneMiB) + 2}; index++) process.stderr.write(chunk);`,
		].join("\n");

		const result = await spawnWorker(
			{ workerId: "stderr-overflow", prompt: "anything", timeoutMs: 10_000 },
			undefined,
			() => ({ command: process.execPath, args: ["-e", fixture] }),
		);

		expect(result.success).toBe(false);
		expect(result.error).toBe(`workflow worker stderr exceeded ${DEFAULT_LOG_MAX_BYTES} bytes`);
	});
});

describe("worker host invocation", () => {
	const original = process.env.PI_MAORCH_DEPTH;
	const originalPath = process.env.PATH;
	afterEach(() => {
		if (original === undefined) delete process.env.PI_MAORCH_DEPTH;
		else process.env.PI_MAORCH_DEPTH = original;
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
	});

	it("uses the host resolver without PATH pi and preserves package arguments", async () => {
		delete process.env.PI_MAORCH_DEPTH;
		process.env.PATH = "";
		let requestedArgs: string[] = [];
		const fixture = [
			"const event = {",
			'type: "message_end",',
			'message: { role: "assistant", content: [{ type: "text", text: "worker-ok" }], usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, unknown: true } } },',
			"};",
			'process.stdout.write(JSON.stringify(event) + "\\n");',
		].join("\n");

		const result = await spawnWorker(
			{
				workerId: "package-worker",
				prompt: "use the package",
				packages: [" ClaudeScience ", "", "paper-analysis:review"],
				timeoutMs: 5_000,
			},
			undefined,
			(args) => {
				requestedArgs = [...args];
				return { command: process.execPath, args: ["-e", fixture] };
			},
		);

		expect(result).toMatchObject({ success: true, text: "worker-ok" });
		expect(result.usage?.cost.unknown).toBe(true);
		expect(requestedArgs).toEqual(
			expect.arrayContaining(["--harness-package", "ClaudeScience", "paper-analysis:review"]),
		);
		expect(requestedArgs.filter((arg) => arg === "--harness-package")).toHaveLength(2);
	});
});
