import assert from "node:assert/strict";
import test from "node:test";
import { signLocalMacBinary } from "./local-release-signing.mjs";

test("re-signs and strictly verifies completed local macOS binaries", () => {
	const commands = [];
	assert.equal(
		signLocalMacBinary({
			binaryPath: "/tmp/magenta",
			platform: "darwin-arm64",
			runCommand: (command, args) => commands.push([command, args]),
		}),
		true,
	);
	assert.deepEqual(commands, [
		["codesign", ["--force", "--sign", "-", "--timestamp=none", "/tmp/magenta"]],
		["codesign", ["--verify", "--strict", "--verbose=2", "/tmp/magenta"]],
	]);
});

test("leaves non-macOS local binaries unchanged", () => {
	assert.equal(
		signLocalMacBinary({
			binaryPath: "/tmp/magenta",
			platform: "linux-x64",
			runCommand: () => assert.fail("non-macOS builds must not invoke codesign"),
		}),
		false,
	);
});
