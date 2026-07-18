import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { HcpMagnet as MultiagentMagnet } from "../tools/multiagent/magenta/HcpMagnet.ts";
import type { CreateChildSessionRequest, MultiagentSpawn } from "../tools/multiagent/magenta/multiagent.ts";
import { HcpMagnet as SendMessageMagnet } from "../tools/send-message/magenta/HcpMagnet.ts";
import type { MailboxSupport, SendMessageRuntime } from "../tools/send-message/magenta/runtime.ts";
import { HcpMagnet as SubAgentMagnet } from "../tools/sub-agent/magenta/HcpMagnet.ts";

function backgroundPort() {
	return {
		registerSource: () => ({ update: () => {}, dispose: () => {} }),
	};
}

function fakeRpcSpawn(): MultiagentSpawn {
	return (_command: string, args: string[], _options: SpawnOptions) => {
		const child = new EventEmitter() as ChildProcess & {
			stdin: PassThrough;
			stdout: PassThrough;
			stderr: PassThrough;
		};
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		Object.assign(child, { stdin, stdout, stderr, pid: 91000, exitCode: null, signalCode: null });
		let closed = false;
		const close = () => {
			if (closed) return;
			closed = true;
			Object.assign(child, { exitCode: 0 });
			queueMicrotask(() => child.emit("close", 0, null));
		};
		child.kill = () => {
			close();
			return true;
		};
		const sessionFile = args[args.indexOf("--session") + 1]!;
		const sessionId = sessionFile.slice(sessionFile.lastIndexOf("/") + 1, -".jsonl".length);
		stdin.on("data", (chunk: Buffer) => {
			for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
				const request = JSON.parse(line) as { id: string; type: string };
				queueMicrotask(() =>
					stdout.write(
						`${JSON.stringify({
							id: request.id,
							type: "response",
							success: true,
							...(request.type === "get_state" ? { data: { sessionId, isStreaming: false } } : {}),
						})}\n`,
					),
				);
			}
		});
		stdin.once("finish", close);
		return child;
	};
}

describe("stateful HCP Tool Magnet lifecycle", () => {
	let root: string;

	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
	});

	it("disposes send_message, multiagent, and sub_agent independently and idempotently", async () => {
		root = join(tmpdir(), `hcp-stateful-lifecycle-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		const parentFile = join(root, "main.jsonl");
		writeFileSync(parentFile, `${JSON.stringify({ type: "session", version: 3, id: "main-session", cwd: root })}\n`);
		let mailbox!: SendMessageRuntime;
		const send = new SendMessageMagnet({
			dbPath: join(root, "messages.db"),
			getSessionId: () => "main-session",
			onRuntime: (runtime) => {
				mailbox = runtime;
			},
		});
		const subAgent = new SubAgentMagnet({
			cwd: root,
			workDirRoot: join(root, "sub-agents"),
			backgroundEvents: backgroundPort(),
			resolveAgentInvocation: (args) => ({ command: "/magenta", args }),
			registerReturn: () => {},
			cancelReturn: () => {},
		});
		let ids = 0;
		const multiagent = new MultiagentMagnet({
			cwd: root,
			agentDir: join(root, "agent"),
			peerMessageDbPath: join(root, "messages.db"),
			registryPath: join(root, "multiagent.json"),
			parentSessionId: "main-session",
			parentSessionFile: parentFile,
			backgroundEvents: backgroundPort(),
			resolveAgentInvocation: (args) => ({ command: "/magenta", args }),
			createSessionId: () => `session-${++ids}`,
			createChildSession: async (request: CreateChildSessionRequest) => {
				const sessionFile = join(root, `${request.sessionId}.jsonl`);
				writeFileSync(
					sessionFile,
					`${[
						JSON.stringify({
							type: "session",
							version: 3,
							id: request.sessionId,
							cwd: request.cwd,
							parentSession: request.parentSessionFile,
						}),
						JSON.stringify({
							type: "custom_message",
							customType: request.identityCustomType,
							details: request.identityDetails,
						}),
					].join("\n")}\n`,
				);
				return { sessionFile };
			},
			getMailboxSupport: () => mailbox as MailboxSupport,
			spawnAgent: fakeRpcSpawn(),
		});
		await multiagent.toTool().execute("start", { action: "start", message: "bootstrap" });
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(() => send.dispose()).not.toThrow();
		expect(() => send.dispose()).not.toThrow();
		await expect(Promise.all([multiagent.dispose(), multiagent.dispose()])).resolves.toEqual([undefined, undefined]);
		expect(() => subAgent.dispose()).not.toThrow();
		expect(() => subAgent.dispose()).not.toThrow();
	});
});
