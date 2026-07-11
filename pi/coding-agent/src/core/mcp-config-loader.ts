import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	discoverMcpTools,
	HCP_MAGNETS,
	type HcpClient,
	HcpClientassemble,
	type HcpClientcomponent,
	mcpToolName,
	type ProcessRuntimeProvider,
	type SandboxProvider,
} from "@magenta/harness";
import { getAgentDir, getMcpServersPath } from "../config.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";

/**
 * User-facing MCP server config, read from `~/.magenta/agent/mcp-servers.json`.
 *
 * This is the general configuration path for MCP servers: it mirrors the
 * Package `runtime = "mcp"` descriptor path but sources servers from a
 * user-owned config file. Each server uses the same MCP transport as Package
 * tools, and its remote tools are surfaced as AgentTools.
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
export type McpServerConfig = {
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
	/** Selected sandbox profile. Explicit user MCP defaults to trusted for behavior parity. */
	sandbox?: string;
};

export type McpServersFile = {
	servers: McpServerConfig[];
};

export type LoadMcpToolsResult = {
	tools: AgentTool[];
	addresses: string[];
	diagnostics: ResourceDiagnostic[];
};

export type LoadUserMcpToolsOptions = {
	hcp: HcpClient;
	cwd: string;
	agentDir?: string;
};

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
export async function loadUserMcpTools(options: LoadUserMcpToolsOptions): Promise<LoadMcpToolsResult> {
	const diagnostics: ResourceDiagnostic[] = [];
	const agentDir = options.agentDir ?? getAgentDir();
	const path = options.agentDir ? join(options.agentDir, "mcp-servers.json") : getMcpServersPath();

	let raw: string;
	try {
		raw = await readFile(path, "utf-8");
	} catch (error) {
		// Missing file is the normal case: no user MCP servers configured.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { tools: [], addresses: [], diagnostics };
		diagnostics.push({
			type: "error",
			message: `Failed to read ${path}: ${error instanceof Error ? error.message : String(error)}`,
			path,
		});
		return { tools: [], addresses: [], diagnostics };
	}

	const { servers, error } = parseServersFile(raw);
	if (error) {
		diagnostics.push({ type: "error", message: error, path });
		return { tools: [], addresses: [], diagnostics };
	}
	const processRuntime = options.hcp.resolveCapability<ProcessRuntimeProvider>("runtime:process");
	const sandboxProvider = options.hcp.resolveCapability<SandboxProvider>("sandbox");
	if (!processRuntime || !sandboxProvider) {
		diagnostics.push({
			type: "error",
			message:
				"User MCP requires selected HCP capabilities runtime:process and sandbox before servers can be started.",
			path,
		});
		return { tools: [], addresses: [], diagnostics };
	}
	const descriptor = HCP_MAGNETS.find(
		(component) => component.module === "tools" && component.source === "descriptor" && component.product === "tool",
	) as HcpClientcomponent | undefined;
	if (!descriptor) {
		return {
			tools: [],
			addresses: [],
			diagnostics: [{ type: "error", message: "User MCP requires the generated tools/descriptor HcpMagnet.", path }],
		};
	}

	// Cache the tools/list result under the agent dir so a warm cache avoids
	// spawning the server binary during assembly (mirrors the package path).
	const cacheDir = join(agentDir, "cache", "mcp");
	const components: HcpClientcomponent[] = [];
	const componentsByConnection = new Map<
		Awaited<ReturnType<typeof discoverMcpTools>>["connection"],
		HcpClientcomponent[]
	>();
	const seenNames = new Set<string>();
	const seenToolNames = new Set<string>();

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
			const sandbox = sandboxProvider.resolve({ profile: server.sandbox ?? "trusted" });
			const discovered = await discoverMcpTools({
				serverName: server.name,
				namePrefix: server.name_prefix ?? server.name,
				client: {
					command: server.command,
					args: server.args,
					env: server.env ? { ...process.env, ...server.env } : undefined,
					requestTimeoutMs: server.timeout_ms,
					spawnManaged: (input, signal) =>
						processRuntime.spawnManaged(
							{
								command: input.command,
								args: input.args,
								cwd: input.cwd ?? options.cwd,
								workspace_root: options.cwd,
								env_overrides: Object.fromEntries(
									Object.entries(input.env ?? {}).filter(
										(entry): entry is [string, string] => typeof entry[1] === "string",
									),
								),
								sandbox,
								tool: {
									name: `mcp:${server.name}`,
									operation: "serve",
									tags: ["trusted"],
								},
							},
							signal,
						),
				},
				cache: { dir: cacheDir, descriptorEnv: server.env },
			});
			if (discovered.tools.length === 0) {
				await discovered.connection.close();
				continue;
			}
			const serverComponents: HcpClientcomponent[] = [];
			for (const tool of discovered.tools) {
				const namePrefix = server.name_prefix ?? server.name;
				const toolName = mcpToolName(tool.name, namePrefix);
				if (seenToolNames.has(toolName)) {
					diagnostics.push({
						type: "warning",
						message: `Duplicate user MCP tool name "${toolName}"; skipping the later tool.`,
						path,
					});
					continue;
				}
				seenToolNames.add(toolName);
				serverComponents.push({
					...descriptor,
					name: toolName,
					selected: true,
					autoload: false,
					descriptorPath: path,
					requires: [],
					settings: {
						mcp: { connection: discovered.connection, tool, namePrefix },
					},
				});
			}
			if (serverComponents.length === 0) await discovered.connection.close();
			else {
				components.push(...serverComponents);
				componentsByConnection.set(discovered.connection, serverComponents);
			}
		} catch (error) {
			diagnostics.push({
				type: "warning",
				message: `MCP server "${server.name}" failed to connect: ${error instanceof Error ? error.message : String(error)}`,
				path,
			});
		}
	}

	const assembled = await HcpClientassemble({
		hcp: options.hcp,
		repoRoot: options.cwd,
		cwd: options.cwd,
		includeAutoload: false,
		replaceExisting: false,
		components,
	});
	const builtComponents = new Set(assembled.builtComponents.map(({ component }) => component));
	for (const [connection, connectionComponents] of componentsByConnection) {
		if (connectionComponents.some((component) => builtComponents.has(component))) continue;
		try {
			await connection.close();
		} catch {
			// Registration diagnostics are primary; connection cleanup is best-effort.
		}
	}
	diagnostics.push(
		...assembled.diagnostics.map((diagnostic) => ({
			type: diagnostic.type,
			message: diagnostic.message,
			path,
		})),
	);
	const addresses = assembled.addresses.filter((address) => address.startsWith("tool:"));
	const tools = addresses
		.map((address) => options.hcp.resolveInstance<AgentTool>(address))
		.filter((tool): tool is AgentTool => tool !== undefined);
	return { tools, addresses, diagnostics };
}
