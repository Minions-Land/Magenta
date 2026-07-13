import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	HCP_MAGNETS,
	type HcpClient,
	HcpClientassemble,
	type HcpClientcomponent,
	type McpClientOptions,
	type McpStdioManagedProcessInput,
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
 *     },
 *     {
 *       "name": "remote",
 *       "type": "http",
 *       "url": "https://host/mcp",
 *       "headers": { "Authorization": "Bearer ..." }
 *     }
 *   ]
 * }
 * ```
 *
 * Security: stdio entries name executables that are spawned as child processes
 * with the user's environment; http entries open an outbound connection to the
 * configured URL with any supplied headers (which may carry credentials). The
 * config file is user-owned; this is the same trust model as the harness package
 * path. Diagnostics never echo `headers` so bearer tokens are not logged.
 */
export type McpServerConfig = {
	/** Server name; also the default tool-name prefix. */
	name: string;
	/** Transport. Absent or "stdio" spawns a local process; "http" is remote. */
	type?: "stdio" | "http";
	/** Executable to spawn (absolute path or a command on PATH). stdio only. */
	command?: string;
	/** Arguments passed to the command. stdio only. */
	args?: string[];
	/** Extra environment variables, merged over `process.env`. stdio only. */
	env?: Record<string, string>;
	/** Endpoint URL for the streamable-HTTP transport. http only. */
	url?: string;
	/** Static request headers (e.g. `Authorization`). http only. */
	headers?: Record<string, string>;
	/** Tool-name prefix (`<prefix>_<remoteTool>`). Defaults to `name`. */
	name_prefix?: string;
	/** Per-request timeout in milliseconds. Default: 30000. */
	timeout_ms?: number;
	/** Selected sandbox profile (stdio only). Defaults to trusted for parity. */
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
	const hasStdioServer = servers.some((server) => (server?.type ?? "stdio") !== "http");
	if (hasStdioServer && (!processRuntime || !sandboxProvider)) {
		// stdio servers need the process + sandbox capabilities; http servers do
		// not, so a remote-only config is still allowed to proceed below.
		diagnostics.push({
			type: "error",
			message:
				"User MCP stdio servers require selected HCP capabilities runtime:process and sandbox before they can be started.",
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
	const seenNames = new Set<string>();

	for (const server of servers) {
		const type = server?.type ?? "stdio";
		if (!server?.name) {
			diagnostics.push({
				type: "warning",
				message: `Skipping MCP server entry missing "name" (type=${type}).`,
				path,
			});
			continue;
		}
		if (type === "stdio" && !server.command) {
			diagnostics.push({
				type: "warning",
				message: `Skipping stdio MCP server "${server.name}": missing "command".`,
				path,
			});
			continue;
		}
		if (type === "http" && !server.url) {
			diagnostics.push({
				type: "warning",
				message: `Skipping http MCP server "${server.name}": missing "url".`,
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
			let client: McpClientOptions;
			if (type === "http") {
				client = {
					transport: "http",
					url: server.url as string,
					headers: server.headers,
					requestTimeoutMs: server.timeout_ms,
				};
			} else {
				// stdio: processRuntime + sandboxProvider are guaranteed present here
				// because hasStdioServer forced the capability check above.
				const sandbox = sandboxProvider!.resolve({ profile: server.sandbox ?? "trusted" });
				client = {
					command: server.command as string,
					args: server.args,
					env: server.env ? { ...process.env, ...server.env } : undefined,
					requestTimeoutMs: server.timeout_ms,
					spawnManaged: (input: McpStdioManagedProcessInput, signal?: AbortSignal) =>
						processRuntime!.spawnManaged(
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
				};
			}
			components.push({
				...descriptor,
				name: server.name,
				selected: true,
				autoload: false,
				descriptorPath: path,
				requires: [],
				settings: {
					mcp: {
						serverName: server.name,
						namePrefix: server.name_prefix ?? server.name,
						client,
						// Remote servers enumerate live each assembly; only stdio caches.
						cache: type === "http" ? undefined : { dir: cacheDir, descriptorEnv: server.env },
					},
				},
			});
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
	diagnostics.push(
		...assembled.diagnostics.map((diagnostic) => ({
			type: diagnostic.code === "component_build_failed" ? ("warning" as const) : diagnostic.type,
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
