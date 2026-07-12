import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

function writeHarnessPackageFixture(repoRoot: string): void {
	const packageDir = join(repoRoot, "packages", "TestDomain");
	const harnessDir = join(packageDir, "harness");
	const toolDir = join(harnessDir, "tools");
	mkdirSync(toolDir, { recursive: true });
	writeFileSync(
		join(packageDir, "package.toml"),
		`schema_version = "magenta.package.v1"
id = "TestDomain"
name = "Test Domain"
default_profiles = ["general"]

[[profiles]]
name = "general"
harness = "harness/harness.toml"
`,
	);
	writeFileSync(
		join(harnessDir, "harness.toml"),
		`[[components]]
kind = "tool"
name = "test_package_tool"
path = "tools/test-package-tool.toml"
`,
	);
	writeFileSync(
		join(toolDir, "test-package-tool.toml"),
		`kind = "tool"
name = "test_package_tool"
description = "Echo a package tool input."
runtime = "process"
command = "node"
args = ["-e", "process.stdin.pipe(process.stdout)"]
operation = "execute"
read_only = true
destructive = false

[parameters]
type = "object"
additionalProperties = true
`,
	);
}

function writeUserMcpFixture(agentDir: string): void {
	const serverPath = join(agentDir, "dynamic-mcp.cjs");
	writeFileSync(
		serverPath,
		`const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send(message.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} } });
  if (message.method === "tools/list") {
    send(message.id, { tools: [{ name: "ping", description: "Dynamic MCP ping", inputSchema: { type: "object" } }] });
  }
});
`,
	);
	writeFileSync(
		join(agentDir, "mcp-servers.json"),
		JSON.stringify({
			servers: [{ name: "dynamic", command: process.execPath, args: [serverPath], name_prefix: "user" }],
		}),
	);
}

