#!/usr/bin/env node
/**
 * Simple MCP Client Example
 * 
 * Run with: node examples/simple-client.js
 */

import { connectMcpClient } from "../dist/index.js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
  console.log("Connecting to MCP server...\n");

  // Connect to the server
  const client = await connectMcpClient({
    command: "node",
    args: [join(__dirname, "simple-server.js")]
  });

  console.log("✓ Connected to server\n");

  try {
    // List tools
    console.log("=== Tools ===");
    const tools = await client.listTools();
    console.log(`Available tools: ${tools.length}`);
    for (const tool of tools) {
      console.log(`  - ${tool.name}: ${tool.description}`);
    }
    console.log();

    // Call echo tool
    console.log("Calling tool: echo");
    const echoResult = await client.callTool("echo", {
      message: "Hello from MCP client!"
    });
    console.log("  Result:", echoResult.content[0].text);
    console.log();

    // Call reverse tool
    console.log("Calling tool: reverse");
    const reverseResult = await client.callTool("reverse", {
      text: "MCP is awesome"
    });
    console.log("  Result:", reverseResult.content[0].text);
    console.log();

    // List resources
    console.log("=== Resources ===");
    const resources = await client.listResources();
    console.log(`Available resources: ${resources.length}`);
    for (const resource of resources) {
      console.log(`  - ${resource.uri}: ${resource.name}`);
    }
    console.log();

    // Read resource
    if (resources.length > 0) {
      const uri = resources[0].uri;
      console.log(`Reading resource: ${uri}`);
      const resourceContent = await client.readResource(uri);
      console.log("  Content:");
      console.log(resourceContent.contents[0].text);
      console.log();
    }

    // List prompts
    console.log("=== Prompts ===");
    const prompts = await client.listPrompts();
    console.log(`Available prompts: ${prompts.length}`);
    for (const prompt of prompts) {
      console.log(`  - ${prompt.name}: ${prompt.description}`);
    }
    console.log();

    // Get prompt (informal)
    if (prompts.length > 0) {
      console.log("Getting prompt: greet (formal=false)");
      const prompt1 = await client.getPrompt("greet", {
        name: "World",
        formal: "false"
      });
      console.log(`  Messages: ${prompt1.messages.length}`);
      for (const msg of prompt1.messages) {
        console.log(`    Role: ${msg.role}`);
        console.log(`    Content: ${msg.content.text}`);
      }
      console.log();

      // Get prompt (formal)
      console.log("Getting prompt: greet (formal=true)");
      const prompt2 = await client.getPrompt("greet", {
        name: "World",
        formal: "true"
      });
      for (const msg of prompt2.messages) {
        console.log(`    Role: ${msg.role}`);
        console.log(`    Content: ${msg.content.text}`);
      }
      console.log();
    }

    console.log("✓ All operations completed successfully!");

  } finally {
    // Clean up
    await client.close();
    console.log("\n✓ Connection closed");
  }
}

main().catch(console.error);
