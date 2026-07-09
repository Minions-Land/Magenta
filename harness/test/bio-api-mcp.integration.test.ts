import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createMcpToolMagnets } from "../harness-component-protocol/magnet/mcp.ts";

/**
 * End-to-end integration test for the vendored bio-API MCP server.
 *
 * This drives the *real* harness MCP loading path (createMcpToolMagnets →
 * McpStdioClient) against the compiled `aose-bio-mcp` binary: it spawns the
 * process, performs the JSON-RPC `initialize` handshake, enumerates tools, and
 * builds one magnet per tool. It confirms the binary is actually usable through
 * the harness — not just that it builds.
 *
 * The binary must be built first:
 *   cd packages/AutOmicScience/tools/bio-api/rust && cargo build --release --bin aose-bio-mcp
 * If it is absent the test is skipped rather than failing, so CI without the
 * Rust toolchain stays green.
 */

const repoRoot = resolve(__dirname, "..", "..");
const binary = resolve(repoRoot, "packages/AutOmicScience/tools/bio-api/rust/target/release/aose-bio-mcp");
const hasBinary = existsSync(binary);

describe.skipIf(!hasBinary)("bio-api MCP server (vendored)", () => {
	it("spawns, handshakes, and fans out into one magnet per tool", async () => {
		const magnets = await createMcpToolMagnets({
			serverName: "aose-bio-mcp",
			namePrefix: "biofetch",
			client: { command: binary, args: [], requestTimeoutMs: 30000 },
		});

		// The vendored server exposes the non-key-gated bio tools.
		expect(magnets.length).toBeGreaterThanOrEqual(26);

		const tools = magnets.map((m) => m.toTool());
		const names = tools.map((t) => t.name);

		// Namespacing applied, and a representative tool is present.
		expect(names.every((n) => n.startsWith("biofetch_"))).toBe(true);
		expect(names).toContain("biofetch_ensembl_info");

		// Each tool carries a usable JSON schema for its parameters.
		const ensembl = tools.find((t) => t.name === "biofetch_ensembl_info");
		expect(ensembl?.parameters).toBeTruthy();
		expect(ensembl?.description).toBeTruthy();

		// Close the shared connection (spawned lazily on first list).
		// createMcpToolMagnets enumerated live, so a process is running.
		for (const magnet of magnets) {
			// health() reports the shared connection; calling once is enough.
			// eslint-disable-next-line no-await-in-loop
			await magnet.health();
			break;
		}
	}, 60000);
});
