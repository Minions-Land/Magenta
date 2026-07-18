import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	HcpClientbuildsession,
	MAIN_TODO_SESSION_FILE_ENV,
	type SshToolOperations,
	type TodoPlanState,
} from "@magenta/harness";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HcpClientassembletools, loadTodoPlanStateFromBranch } from "../src/core/HcpClienttools.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("HcpClient host tool assembly", () => {
	const roots: string[] = [];

	afterEach(() => {
		vi.unstubAllEnvs();
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
		const todoState: TodoPlanState = {
			version: 2,
			title: "Branch plan",
			summary: null,
			currentId: 7,
			nodes: [{ id: 7, parentId: null, order: 0, text: "From this branch", status: "in_progress" }],
			nextId: 8,
			revision: 2,
			history: [
				{
					title: "Archived branch plan",
					summary: null,
					currentId: 1,
					nodes: [{ id: 1, parentId: null, order: 0, text: "Earlier work", status: "completed" }],
				},
			],
		};
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "todo-history",
			toolName: "todo",
			content: [{ type: "text", text: "historical todo" }],
			details: { action: "apply", state: todoState, applied: 1, changes: {}, refs: {} },
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
		await expect(todo.execute("todo-1", { action: "get" })).resolves.toMatchObject({
			content: [{ type: "text", text: expect.stringContaining("From this branch") }],
			details: { state: todoState },
		});
	});

	it("projects the latest persisted Main Todo read-only into a teammate assembly", async () => {
		const root = join(tmpdir(), `hcp-client-tools-main-todo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const agentDir = join(root, "agent");
		const sessionDir = join(root, "sessions");
		mkdirSync(agentDir, { recursive: true });
		roots.push(root);
		const parent = SessionManager.create(root, sessionDir, { id: "main-session" });
		const state = (text: string, revision: number): TodoPlanState => ({
			version: 2,
			title: "Main plan",
			summary: null,
			currentId: 1,
			nodes: [{ id: 1, parentId: null, order: 0, text, status: "in_progress" }],
			nextId: 2,
			revision,
			history: [],
		});
		const appendTodo = (snapshot: TodoPlanState) => {
			parent.appendMessage({
				role: "toolResult",
				toolCallId: `todo-${snapshot.revision}`,
				toolName: "todo",
				content: [{ type: "text", text: "persisted" }],
				details: { action: "apply", state: snapshot, applied: 1, changes: {}, refs: {} },
				isError: false,
				timestamp: Date.now(),
			});
			parent.flush();
		};
		appendTodo(state("Initial Main item", 1));
		const parentFile = parent.getSessionFile()!;
		vi.stubEnv(MAIN_TODO_SESSION_FILE_ENV, parentFile);
		const settingsManager = SettingsManager.create(root, agentDir);
		const { hcp } = await HcpClientbuildsession({ repoRoot: root });
		await HcpClientassembletools({
			hcp,
			cwd: root,
			settingsManager,
			sessionManager: SessionManager.inMemory(root),
		});
		const todo = hcp.resolveInstance<AgentTool>("tool:todo")!;
		await expect(todo.execute("get-initial", { action: "get" })).resolves.toMatchObject({
			content: [{ type: "text", text: expect.stringContaining("Initial Main item") }],
		});
		await expect(
			todo.execute("mutate-denied", { action: "apply", operations: [{ op: "add", text: "unauthorized" }] }),
		).rejects.toMatchObject({
			details: { code: "unauthorized" },
		});
		appendTodo(state("Updated Main item", 2));
		await expect(todo.execute("get-updated", { action: "get" })).resolves.toMatchObject({
			content: [{ type: "text", text: expect.stringContaining("Updated Main item") }],
		});
		await hcp.dispose();
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
		const todoState: TodoPlanState = {
			version: 2,
			title: "Reloaded plan",
			summary: "restored",
			currentId: null,
			nodes: [{ id: 9, parentId: null, order: 0, text: "Restored after loader reload", status: "pending" }],
			nextId: 10,
			revision: 4,
			history: [],
		};
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "todo-history",
			toolName: "todo",
			content: [{ type: "text", text: "historical todo" }],
			details: { action: "apply", state: todoState, applied: 1, changes: {}, refs: {} },
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
		await expect(todo.execute("todo-after-reload", { action: "get" })).resolves.toMatchObject({
			content: [{ type: "text", text: expect.stringContaining("Restored after loader reload") }],
			details: { state: todoState },
		});
		await loader.dispose();
	});

	it("migrates the latest valid version-1 snapshot across malformed and compaction entries", () => {
		const root = join(tmpdir(), `hcp-client-tools-state-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		roots.push(root);
		const sessionManager = SessionManager.inMemory(root);
		const legacyState = {
			version: 1,
			title: "Compaction-safe",
			summary: null,
			currentId: 1,
			nodes: [{ id: 1, parentId: null, order: 0, text: "Keep state", status: "in_progress" }],
			nextId: 2,
			revision: 1,
		};
		const todoEntryId = sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "todo-valid",
			toolName: "todo",
			content: [{ type: "text", text: "valid" }],
			details: { action: "apply", state: legacyState, applied: 1, changes: {}, refs: {} },
			isError: false,
			timestamp: Date.now(),
		});
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "todo-malformed",
			toolName: "todo",
			content: [{ type: "text", text: "malformed" }],
			details: { action: "add", todos: [{ id: 99, text: "ignored", done: false }], nextId: 100 },
			isError: false,
			timestamp: Date.now(),
		});
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "todo-invalid-history",
			toolName: "todo",
			content: [{ type: "text", text: "invalid history" }],
			details: {
				state: {
					...legacyState,
					version: 2,
					history: [
						{
							title: "Not completed",
							summary: null,
							currentId: 1,
							nodes: legacyState.nodes,
						},
					],
				},
			},
			isError: false,
			timestamp: Date.now(),
		});
		sessionManager.appendCompaction("summary", todoEntryId, 1000);

		const migrated = { ...legacyState, version: 2 as const, history: [] };
		expect(loadTodoPlanStateFromBranch(sessionManager)).toEqual(migrated);
		const cloned = loadTodoPlanStateFromBranch(sessionManager)!;
		cloned.nodes[0]!.text = "mutated clone";
		expect(loadTodoPlanStateFromBranch(sessionManager)?.nodes[0]?.text).toBe("Keep state");
	});

	it("restores independent Todo histories from divergent session branches", () => {
		const root = join(tmpdir(), `hcp-client-tools-branches-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		roots.push(root);
		const sessionManager = SessionManager.inMemory(root);
		const appendState = (toolCallId: string, state: TodoPlanState) =>
			sessionManager.appendMessage({
				role: "toolResult",
				toolCallId,
				toolName: "todo",
				content: [{ type: "text", text: state.title }],
				details: { action: "apply", state, applied: 1, changes: {}, refs: {} },
				isError: false,
				timestamp: Date.now(),
			});
		const common: TodoPlanState = {
			version: 2,
			title: "Common",
			summary: null,
			currentId: 1,
			nodes: [{ id: 1, parentId: null, order: 0, text: "Shared", status: "in_progress" }],
			nextId: 2,
			revision: 1,
			history: [],
		};
		const commonId = appendState("todo-common", common);
		const branchState = (title: string): TodoPlanState => ({
			version: 2,
			title: "Todo",
			summary: null,
			currentId: null,
			nodes: [],
			nextId: 2,
			revision: 2,
			history: [
				{
					title,
					summary: null,
					currentId: 1,
					nodes: [{ id: 1, parentId: null, order: 0, text: title, status: "completed" }],
				},
			],
		});

		const branchA = branchState("Branch A archive");
		const branchAId = appendState("todo-branch-a", branchA);
		sessionManager.branch(commonId);
		const branchB = branchState("Branch B archive");
		const branchBId = appendState("todo-branch-b", branchB);

		expect(loadTodoPlanStateFromBranch(sessionManager)).toEqual(branchB);
		sessionManager.branch(branchAId);
		expect(loadTodoPlanStateFromBranch(sessionManager)).toEqual(branchA);
		sessionManager.branch(branchBId);
		const cloned = loadTodoPlanStateFromBranch(sessionManager)!;
		cloned.history[0]!.nodes[0]!.text = "mutated clone";
		expect(loadTodoPlanStateFromBranch(sessionManager)?.history[0]?.nodes[0]?.text).toBe("Branch B archive");
	});
});
