import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HcpMagnet as FindMagnet } from "../tools/find/pi/HcpMagnet.ts";
import { HcpMagnet as GrepMagnet } from "../tools/grep/pi/HcpMagnet.ts";

/**
 * Regression: the HCP find/grep Magnets used to construct their tools without
 * wiring an executable resolver. find omitted the `ensureTool` dep entirely, so
 * every HCP-resolved find call hit the "no ensureTool dependency was provided"
 * guard and failed. grep left `resolveRipgrep` at its default ("rg" from PATH),
 * so it only worked when the host happened to have a system ripgrep. Both now
 * resolve the embedded fd/rg binaries, so they work in a clean environment.
 *
 * These tests prove the tools actually execute WITHOUT relying on system PATH
 * (PATH is emptied for the duration), exercising the embedded-binary path the
 * fix wires up.
 */
describe("find/grep HCP Magnet executable wiring", () => {
	let dir: string;
	let originalPath: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "find-grep-magnet-"));
		writeFileSync(join(dir, "alpha.txt"), "hello embedded world\n");
		writeFileSync(join(dir, "beta.md"), "nothing to see\n");
		// Simulate a clean host with no fd/rg on PATH so a passing test can only
		// mean the Magnet resolved the embedded binary itself.
		originalPath = process.env.PATH;
		process.env.PATH = "";
	});

	afterEach(() => {
		process.env.PATH = originalPath;
		rmSync(dir, { recursive: true, force: true });
	});

	function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
		return result.content
			.filter((p): p is { type: "text"; text: string } => p.type === "text" && typeof p.text === "string")
			.map((p) => p.text)
			.join("\n");
	}

	it("find resolves the embedded fd and matches files without system PATH", async () => {
		const magnet = FindMagnet.build({ repoRoot: dir, cwd: dir } as never);
		const tool = magnet.toTool() as AgentTool;

		const result = (await tool.execute("call-find", { pattern: "*.txt" }, undefined, undefined, {} as never)) as {
			content: Array<{ type: string; text?: string }>;
		};

		const text = textOf(result);
		expect(text).toContain("alpha.txt");
		expect(text).not.toContain("beta.md");
	});

	it("grep resolves the embedded ripgrep and matches content without system PATH", async () => {
		const magnet = GrepMagnet.build({ repoRoot: dir, cwd: dir } as never);
		const tool = magnet.toTool() as AgentTool;

		const result = (await tool.execute(
			"call-grep",
			{ pattern: "embedded" },
			undefined,
			undefined,
			{} as never,
		)) as {
			content: Array<{ type: string; text?: string }>;
		};

		const text = textOf(result);
		expect(text).toContain("alpha.txt");
		expect(text).toContain("embedded");
		expect(text).not.toContain("beta.md");
	});
});
