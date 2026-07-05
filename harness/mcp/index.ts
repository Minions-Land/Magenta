/**
 * MCP Integration for Magenta3 Harness
 *
 * This module provides Model Context Protocol (MCP) support for the Magenta3 harness.
 *
 * @module @magenta/harness-mcp
 */

// Re-export commonly used types from the SDK
export type {
	CallToolResult,
	EmbeddedResource,
	ImageContent,
	Prompt,
	ReadResourceResult,
	Resource,
	TextContent,
	Tool,
} from "@modelcontextprotocol/sdk/types.js";
export type {
	McpClientOptions,
	SSETransportOptions,
	StdioTransportOptions,
	TransportOptions,
} from "./client/client.js";
// Client exports
export { connectMcpClient, McpClient } from "./client/client.js";
export type {
	McpServerOptions,
	PromptDefinition,
	PromptHandler,
	ResourceDefinition,
	ResourceHandler,
	ToolDefinition,
	ToolHandler,
} from "./server/server.js";
// Server exports
export { createMcpServer, McpServer } from "./server/server.js";