describe("AgentSession dynamic tool registration", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-dynamic-tool-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("refreshes tool registry when tools are registered after initialization", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();

		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						pi.registerTool({
							name: "dynamic_tool",
							label: "Dynamic Tool",
							description: "Tool registered from session_start",
							promptSnippet: "Run dynamic test behavior",
							promptGuidelines: ["Use dynamic_tool when the user asks for dynamic behavior tests."],
							parameters: Type.Object({}),
							execute: async () => ({
								content: [{ type: "text", text: "ok" }],
								details: {},
							}),
						});
					});
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		expect(session.getAllTools().map((tool) => tool.name)).not.toContain("dynamic_tool");

		await session.bindExtensions({});

		const allTools = session.getAllTools();
		const dynamicTool = allTools.find((tool) => tool.name === "dynamic_tool");
		const readTool = allTools.find((tool) => tool.name === "read");

		expect(allTools.map((tool) => tool.name)).toContain("dynamic_tool");
		expect(dynamicTool?.promptGuidelines).toEqual([
			"Use dynamic_tool when the user asks for dynamic behavior tests.",
		]);
		expect(dynamicTool?.sourceInfo).toMatchObject({
			path: "<inline:1>",
			source: "inline",
			scope: "temporary",
			origin: "top-level",
		});
		expect(readTool?.sourceInfo).toMatchObject({
			path: "<hcp:pi:read>",
			source: "pi",
			scope: "temporary",
			origin: "top-level",
		});
		expect(session.getActiveToolNames()).toContain("dynamic_tool");
		expect(session.systemPrompt).toContain("- dynamic_tool: Run dynamic test behavior");
		expect(session.systemPrompt).toContain("- Use dynamic_tool when the user asks for dynamic behavior tests.");

		await session.dispose();
	});

	it("returns source metadata for SDK custom tools", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
			customTools: [
				{
					name: "sdk_tool",
					label: "SDK Tool",
					description: "Tool registered through createAgentSession",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text", text: "ok" }],
						details: {},
					}),
				},
			],
		});

		const sdkTool = session.getAllTools().find((tool) => tool.name === "sdk_tool");
		expect(sdkTool?.sourceInfo).toMatchObject({
			path: "<sdk:sdk_tool>",
			source: "sdk",
			scope: "temporary",
			origin: "top-level",
		});
		expect(session.getActiveToolNames()).toContain("sdk_tool");

		await session.dispose();
	});

	it("registers selected harness package tools and enables them by default", async () => {
		writeHarnessPackageFixture(tempDir);
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			harnessPackages: ["TestDomain"],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		const packageTool = session.getAllTools().find((tool) => tool.name === "test_package_tool");
		expect(packageTool?.sourceInfo).toMatchObject({
			path: "<harness-package:test_package_tool>",
			source: "harness-package",
			scope: "temporary",
			origin: "package",
		});
		expect(session.getActiveToolNames()).toContain("test_package_tool");

		await session.dispose();
	});

	it("keeps explicit Package and user MCP tools active when built-in defaults are disabled", async () => {
		writeHarnessPackageFixture(tempDir);
		writeUserMcpFixture(agentDir);
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			harnessPackages: ["TestDomain"],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
			noTools: "builtin",
		});

		expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["test_package_tool", "user_ping"]));
		expect(session.getActiveToolNames()).not.toContain("read");
		expect(session.getActiveToolNames()).not.toContain("web-search");

		await session.dispose();
	});

	it("reloads runtime harness package tool selections", async () => {
		writeHarnessPackageFixture(tempDir);
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		expect(session.getAllTools().map((tool) => tool.name)).not.toContain("test_package_tool");

		resourceLoader.HcpClientsetharnesspackageselectors(["TestDomain"]);
		await session.reload();

		expect(session.getAllTools().map((tool) => tool.name)).toContain("test_package_tool");
		expect(session.getActiveToolNames()).toContain("test_package_tool");

		resourceLoader.HcpClientsetharnesspackageselectors([]);
		await session.reload();

		expect(session.getAllTools().map((tool) => tool.name)).not.toContain("test_package_tool");
		expect(session.getActiveToolNames()).not.toContain("test_package_tool");

		await session.dispose();
	});

	it("activates user MCP tools added during reload", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
		});
		expect(session.getAllTools().map((tool) => tool.name)).not.toContain("user_ping");

		writeUserMcpFixture(agentDir);
		await session.reload();

		const userTool = session.getAllTools().find((tool) => tool.name === "user_ping");
		expect(userTool?.sourceInfo).toMatchObject({
			path: "<user-mcp:user_ping>",
			source: "user-mcp",
			origin: "top-level",
		});
		expect(session.getActiveToolNames()).toContain("user_ping");
		await session.dispose();
	});

	it("preserves explicit tool disablement while activating only newly loaded tools", async () => {
		writeHarnessPackageFixture(tempDir);
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			harnessPackages: ["TestDomain"],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		session.setActiveToolsByName(
			session.getActiveToolNames().filter((name) => name !== "test_package_tool" && name !== "web-search"),
		);
		writeUserMcpFixture(agentDir);
		await session.reload();

		expect(session.getActiveToolNames()).not.toContain("test_package_tool");
		expect(session.getActiveToolNames()).not.toContain("web-search");
		expect(session.getActiveToolNames()).toContain("user_ping");
		await session.dispose();
	});

	it("keeps custom tools active but omits them from available tools when promptSnippet is not provided", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();

		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						pi.registerTool({
							name: "hidden_tool",
							label: "Hidden Tool",
							description: "Description should not appear in available tools",
							parameters: Type.Object({}),
							execute: async () => ({
								content: [{ type: "text", text: "ok" }],
								details: {},
							}),
						});
					});
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		await session.bindExtensions({});

		expect(session.getAllTools().map((tool) => tool.name)).toContain("hidden_tool");
		expect(session.getActiveToolNames()).toContain("hidden_tool");
		expect(session.systemPrompt).not.toContain("hidden_tool");
		expect(session.systemPrompt).not.toContain("Description should not appear in available tools");

		await session.dispose();
	});
});
