#!/usr/bin/env node
/**
 * Simple MCP Server Example
 * 
 * Run with: node examples/simple-server.js
 */

import { createMcpServer } from "../dist/index.js";

const server = createMcpServer({
  name: "example-server",
  version: "1.0.0"
});

// Register echo tool
server.registerTool(
  {
    name: "echo",
    description: "Echo back the input message",
    inputSchema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "Message to echo"
        }
      },
      required: ["message"]
    }
  },
  async (args) => {
    return [
      {
        type: "text",
        text: `Echo: ${args.message}`
      }
    ];
  }
);

// Register reverse tool
server.registerTool(
  {
    name: "reverse",
    description: "Reverse a string",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Text to reverse"
        }
      },
      required: ["text"]
    }
  },
  async (args) => {
    const reversed = String(args.text).split("").reverse().join("");
    return [
      {
        type: "text",
        text: reversed
      }
    ];
  }
);

// Register a resource
server.registerResource(
  {
    uri: "config://server",
    name: "Server Configuration",
    description: "Current server configuration",
    mimeType: "application/json"
  },
  async (uri) => {
    const config = {
      name: "example-server",
      version: "1.0.0",
      capabilities: ["tools", "resources", "prompts"]
    };
    return [
      {
        uri: uri,
        type: "text",
        text: JSON.stringify(config, null, 2),
        mimeType: "application/json"
      }
    ];
  }
);

// Register a prompt
server.registerPrompt(
  {
    name: "greet",
    description: "Generate a greeting message",
    arguments: [
      {
        name: "name",
        description: "Name of person to greet",
        required: true
      },
      {
        name: "formal",
        description: "Use formal greeting",
        required: false
      }
    ]
  },
  async (args) => {
    const name = args.name || "there";
    const formal = args.formal === "true" || args.formal === true;
    
    const greeting = formal
      ? `Good day, ${name}. How may I assist you today?`
      : `Hey ${name}! What's up?`;
    
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: greeting
          }
        }
      ]
    };
  }
);

console.error("Starting MCP server...");
console.error("Server capabilities:");
console.error("  - Tools: echo, reverse");
console.error("  - Resources: config://server");
console.error("  - Prompts: greet");
console.error("\nListening on stdio...\n");

// Start server
await server.run();
