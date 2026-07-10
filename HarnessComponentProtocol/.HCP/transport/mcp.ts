import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import { type TSchema, Type } from "typebox";
import { type McpToolsCacheOptions, readMcpToolsCache, writeMcpToolsCache } from "./mcp-cache.ts";
import {
	McpStdioClient,
	type McpStdioClientOptions,
	type McpToolCallResult,
	type McpToolSchema,
} from "./mcp-client.ts";
import type { JsonSchema } from "./schema.ts";

/**
 * Adapts one tool exposed by an external MCP server into a loop-ready
 * {@link AgentTool}.
 *
 * A single MCP server exposes many tools, so one connection fans out into N
 * {@link McpTool} instances, one per remote tool. They share one long-lived
 * {@link McpConnection}; discovery and connection lifecycle stay on the shared
 * connection while each source owns only its AgentTool mapping.
 */

export type McpToolDetails = {
	server: string;
	remoteTool: string;
	isError: boolean;
};

/**
 * A shared, lazily-initialized connection to one MCP server. The first tool
 * invocation triggers the spawn + `initialize` handshake; subsequent calls reuse
 * the same process. This keeps a stdio MCP server long-lived across the session
 * rather than re-spawning per call the way one-shot process tools do.
 */
export class McpConnection {
	private readonly client: McpStdioClient;
	private connectPromise?: Promise<void>;
	readonly serverName: string;

	constructor(serverName: string, options: McpStdioClientOptions) {
		this.serverName = serverName;
		this.client = new McpStdioClient(options);
	}

	/** Connect once; concurrent callers await the same in-flight handshake. */
	async ensureConnected(): Promise<void> {
		if (this.client.isConnected) return;
		if (!this.connectPromise) {
			this.connectPromise = this.client.connect().catch((error) => {
				// Allow a later call to retry a failed connect.
				this.connectPromise = undefined;
				throw error;
			});
		}
		await this.connectPromise;
	}

	async listTools(): Promise<McpToolSchema[]> {
		await this.ensureConnected();
		return this.client.listTools();
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
		await this.ensureConnected();
		return this.client.callTool(name, args);
	}

	async close(): Promise<void> {
		await this.client.close();
	}
}

export type McpToolOptions = {
	connection: McpConnection;
	tool: McpToolSchema;
	/**
	 * Prefix applied to the remote tool name to namespace it in the local tool
	 * address space and avoid collisions with built-in tools. The exposed tool
	 * name becomes `<prefix>_<remoteTool>` (sanitized).
	 */
	namePrefix?: string;
};

/** Sanitize a tool name to the characters the agent runtime accepts. */
export function mcpToolName(name: string, prefix?: string): string {
	const value = prefix ? `${prefix}_${name}` : name;
	return value.replace(/[^a-zA-Z0-9_-]+/g, "_");
}

/**
 * Convert an MCP tool result's content array into the harness AgentToolResult
 * content shape. MCP emits typed content parts; we forward text parts and
 * summarize any non-text parts so nothing is silently dropped.
 */
function toToolContent(result: McpToolCallResult): TextContent[] {
	const parts: TextContent[] = [];
	for (const item of result.content ?? []) {
		if (item.type === "text" && typeof item.text === "string") {
			parts.push({ type: "text", text: item.text });
		} else {
			parts.push({ type: "text", text: `[${item.type} content]` });
		}
	}
	if (parts.length === 0) parts.push({ type: "text", text: "" });
	return parts;
}

export class McpTool {
	readonly kind = "mcp";
	readonly source: string;
	private readonly connection: McpConnection;
	private readonly remoteToolName: string;
	private readonly toolName: string;
	private readonly parameters: TSchema;
	private readonly toolDescription: string;

	constructor(options: McpToolOptions) {
		const { connection, tool, namePrefix } = options;
		const localName = mcpToolName(tool.name, namePrefix);
		const description = tool.description ?? tool.name;
		this.source = connection.serverName;
		this.connection = connection;
		this.remoteToolName = tool.name;
		this.toolName = localName;
		this.toolDescription = description;
		this.parameters =
			(tool.inputSchema as JsonSchema | undefined) ??
			(Type.Object({}, { additionalProperties: true }) as unknown as TSchema);
	}

	toTool(): AgentTool<TSchema, McpToolDetails> {
		return {
			name: this.toolName,
			label: this.remoteToolName,
			description: this.toolDescription,
			parameters: this.parameters,
			provenance: {
				kind: "mcp",
				server: this.connection.serverName,
				remoteTool: this.remoteToolName,
			},
			execute: async (_toolCallId, params): Promise<AgentToolResult<McpToolDetails>> => {
				const args = (params ?? {}) as Record<string, unknown>;
				const result = await this.connection.callTool(this.remoteToolName, args);
				return {
					content: toToolContent(result),
					details: {
						server: this.connection.serverName,
						remoteTool: this.remoteToolName,
						isError: Boolean(result.isError),
					},
				};
			},
		};
	}
}

export type CreateMcpToolsOptions = {
	serverName: string;
	client: McpStdioClientOptions;
	namePrefix?: string;
	/**
	 * Optional disk cache for the server's `tools/list` result. When provided and
	 * warm, the server binary is NOT spawned during assembly: tools are built
	 * from the cached schema and the shared {@link McpConnection} stays lazy,
	 * spawning only when a tool is first invoked. On a miss the tools are
	 * enumerated live (spawning now) and the result is written back.
	 */
	cache?: {
		dir: string;
		/**
		 * The descriptor-declared env (not the merged process env) that participates
		 * in the cache key. The live client may receive a broader merged env.
		 */
		descriptorEnv?: Record<string, string>;
	};
};

export type DiscoverMcpToolsResult = {
	connection: McpConnection;
	tools: McpToolSchema[];
};

/**
 * Connect to an MCP server, discover its tools, and produce one
 * {@link McpTool} per remote tool sharing a single connection. This is the
 * fan-out entry point the package-tool factory calls for a `runtime = "mcp"`
 * component.
 *
 * When a cache is supplied and warm, discovery is served from disk and no
 * process is spawned until a tool is actually called.
 */
export async function discoverMcpTools(options: CreateMcpToolsOptions): Promise<DiscoverMcpToolsResult> {
	const connection = new McpConnection(options.serverName, options.client);

	const cacheOptions: McpToolsCacheOptions | undefined = options.cache
		? {
				cacheDir: options.cache.dir,
				serverName: options.serverName,
				client: {
					command: options.client.command,
					args: options.client.args,
					env: options.cache.descriptorEnv,
					cwd: options.client.cwd,
				},
			}
		: undefined;

	let tools: McpToolSchema[] | undefined;
	if (cacheOptions) {
		tools = await readMcpToolsCache(cacheOptions);
	}

	if (!tools) {
		// Cache miss (or no cache): enumerate live, which spawns the server now.
		tools = await connection.listTools();
		if (cacheOptions) await writeMcpToolsCache(cacheOptions, tools);
	}

	return { connection, tools };
}

export async function createMcpTools(options: CreateMcpToolsOptions): Promise<McpTool[]> {
	const { connection, tools } = await discoverMcpTools(options);
	return tools.map(
		(tool) =>
			new McpTool({
				connection,
				tool,
				namePrefix: options.namePrefix,
			}),
	);
}
