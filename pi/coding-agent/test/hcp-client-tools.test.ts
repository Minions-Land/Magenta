import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { HcpClientbuildsession, type SshToolOperations } from "@magenta/harness";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { HcpClientassembletools } from "../src/core/HcpClienttools.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("HcpClient host tool assembly", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("explicitly assembles core tools and injects SSH operations plus shell settings", async () => {
		const root = join(tmpdir(), `hcp-client-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		roots.push(root);

		const settingsManager = SettingsManager.create(root, agentDir);
		settingsManager.setShellCommandPrefix("source ~/.profile");
		let executedCommand = "";
		const sshOperations: SshToolOperations = {
			read: {
				access: async () => {},
				readFile: async () => Buffer.from("remote contents"),
			},
			bash: {
				exec: async (command, _cwd, options) => {
					executedCommand = command;
					options.onData(Buffer.from("remote shell"));
					return { exitCode: 0 };
				},
			},
			edit: {
				access: async () => {},
				readFile: async () => Buffer.from("before"),
				writeFile: async () => {},
			},
			write: {
				mkdir: async () => {},
				writeFile: async () => {},
			},
		};
		const { hcp } = await HcpClientbuildsession({ repoRoot: root });

		const sessionManager = SessionManager.inMemory(root);
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "todo-history",
			toolName: "todo",
			content: [{ type: "text", text: "historical todo" }],
			details: {
				action: "add",
				todos: [{ id: 7, text: "From this branch", done: false }],
				nextId: 8,
			},
			isError: false,
			timestamp: Date.now(),
		});

		await HcpClientassembletools({ hcp, cwd: root, settingsManager, sessionManager, sshOperations });

		for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls", "lsp", "show", "todo"]) {
			expect(hcp.resolveInstance(`tool:${name}`), `tool:${name}`).toBeDefined();
		}
		expect(hcp.resolveInstance("tool:tool-search")).toBeUndefined();
		const read = hcp.resolveInstance<AgentTool>("tool:read")!;
		await expect(read.execute("read-1", { path: "remote.txt" })).resolves.toMatchObject({
			content: [{ type: "text", text: "remote contents" }],
		});
		const bash = hcp.resolveInstance<AgentTool>("tool:bash")!;
		await expect(bash.execute("bash-1", { command: "pwd" })).resolves.toMatchObject({
			content: [{ type: "text", text: "remote shell" }],
		});
		expect(executedCommand).toBe("source ~/.profile\npwd");
		const todo = hcp.resolveInstance<AgentTool>("tool:todo")!;
		await expect(todo.execute("todo-1", { action: "list" })).resolves.toMatchObject({
			content: [{ type: "text", text: "7. [ ] From this branch" }],
			details: { nextId: 8 },
		});
	});

	it("fills missing defaults without replacing a Package-owned tool address", async () => {
		const root = join(tmpdir(), `hcp-client-tools-package-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		roots.push(root);

		const settingsManager = SettingsManager.create(root, agentDir);
		const { hcp } = await HcpClientbuildsession({ repoRoot: root });
		const packageRead: AgentTool = {
			name: "read",
			label: "Read",
			description: "Package-owned read tool",
			parameters: Type.Any(),
			execute: async () => ({ content: [{ type: "text" as const, text: "package read" }], details: {} }),
		};
		const tools = hcp.resolveModule("tools")!;
		hcp.registerModule(
			tools,
			new Map([["tool:read", { kind: "tool:package", source: "package", toTool: () => packageRead }]]),
			{ merge: true, override: true },
		);

		await HcpClientassembletools({ hcp, cwd: root, settingsManager });

		expect(hcp.resolveInstance("tool:read")).toBe(packageRead);
		expect(hcp.resolveInstance("tool:bash")).toBeDefined();
		await hcp.dispose();
	});

	it("assembles session-aware tools once after ResourceLoader creates the session Client", async () => {
		const root = join(tmpdir(), `hcp-client-tools-loader-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		roots.push(root);

		const settingsManager = SettingsManager.create(root, agentDir);
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir,
			settingsManager,
			includeBundledResources: false,
		});
		await loader.reload();
		const hcp = loader.HcpClientgetsession()!;
		expect(hcp.resolveInstance("tool:read")).toBeUndefined();

		const sessionManager = SessionManager.inMemory(root);
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "todo-history",
			toolName: "todo",
			content: [{ type: "text", text: "historical todo" }],
			details: {
				action: "add",
				todos: [{ id: 9, text: "Restored after loader reload", done: false }],
				nextId: 10,
			},
			isError: false,
			timestamp: Date.now(),
		});
		const sshOperations: SshToolOperations = {
			read: {
				access: async () => {},
				readFile: async () => Buffer.from("remote after reload"),
			},
			bash: {
				exec: async (_command, _cwd, options) => {
					options.onData(Buffer.from("remote shell after reload"));
					return { exitCode: 0 };
				},
			},
			edit: {
				access: async () => {},
				readFile: async () => Buffer.from("before"),
				writeFile: async () => {},
			},
			write: {
				mkdir: async () => {},
				writeFile: async () => {},
			},
		};

		await HcpClientassembletools({ hcp, cwd: root, settingsManager, sessionManager, sshOperations });

		const read = hcp.resolveInstance<AgentTool>("tool:read")!;
		await expect(read.execute("read-after-reload", { path: "remote.txt" })).resolves.toMatchObject({
			content: [{ type: "text", text: "remote after reload" }],
		});
		const todo = hcp.resolveInstance<AgentTool>("tool:todo")!;
		await expect(todo.execute("todo-after-reload", { action: "list" })).resolves.toMatchObject({
			content: [{ type: "text", text: "9. [ ] Restored after loader reload" }],
			details: { nextId: 10 },
		});
		await loader.dispose();
	});
});
