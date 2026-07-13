import { afterEach, describe, expect, it } from "vitest";
import { currentDepth, sanitizeWorkerTools, spawnWorker } from "../../multiagent/workflow/magenta/worker.ts";

/**
 * Safety guards for worker spawning. These are the invariants that prevent a
 * non-main agent (a sub-agent or workflow worker) from gaining orchestration or
 * background-delegation powers, and prevent the fork-bomb class of failure.
 */
describe("worker capability denial", () => {
	it("strips nested agent and background controllers from any requested whitelist", () => {
		expect(sanitizeWorkerTools(["read", "sub_agent", "bg_shell", "teammate_agent", "ls"])).toEqual(["read", "ls"]);
	});

	it("falls back to read-only when only forbidden tools are requested", () => {
		expect(sanitizeWorkerTools(["sub_agent", "bg_shell", "teammate_agent"])).toEqual(["read", "grep", "find", "ls"]);
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
