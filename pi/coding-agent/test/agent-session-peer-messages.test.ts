import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { MessageStore } from "@magenta/harness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

/**
 * Magenta feature: peer messaging wired into AgentSession. Verifies the tool
 * surfaces in the base tool list and that the mailbox is routed to the
 * session's agentDir so an independent peer handle interoperates.
 */
describe("AgentSession peer messaging", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-peermsg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function makeSession() {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
		});
		return session;
	}

	it("exposes send_message as a base tool with peer-messaging guidelines", async () => {
		const session = await makeSession();
		try {
			const tool = session.getAllTools().find((t) => t.name === "send_message");
			expect(tool).toBeDefined();
			expect(tool?.description).toContain("another agent session");
			expect(tool?.promptGuidelines?.some((g) => g.includes("send_message"))).toBe(true);
		} finally {
			await session.dispose();
		}
	});

	it("routes the mailbox to the session's agentDir so peers interoperate", async () => {
		const session = await makeSession();
		try {
			// A teammate writes to this session's id via an independent store on
			// the same agentDir path the session's controller uses.
			const dbPath = join(agentDir, "messages.db");
			const peerStore = new MessageStore(dbPath);
			try {
				peerStore.send("teammate-session", session.sessionId, "please review the parser change");
			} finally {
				peerStore.close();
			}

			// A fresh handle on the same path sees exactly that message for this session.
			const verify = new MessageStore(dbPath);
			try {
				const drained = verify.drainUnread(session.sessionId);
				expect(drained).toHaveLength(1);
				expect(drained[0].content).toBe("please review the parser change");
				expect(drained[0].sender).toBe("teammate-session");
			} finally {
				verify.close();
			}
		} finally {
			await session.dispose();
		}
	});

	it("keeps the default mailbox at the machine config root", async () => {
		const previousAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();

		let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
		try {
			session = (
				await createAgentSession({
					cwd: tempDir,
					model: getModel("anthropic", "claude-sonnet-4-5")!,
					settingsManager,
					sessionManager,
					resourceLoader,
				})
			).session;

			const peerStore = new MessageStore(join(tempDir, "messages.db"));
			try {
				peerStore.send("teammate-session", session.sessionId, "config-root delivery");
			} finally {
				peerStore.close();
			}

			const drained = (session as any)._peerMessages.drainForInjection();
			expect(drained).toHaveLength(1);
			expect(drained[0].content).toBe("config-root delivery");
		} finally {
			await session?.dispose();
			if (previousAgentDir === undefined) {
				delete process.env[ENV_AGENT_DIR];
			} else {
				process.env[ENV_AGENT_DIR] = previousAgentDir;
			}
		}
	});

	// Magenta feature: idle wake (state 3). When a host claims the turn-runner,
	// an idle wake must surface as an `external_activation` event (for the host to
	// run) rather than the session self-running the turn. This is the path the
	// interactive TUI uses so a wake never races its input loop.
	it("emits external_activation on idle wake when a host claims the turn-runner", async () => {
		const session = await makeSession();
		try {
			const release = session.claimExternalTurnRunner();
			const activations: Array<{ type: string; source?: string }> = [];
			const unsub = session.subscribe((event) => {
				if (event.type === "external_activation") {
					activations.push({ type: event.type, source: event.source });
				}
			});

			// A teammate leaves a message, then we fire the wake path directly (the
			// SIGUSR1 delivery is OS-level and covered separately; here we verify the
			// wake handler's routing).
			const dbPath = join(agentDir, "messages.db");
			const peerStore = new MessageStore(dbPath);
			try {
				peerStore.send("teammate-session", session.sessionId, "urgent: please look now", "urgent");
			} finally {
				peerStore.close();
			}

			// Invoke the wake path the signal handler would call.
			(session as any)._wakeForPeerMessages();

			expect(activations).toHaveLength(1);
			expect(activations[0]).toEqual({ type: "external_activation", source: "peer_wake" });

			// The payload must be appended to session state so a subsequent turn can
			// consume it without a fresh prompt.
			const messages = session.agent.state.messages;
			const last = messages[messages.length - 1];
			expect(last?.role).toBe("custom");
			expect((last as any).content).toContain("please look now");

			unsub();
			release();
		} finally {
			await session.dispose();
		}
	});

	it("coalesces peer wakes that arrive before the host starts the turn", async () => {
		const session = await makeSession();
		try {
			const release = session.claimExternalTurnRunner();
			const activations: string[] = [];
			const unsub = session.subscribe((event) => {
				if (event.type === "external_activation") activations.push(event.source);
			});
			const peerStore = new MessageStore(join(agentDir, "messages.db"));
			try {
				peerStore.send("one", session.sessionId, "first wake", "urgent");
				(session as any)._wakeForPeerMessages();
				peerStore.send("two", session.sessionId, "second wake", "urgent");
				(session as any)._wakeForPeerMessages();
			} finally {
				peerStore.close();
			}

			expect(activations).toEqual(["peer_wake"]);
			const peerPayloads = session.messages.filter(
				(message) => message.role === "custom" && message.customType === "magenta-peer-message",
			);
			expect(peerPayloads).toHaveLength(2);

			const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue(undefined);
			await session.runExternalActivation();
			await session.runExternalActivation();
			expect(continueSpy).toHaveBeenCalledTimes(1);

			unsub();
			release();
		} finally {
			await session.dispose();
		}
	});

	it("routes urgent peer messages as steer and normal messages as follow-up", async () => {
		const session = await makeSession();
		try {
			const peerStore = new MessageStore(join(agentDir, "messages.db"));
			try {
				peerStore.send("urgent-peer", session.sessionId, "interrupt soon", "urgent");
				peerStore.send("normal-peer", session.sessionId, "after the loop", "normal");
			} finally {
				peerStore.close();
			}

			const sendSpy = vi.spyOn(session, "sendCustomMessage").mockResolvedValue(undefined);
			await (session as any)._injectPeerMessages();

			expect(sendSpy).toHaveBeenCalledTimes(2);
			expect(sendSpy.mock.calls[0]?.[1]).toEqual({ deliverAs: "steer" });
			expect(sendSpy.mock.calls[1]?.[1]).toEqual({ deliverAs: "followUp" });
			expect((session as any)._peerMessages.drainForInjection()).toHaveLength(0);
		} finally {
			await session.dispose();
		}
	});

	// Fallback: with no host claiming the turn-runner (headless / sub-agent), an
	// idle wake must NOT emit external_activation — it self-runs instead.
	it("does not emit external_activation when no host claims the turn-runner", async () => {
		const session = await makeSession();
		try {
			const activations: string[] = [];
			const unsub = session.subscribe((event) => {
				if (event.type === "external_activation") activations.push(event.type);
			});

			const dbPath = join(agentDir, "messages.db");
			const peerStore = new MessageStore(dbPath);
			try {
				peerStore.send("teammate-session", session.sessionId, "headless wake", "urgent");
			} finally {
				peerStore.close();
			}

			// No claimExternalTurnRunner(): the wake self-runs a turn. We only assert
			// that it does NOT route through the host event; the self-run itself needs
			// a model and is covered by integration paths.
			try {
				(session as any)._wakeForPeerMessages();
			} catch {
				// self-run may throw without a real model; irrelevant to this assertion.
			}

			expect(activations).toHaveLength(0);

			unsub();
		} finally {
			await session.dispose();
		}
	});
});
