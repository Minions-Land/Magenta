import assert from "node:assert/strict";
import test from "node:test";
import { runBunCompile } from "./run-bun-compile.mjs";

test("Bun compile wrapper cleans scratch after success and failure", () => {
	const calls = [];
	const cleanScratch = (cwd) => calls.push(["clean", cwd]);
	const runCommand = (command, args, options) => {
		calls.push([command, ...args, options.cwd]);
		return { error: undefined, signal: null, status: 0 };
	};
	assert.equal(
		runBunCompile({ args: ["build", "--compile", "entry.ts"], cleanScratch, cwd: "/tmp/package", runCommand }),
		0,
	);
	assert.deepEqual(calls, [
		["bun", "build", "--compile", "entry.ts", "/tmp/package"],
		["clean", "/tmp/package"],
	]);

	calls.length = 0;
	assert.equal(
		runBunCompile({
			args: ["build", "--compile", "entry.ts"],
			cleanScratch,
			cwd: "/tmp/package",
			runCommand: () => ({ error: undefined, signal: null, status: 7 }),
		}),
		7,
	);
	assert.deepEqual(calls, [["clean", "/tmp/package"]]);
});

test("Bun compile wrapper rejects unrelated commands without cleanup", () => {
	let cleaned = false;
	assert.throws(
		() =>
			runBunCompile({
				args: ["run", "script.ts"],
				cleanScratch: () => {
					cleaned = true;
				},
			}),
		/requires bun build --compile/u,
	);
	assert.equal(cleaned, false);
});
