import { describe, expect, it } from "vitest";
import { resolveProcessRespawnInvocation } from "../src/utils/process-respawn.ts";

describe("process respawn invocation", () => {
	it("restarts a compiled Bun binary directly without passing its path as a CLI argument", () => {
		expect(
			resolveProcessRespawnInvocation({
				argv: ["bun", "/opt/magenta/magenta", "--session", "session-1"],
				execPath: "/opt/magenta/magenta",
				isCompiledBinary: true,
			}),
		).toEqual({ command: "/opt/magenta/magenta", args: ["--session", "session-1"] });
	});

	it("preserves the script entrypoint for Node and source-mode Bun", () => {
		expect(
			resolveProcessRespawnInvocation({
				argv: ["/usr/bin/node", "/workspace/dist/cli.js", "--offline"],
				execPath: "/usr/bin/node",
				isCompiledBinary: false,
			}),
		).toEqual({ command: "/usr/bin/node", args: ["/workspace/dist/cli.js", "--offline"] });
	});
});
