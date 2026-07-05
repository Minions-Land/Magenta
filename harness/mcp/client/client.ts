/**
 * MCP Client wrapper for Magenta3 harness
 *
 * Provides a simplified interface to connect to and interact with MCP servers.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult, Prompt, ReadResourceResult, Resource, Tool } from "@modelcontextprotocol/sdk/types.js";

export interface McpClientOptions {
	name?: string;
	version?: string;
}

export interface StdioTransportOptions {
	command: string;
	args?: string[];
	env?: Record<string, string>;
}

export interface SSETransportOptions {
	url: string;
	headers?: Record<string, string>;
}

export type TransportOptions = StdioTransportOptions | SSETransportOptions;

export class McpClient {
	private client: Client;
	private transport?: any; // Transport from SDK
	private connected: boolean = false;

	constructor(options: McpClientOptions = {}) {
		this.client = new Client(
			{
				name: options.name || "magenta-mcp-client",
				version: options.version || "1.0.0",
			},
			{
				capabilities: {
					roots: { listChanged: false },
					sampling: {},
				},
			},
		);
	}

	/**
	 * Connect to an MCP server
	 */
	async connect(transportOptions: TransportOptions): Promise<void> {
		if (this.connected) {
			throw new Error("Client is already connected");
		}

		// Create transport based on options
		if ("command" in transportOptions) {
			// stdio transport
			this.transport = new StdioClientTransport({
				command: transportOptions.command,
				args: transportOptions.args || [],
				env: transportOptions.env,
			});
		} else {
			// SSE transport
			this.transport = new SSEClientTransport(new URL(transportOptions.url), transportOptions.headers);
		}

		await this.client.connect(this.transport);
		this.connected = true;
	}

	/**
	 * List all available tools
	 */
	async listTools(): Promise<Tool[]> {
		this.ensureConnected();
		const response = await this.client.listTools();
		return response.tools;
	}

	/**
	 * Call a tool
	 */
	async callTool(name: string, args?: Record<string, unknown>): Promise<any> {
		this.ensureConnected();
		return await this.client.callTool({
			name,
			arguments: args,
		});
	}

	/**
	 * List all available resources
	 */
	async listResources(): Promise<Resource[]> {
		this.ensureConnected();
		const response = await this.client.listResources();
		return response.resources;
	}

	/**
	 * Read a resource
	 */
	async readResource(uri: string): Promise<ReadResourceResult> {
		this.ensureConnected();
		return await this.client.readResource({ uri });
	}

	/**
	 * List all available prompts
	 */
	async listPrompts(): Promise<Prompt[]> {
		this.ensureConnected();
		const response = await this.client.listPrompts();
		return response.prompts;
	}

	/**
	 * Get a prompt
	 */
	async getPrompt(name: string, args?: Record<string, string>) {
		this.ensureConnected();
		return await this.client.getPrompt({
			name,
			arguments: args as any,
		});
	}

	/**
	 * Close the connection
	 */
	async close(): Promise<void> {
		if (this.connected) {
			await this.client.close();
			this.connected = false;
		}
	}

	/**
	 * Check if connected
	 */
	isConnected(): boolean {
		return this.connected;
	}

	private ensureConnected(): void {
		if (!this.connected) {
			throw new Error("Client is not connected. Call connect() first.");
		}
	}
}

/**
 * Convenience function to create and connect a client
 */
export async function connectMcpClient(
	transportOptions: TransportOptions,
	clientOptions?: McpClientOptions,
): Promise<McpClient> {
	const client = new McpClient(clientOptions);
	await client.connect(transportOptions);
	return client;
}
