/**
 * MCP Server wrapper for Magenta3 harness
 *
 * Provides a simplified interface to build MCP servers.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type {
	EmbeddedResource,
	ImageContent,
	Prompt,
	Resource,
	TextContent,
	Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
	CallToolRequestSchema,
	GetPromptRequestSchema,
	ListPromptsRequestSchema,
	ListResourcesRequestSchema,
	ListToolsRequestSchema,
	ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

export interface McpServerOptions {
	name: string;
	version?: string;
}

export interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<(TextContent | ImageContent | EmbeddedResource)[]>;

export interface ResourceDefinition {
	uri: string;
	name: string;
	description?: string;
	mimeType?: string;
}

export type ResourceHandler = (uri: string) => Promise<(TextContent | ImageContent | EmbeddedResource)[]>;

export interface PromptDefinition {
	name: string;
	description?: string;
	arguments?: Array<{
		name: string;
		description?: string;
		required?: boolean;
	}>;
}

export type PromptHandler = (args: Record<string, unknown>) => Promise<{
	messages: Array<{
		role: "user" | "assistant";
		content: TextContent | ImageContent;
	}>;
}>;

export class McpServer {
	private server: Server;
	private tools: Map<string, { definition: ToolDefinition; handler: ToolHandler }> = new Map();
	private resources: Map<string, { definition: ResourceDefinition; handler: ResourceHandler }> = new Map();
	private prompts: Map<string, { definition: PromptDefinition; handler: PromptHandler }> = new Map();

	constructor(options: McpServerOptions) {
		this.server = new Server(
			{
				name: options.name,
				version: options.version || "1.0.0",
			},
			{
				capabilities: {
					tools: {},
					resources: {},
					prompts: {},
				},
			},
		);

		this.setupHandlers();
	}

	private setupHandlers(): void {
		// List tools
		this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
			tools: Array.from(this.tools.values()).map((t) => t.definition),
		}));

		// Call tool
		this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
			const tool = this.tools.get(request.params.name);
			if (!tool) {
				throw new Error(`Unknown tool: ${request.params.name}`);
			}
			const content = await tool.handler(request.params.arguments || {});
			return { content };
		});

		// List resources
		this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
			resources: Array.from(this.resources.values()).map((r) => r.definition),
		}));

		// Read resource
		this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
			const resource = this.resources.get(request.params.uri);
			if (!resource) {
				throw new Error(`Unknown resource: ${request.params.uri}`);
			}
			const contents = await resource.handler(request.params.uri);
			return { contents };
		});

		// List prompts
		this.server.setRequestHandler(ListPromptsRequestSchema, async () => ({
			prompts: Array.from(this.prompts.values()).map((p) => p.definition),
		}));

		// Get prompt
		this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
			const prompt = this.prompts.get(request.params.name);
			if (!prompt) {
				throw new Error(`Unknown prompt: ${request.params.name}`);
			}
			return await prompt.handler(request.params.arguments || {});
		});
	}

	/**
	 * Register a tool
	 */
	registerTool(definition: ToolDefinition, handler: ToolHandler): void {
		this.tools.set(definition.name, { definition, handler });
	}

	/**
	 * Register a resource
	 */
	registerResource(definition: ResourceDefinition, handler: ResourceHandler): void {
		this.resources.set(definition.uri, { definition, handler });
	}

	/**
	 * Register a prompt
	 */
	registerPrompt(definition: PromptDefinition, handler: PromptHandler): void {
		this.prompts.set(definition.name, { definition, handler });
	}

	/**
	 * Start the server with stdio transport
	 */
	async run(): Promise<void> {
		const transport = new StdioServerTransport();
		await this.server.connect(transport);

		// Keep process alive
		await new Promise(() => {});
	}

	/**
	 * Get the underlying Server instance for advanced use
	 */
	getServer(): Server {
		return this.server;
	}
}

/**
 * Convenience function to create a server
 */
export function createMcpServer(options: McpServerOptions): McpServer {
	return new McpServer(options);
}
