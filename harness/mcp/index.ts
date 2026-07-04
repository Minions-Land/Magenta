/**
 * MCP Integration for Magenta3 Harness
 * 
 * This module provides Model Context Protocol (MCP) support for the Magenta3 harness.
 * 
 * @module @magenta/harness-mcp
 */

// Client exports
export { McpClient, connectMcpClient } from "./client/client.js";
export type {
  McpClientOptions,
  StdioTransportOptions,
  SSETransportOptions,
  TransportOptions
} from "./client/client.js";

// Server exports
export { McpServer, createMcpServer } from "./server/server.js";
export type {
  McpServerOptions,
  ToolDefinition,
  ToolHandler,
  ResourceDefinition,
  ResourceHandler,
  PromptDefinition,
  PromptHandler
} from "./server/server.js";

// Re-export commonly used types from the SDK
export type {
  Tool,
  Resource,
  Prompt,
  TextContent,
  ImageContent,
  EmbeddedResource,
  CallToolResult,
  ReadResourceResult
} from "@modelcontextprotocol/sdk/types.js";
