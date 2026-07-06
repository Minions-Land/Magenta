import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createMcpToolMagnets } from "@magenta/harness";
import { getAgentDir, getMcpServersPath } from "../config.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";

/**
 * User-facing MCP server config, read from `~/.magenta/agent/mcp-servers.json`.
 *
 * This is the general registration path for MCP servers: it mirrors the harness
 * "package" path (a `runtime = "mcp"` descriptor) but sources servers from a
 * user-owned config file instead of a shipped package. Each server is connected
 * via {@link createMcpToolMagnets} (the same hcp-magnet entry point the package
 * path uses), and its remote tools are surfaced as AgentTools.
 *
 * Schema:
 * ```json
 * {
 *   "servers": [
 *     {
 *       "name": "my-server",
 *       "command": "node",
 *       "args": ["server.js"],
 *       "env": { "API_KEY": "..." },
 *       "name_prefix": "mine",
 *       "timeout_ms": 30000
 *     }
 *   ]
 * }
 * ```
 *
 * Security: entries name executables that are spawned as child processes with
 * the user's environment. The config file is user-owned; this is the same trust
 * model as the harness package path.
 */
export interface McpServerConfig {
	/** Server name; also the default tool-name prefix. */
	name: string;
	/** Executable to spawn (absolute path or a command on PATH). */
	command: string;
	/** Arguments passed to the command. */
	args?: string[];
	/** Extra environment variables, merged over `process.env`. */
	env?: Record<string, string>;
	/** Tool-name prefix (`<prefix>_<remoteTool>`). Defaults to `name`. */
	name_prefix?: string;
	/** Per-request timeout in milliseconds. Default: 30000. */
	timeout_ms?: number;
}

export interface McpServersFile {
	servers: McpServerConfig[];
}

export interface LoadMcpToolsResult {
	tools: AgentTool[];
	diagnostics: ResourceDiagnostic[];
}

function parseServersFile(raw: string): { servers: McpServerConfig[]; error?: string } {
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch (error) {
		return {
			servers: [],
			error: `mcp-servers.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (typeof data !== "object" || data === null || !Array.isArray((data as McpServersFile).servers)) {
		return { servers: [], error: 'mcp-servers.json must be an object with a "servers" array' };
	}
	return { servers: (data as McpServersFile).servers };
}

/**
 * Read `~/.magenta/agent/mcp-servers.json` and connect each configured MCP server,
 * returning its remote tools as AgentTools. A missing config file is not an
 * error (returns no tools). A malformed file or a server that fails to connect
 * is downgraded to a diagnostic so one bad entry never blocks the others.
 */
export async function loadUserMcpTools(): Promise<LoadMcpToolsResult> {
	const diagnostics: ResourceDiagnostic[] = [];
	const path = getMcpServersPath();

	let raw: string;
	try {
		raw = await readFile(path, "utf-8");
	} catch (error) {
		// Missing file is the normal case: no user MCP servers configured.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { tools: [], diagnostics };
		diagnostics.push({
			type: "error",
			message: `Failed to read ${path}: ${error instanceof Error ? error.message : String(error)}`,
			path,
		});
		return { tools: [], diagnostics };
	}

	const { servers, error } = parseServersFile(raw);
	if (error) {
		diagnostics.push({ type: "error", message: error, path });
		return { tools: [], diagnostics };
	}

	// Cache the tools/list result under the agent dir so a warm cache avoids
	// spawning the server binary during assembly (mirrors the package path).
	const cacheDir = join(getAgentDir(), "cache", "mcp");
	const tools: AgentTool[] = [];
	const seenNames = new Set<string>();

	for (const server of servers) {
		if (!server?.name || !server?.command) {
			diagnostics.push({
				type: "warning",
				message: `Skipping MCP server entry missing "name" or "command": ${JSON.stringify(server)}`,
				path,
			});
			continue;
		}
		if (seenNames.has(server.name)) {
			diagnostics.push({
				type: "warning",
				message: `Duplicate MCP server name "${server.name}" in mcp-servers.json; skipping the later entry.`,
				path,
			});
			continue;
		}
		seenNames.add(server.name);

		try {
			const magnets = await createMcpToolMagnets({
				serverName: server.name,
				namePrefix: server.name_prefix ?? server.name,
				client: {
					command: server.command,
					args: server.args,
					env: server.env ? { ...process.env, ...server.env } : undefined,
					requestTimeoutMs: server.timeout_ms,
				},
				cache: { dir: cacheDir, descriptorEnv: server.env },
			});
			for (const magnet of magnets) tools.push(magnet.toTool());
		} catch (error) {
			diagnostics.push({
				type: "warning",
				message: `MCP server "${server.name}" failed to connect: ${error instanceof Error ? error.message : String(error)}`,
				path,
			});
		}
	}

	return { tools, diagnostics };
}
