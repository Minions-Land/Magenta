import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Check } from "typebox/value";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { NodeExecutionEnv } from "../_magenta/env/pi/nodejs.ts";
import { type BashOperations, bashSchema, createBashExecute, MAX_TIMEOUT_SECONDS } from "../tools/bash/pi/bash.ts";

function createSuccessfulChild() {
	const child = new EventEmitter() as EventEmitter & {
		pid: number;
		stdout: PassThrough;
		stderr: PassThrough;
	};
	child.pid = 123;
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	queueMicrotask(() => child.emit("close", 0));
	return child;
}

const INVALID_TIMEOUTS = [
	0,
	-1,
	Number.NaN,
	Number.POSITIVE_INFINITY,
	Number.NEGATIVE_INFINITY,
	MAX_TIMEOUT_SECONDS + 0.001,
];

beforeEach(() => {
	spawnMock.mockReset();
	spawnMock.mockImplementation(createSuccessfulChild);
});

describe("NodeExecutionEnv timeout validation", () => {
	it.each(INVALID_TIMEOUTS)("rejects invalid timeout %s before spawning", async (timeout) => {
		const env = new NodeExecutionEnv({ cwd: process.cwd() });
		const result = await env.exec("printf ok", { timeout });

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatchObject({ code: "timeout" });
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it.each([0.5, MAX_TIMEOUT_SECONDS])("allows valid timeout %s", async (timeout) => {
		const env = new NodeExecutionEnv({ cwd: process.cwd() });
		const result = await env.exec("printf ok", { timeout });

		expect(result.ok).toBe(true);
		expect(spawnMock).toHaveBeenCalledTimes(1);
	});
});

describe("HCP bash timeout validation", () => {
	it.each(INVALID_TIMEOUTS)("rejects invalid timeout %s before calling operations", async (timeout) => {
		const exec = vi.fn<BashOperations["exec"]>();
		const execute = createBashExecute(process.cwd(), { operations: { exec } });

		await expect(execute("call-1", { command: "printf ok", timeout })).rejects.toThrow("Invalid timeout");
		expect(exec).not.toHaveBeenCalled();
	});

	it.each([0.5, MAX_TIMEOUT_SECONDS])("passes valid timeout %s to operations", async (timeout) => {
		const exec = vi.fn<BashOperations["exec"]>().mockResolvedValue({ exitCode: 0 });
		const execute = createBashExecute(process.cwd(), { operations: { exec } });

		await expect(execute("call-1", { command: "printf ok", timeout })).resolves.toBeDefined();
		expect(exec).toHaveBeenCalledWith("printf ok", process.cwd(), expect.objectContaining({ timeout }));
	});

	it("publishes the same timeout domain in the tool schema", () => {
		for (const timeout of [0.5, MAX_TIMEOUT_SECONDS]) {
			expect(Check(bashSchema, { command: "printf ok", timeout })).toBe(true);
		}
		for (const timeout of INVALID_TIMEOUTS) {
			expect(Check(bashSchema, { command: "printf ok", timeout })).toBe(false);
		}
	});
});
