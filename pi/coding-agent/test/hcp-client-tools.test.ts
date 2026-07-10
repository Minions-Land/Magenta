import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { HcpClientbuildsession, type SshToolOperations } from "@magenta/harness";
import { afterEach, describe, expect, it } from "vitest";
import { HcpClientassembletools } from "../src/core/HcpClienttools.ts";
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

		for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls", "show", "todo"]) {
			expect(hcp.resolveInstance(`tool:${name}`), `tool:${name}`).toBeDefined();
		}
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
});
