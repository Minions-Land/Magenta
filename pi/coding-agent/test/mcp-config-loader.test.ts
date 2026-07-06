import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { loadUserMcpTools } from "../src/core/mcp-config-loader.ts";

describe("loadUserMcpTools", () => {
	let dir: string;
	let prevAgentDir: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "mcp-loader-"));
		prevAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = dir;
	});

	afterEach(() => {
		if (prevAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = prevAgentDir;
		rmSync(dir, { recursive: true, force: true });
	});

	const writeConfig = (content: string) => writeFileSync(join(dir, "mcp-servers.json"), content, "utf-8");

	it("returns no tools and no diagnostics when the config is missing", async () => {
		const result = await loadUserMcpTools();
		expect(result.tools).toEqual([]);
		expect(result.diagnostics).toEqual([]);
	});

	it("reports an error diagnostic for malformed JSON", async () => {
		writeConfig("{ not json");
		const result = await loadUserMcpTools();
		expect(result.tools).toEqual([]);
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0]?.type).toBe("error");
		expect(result.diagnostics[0]?.message).toContain("not valid JSON");
	});

	it("reports an error when the servers array is missing", async () => {
		writeConfig(JSON.stringify({ foo: "bar" }));
		const result = await loadUserMcpTools();
		expect(result.tools).toEqual([]);
		expect(result.diagnostics[0]?.type).toBe("error");
		expect(result.diagnostics[0]?.message).toContain('"servers" array');
	});

	it("skips entries missing name or command with a warning", async () => {
		writeConfig(JSON.stringify({ servers: [{ name: "no-command" }, { command: "node" }] }));
		const result = await loadUserMcpTools();
		expect(result.tools).toEqual([]);
		expect(result.diagnostics).toHaveLength(2);
		expect(result.diagnostics.every((d) => d.type === "warning")).toBe(true);
	});

	it("skips a duplicate server name with a warning without spawning it twice", async () => {
		// The first entry names a command that does not exist, so it fails to
		// connect (warning). The duplicate is skipped before any connect attempt.
		writeConfig(
			JSON.stringify({
				servers: [
					{ name: "dup", command: "/nonexistent/mcp-binary-xyz" },
					{ name: "dup", command: "/nonexistent/mcp-binary-xyz" },
				],
			}),
		);
		const result = await loadUserMcpTools();
		expect(result.tools).toEqual([]);
		const dupWarning = result.diagnostics.find((d) => d.message.includes("Duplicate MCP server name"));
		expect(dupWarning?.type).toBe("warning");
	});

	it("returns an empty toolset (no throw) when a server fails to connect", async () => {
		writeConfig(JSON.stringify({ servers: [{ name: "broken", command: "/nonexistent/mcp-binary-xyz" }] }));
		const result = await loadUserMcpTools();
		expect(result.tools).toEqual([]);
		expect(result.diagnostics.some((d) => d.type === "warning" && d.message.includes("broken"))).toBe(true);
	});
});
