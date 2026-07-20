import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getModel, type Model } from "@earendil-works/pi-ai/compat";
import { MessageStore } from "@magenta/harness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";

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

	async function makeSession(thinkingLevel?: "medium" | "ultra") {
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
			executionProfile: thinkingLevel,
		});
		return session;
	}

	async function flushExternalActivations(session: Awaited<ReturnType<typeof makeSession>>): Promise<void> {
		await (session as any)._externalActivations.flushReady();
	}

	it("exposes send_message as a base tool with peer-messaging guidelines", async () => {
		const session = await makeSession();
		try {
			const tool = session.getAllTools().find((t) => t.name === "send_message");
			expect(tool).toBeDefined();
			expect(tool?.description).toContain("durable urgent plain-text message");
			expect(tool?.description).toContain("Acceptance does not imply recipient consumption");
			expect(tool?.promptGuidelines?.some((guideline) => guideline.includes("cross-Session"))).toBe(true);
		} finally {
			await session.dispose();
		}
	});

	it("gates multiagent by execution profile", async () => {
		const standard = await makeSession("medium");
		try {
			expect(standard.getAllTools().some((tool) => tool.name === "multiagent")).toBe(false);
		} finally {
			await standard.dispose();
		}

		const ultra = await makeSession("ultra");
		try {
			const tool = ultra.getAllTools().find((candidate) => candidate.name === "multiagent");
			expect(tool).toBeDefined();
			expect(tool?.description).toContain("persistent teammate Sessions by Session id");
			expect(tool?.description).toContain("durable and acknowledged without waiting");
			const properties = (tool?.parameters as any).properties;
			expect(JSON.stringify(properties.action)).not.toContain('"wait"');
			expect(properties.teammateId).toBeUndefined();
			expect(properties.assignmentId).toBeUndefined();
			expect(properties.waitTimeoutSeconds).toBeUndefined();
			expect(tool?.promptGuidelines?.some((guideline) => guideline.includes("send_message"))).toBe(true);
			expect(ultra.executionProfile).toBe("ultra");
			expect(ultra.thinkingLevel).not.toBe("ultra");
		} finally {
			await ultra.dispose();
		}
	});

	it("restores Ultra independently from the mapped native level", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();
		const model: Model<any> = {
			id: "ultra-resume-test",
			name: "Ultra Resume Test",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://example.invalid",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 8_192,
		};
		const sessionManager = SessionManager.inMemory(tempDir);
		sessionManager.appendModelChange(model.provider, model.id);
		sessionManager.appendThinkingLevelChange("ultra");
		sessionManager.appendMessage({ role: "user", content: "resume me", timestamp: Date.now() });

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model,
			settingsManager,
			sessionManager,
			resourceLoader,
		});
		try {
			expect(session.executionProfile).toBe("ultra");
			expect(session.thinkingLevel).not.toBe("ultra");
			expect(session.harnessCapabilities).toEqual({ workflows: true, teammates: true });
			expect(session.getActiveToolNames()).toContain("multiagent");
		} finally {
			await session.dispose();
		}
	});

	it("refreshes workflow and teammate tool surfaces when Ultra changes live", async () => {
		const session = await makeSession("medium");
		try {
			const standardSubAgent = session.getAllTools().find((tool) => tool.name === "sub_agent");
			const standardProperties = (standardSubAgent?.parameters as any).properties;
			expect(standardProperties.workflow).toBeUndefined();
			expect(JSON.stringify(standardProperties.action)).not.toContain('"wait"');
			expect(standardProperties.returnToMain).toBeUndefined();
			expect(standardProperties.waitTimeoutSeconds).toBeUndefined();
			expect(session.getActiveToolNames()).not.toContain("multiagent");

			const cycledProfiles: string[] = [];
			for (let i = 0; i < 10 && session.executionProfile !== "ultra"; i++) {
				const profile = session.cycleThinkingLevel();
				expect(profile).toBeDefined();
				cycledProfiles.push(profile!);
			}
			expect(cycledProfiles.at(-1)).toBe("ultra");
			const ultraSubAgent = session.getAllTools().find((tool) => tool.name === "sub_agent");
			expect((ultraSubAgent?.parameters as any).properties.workflow).toBeDefined();
			expect((ultraSubAgent?.parameters as any).properties.returnToMain).toBeUndefined();
			expect(session.getActiveToolNames()).toContain("multiagent");

			session.setExecutionProfile("high");
			expect(session.getAllTools().some((tool) => tool.name === "multiagent")).toBe(false);
			expect(session.getActiveToolNames()).not.toContain("multiagent");
		} finally {
			await session.dispose();
		}
	});

	it("lets explicit Harness overrides enable capabilities outside Ultra", async () => {
		const settingsStorage = new InMemorySettingsStorage();
		settingsStorage.withLock("global", () => JSON.stringify({ harness: { workflows: false, teammates: false } }));
		const settingsManager = SettingsManager.fromStorage(settingsStorage);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			thinkingLevel: "medium",
			harnessCapabilities: { workflows: true, teammates: true },
			settingsManager,
			sessionManager,
			resourceLoader,
		});
		try {
			expect(session.harnessCapabilities).toEqual({ workflows: true, teammates: true });
			expect(session.getAllTools().some((tool) => tool.name === "multiagent")).toBe(true);
			const subAgent = session.getAllTools().find((tool) => tool.name === "sub_agent");
			expect((subAgent?.parameters as any).properties.workflow).toBeDefined();
		} finally {
			await session.dispose();
		}
	});

	it("lets explicit Harness overrides disable Ultra capabilities", async () => {
		const settingsStorage = new InMemorySettingsStorage();
		settingsStorage.withLock("global", () => JSON.stringify({ harness: { workflows: true, teammates: true } }));
		const settingsManager = SettingsManager.fromStorage(settingsStorage);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			executionProfile: "ultra",
			harnessCapabilities: { workflows: false, teammates: false },
			settingsManager,
			sessionManager,
			resourceLoader,
		});
		try {
			expect(session.executionProfile).toBe("ultra");
			expect(session.harnessCapabilities).toEqual({ workflows: false, teammates: false });
			expect(session.getAllTools().some((tool) => tool.name === "multiagent")).toBe(false);
			const subAgent = session.getAllTools().find((tool) => tool.name === "sub_agent");
			expect((subAgent?.parameters as any).properties.workflow).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	it("publishes replacement stateful runtimes only after a successful ResourceLoader reload", async () => {
		const session = await makeSession("ultra");
		try {
			const internals = session as any;
			const before = {
				peerMessages: internals._peerMessages,
				subAgents: internals._subAgents,
				teammates: internals._teammates,
			};
			await session.reload();
			expect(internals._peerMessages).not.toBe(before.peerMessages);
			expect(internals._subAgents).not.toBe(before.subAgents);
			expect(internals._teammates).not.toBe(before.teammates);
			expect(session.getAllTools().some((tool) => tool.name === "multiagent")).toBe(true);
		} finally {
			await session.dispose();
		}
	});

	it("rejects a stateful Tool hot-swap while finite or persistent work is live", async () => {
		const session = await makeSession("ultra");
		try {
			const internals = session as any;
			const beforeHcp = internals._resourceLoader.HcpClientgetsession();
			vi.spyOn(internals._subAgents, "hasLiveWork").mockReturnValue(true);
			await expect(session.reload()).rejects.toThrow("while sub_agent or multiagent has live work");
			expect(internals._resourceLoader.HcpClientgetsession()).toBe(beforeHcp);
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
			const activations: Array<{ type: string; sources: string[] }> = [];
			const unsub = session.subscribe((event) => {
				if (event.type === "external_activation") {
					activations.push({ type: event.type, sources: event.sources });
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
			await flushExternalActivations(session);

			expect(activations).toHaveLength(1);
			expect(activations[0]).toEqual({ type: "external_activation", sources: ["peer"] });

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
			const activations: string[][] = [];
			const unsub = session.subscribe((event) => {
				if (event.type === "external_activation") activations.push(event.sources);
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
			await flushExternalActivations(session);

			expect(activations).toEqual([["peer"]]);
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

	it("routes urgent and normal groups as atomic steer and follow-up batches", async () => {
		const session = await makeSession();
		try {
			vi.spyOn(session, "isStreaming", "get").mockReturnValue(true);
			const peerStore = new MessageStore(join(agentDir, "messages.db"));
			try {
				peerStore.send("urgent-peer", session.sessionId, "interrupt soon", "urgent");
				peerStore.send("normal-peer", session.sessionId, "after the loop", "normal");
			} finally {
				peerStore.close();
			}

			const steerSpy = vi.spyOn(session.agent, "steerBatch");
			const followUpSpy = vi.spyOn(session.agent, "followUpBatch");
			(session as any)._submitPeerMessages();
			await flushExternalActivations(session);

			expect(steerSpy).toHaveBeenCalledTimes(1);
			expect(followUpSpy).toHaveBeenCalledTimes(1);
			expect((steerSpy.mock.calls[0]?.[0]?.[0] as any).content).toContain("interrupt soon");
			expect((followUpSpy.mock.calls[0]?.[0]?.[0] as any).content).toContain("after the loop");
			expect((session as any)._peerMessages.drainForInjection()).toHaveLength(0);
		} finally {
			await session.dispose();
		}
	});

	it("requeues only the delivery lane whose batch enqueue fails", async () => {
		const session = await makeSession();
		try {
			vi.spyOn(session, "isStreaming", "get").mockReturnValue(true);
			const peerStore = new MessageStore(join(agentDir, "messages.db"));
			try {
				peerStore.send("urgent-peer", session.sessionId, "retry urgent", "urgent");
				peerStore.send("normal-peer", session.sessionId, "deliver normal", "normal");
			} finally {
				peerStore.close();
			}

			vi.spyOn(session.agent, "steerBatch").mockImplementationOnce(() => {
				throw new Error("steer failed");
			});
			const followUpSpy = vi.spyOn(session.agent, "followUpBatch");
			(session as any)._submitPeerMessages();
			await flushExternalActivations(session);

			expect(followUpSpy).toHaveBeenCalledTimes(1);
			const retried = (session as any)._peerMessages.drainForInjection();
			expect(retried.map((message: { content: string }) => message.content)).toEqual(["retry urgent"]);
		} finally {
			await session.dispose();
		}
	});

	it("requeues pending peer messages when the live queue is cleared", async () => {
		const session = await makeSession();
		try {
			vi.spyOn(session, "isStreaming", "get").mockReturnValue(true);
			const peerStore = new MessageStore(join(agentDir, "messages.db"));
			try {
				peerStore.send("peer", session.sessionId, "restore after dequeue", "urgent");
			} finally {
				peerStore.close();
			}

			(session as any)._submitPeerMessages();
			await flushExternalActivations(session);
			expect((session as any)._peerMessages.drainForInjection()).toHaveLength(0);

			session.clearQueue();
			const retried = (session as any)._peerMessages.drainForInjection();
			expect(retried.map((message: { content: string }) => message.content)).toEqual(["restore after dequeue"]);
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
			(session as any)._wakeForPeerMessages();
			await flushExternalActivations(session);

			expect(activations).toHaveLength(0);

			unsub();
		} finally {
			await session.dispose();
		}
	});

	it("keeps urgent activation and normal follow-up in separate headless batches", async () => {
		const session = await makeSession();
		try {
			const followUpSpy = vi.spyOn(session.agent, "followUpBatch");
			const triggerSpy = vi.spyOn(session as any, "_runAgentPrompt").mockResolvedValue(undefined);
			const peerStore = new MessageStore(join(agentDir, "messages.db"));
			try {
				peerStore.send("urgent-peer", session.sessionId, "headless urgent", "urgent");
				peerStore.send("normal-peer", session.sessionId, "headless normal", "normal");
			} finally {
				peerStore.close();
			}

			(session as any)._wakeForPeerMessages();
			await flushExternalActivations(session);

			const normalPayload = followUpSpy.mock.calls[0]?.[0]?.[0] as { content: string };
			expect(normalPayload.content).toContain("headless normal");
			expect(normalPayload.content).not.toContain("headless urgent");
			const triggerPayload = triggerSpy.mock.calls[0]?.[0] as { content: string };
			expect(triggerPayload.content).toContain("headless urgent");
			expect(triggerPayload.content).not.toContain("headless normal");
			expect((session as any)._peerMessages.drainForInjection()).toHaveLength(0);
		} finally {
			await session.dispose();
		}
	});

	// Magenta feature: on an idle wake, urgent and normal are two separate pending
	// tracks. The urgent group triggers the turn (host external_activation), while
	// any queued normal messages are deferred to the follow-up queue so they land
	// when the woken loop would otherwise end — never merged into the urgent block.
	it("defers normal messages to follow-up while the urgent group triggers the wake", async () => {
		const session = await makeSession();
		try {
			const release = session.claimExternalTurnRunner();
			const followUpSpy = vi.spyOn(session.agent, "followUpBatch");
			const peerStore = new MessageStore(join(agentDir, "messages.db"));
			try {
				peerStore.send("urgent-peer", session.sessionId, "interrupt now", "urgent");
				peerStore.send("normal-peer", session.sessionId, "whenever you finish", "normal");
			} finally {
				peerStore.close();
			}

			(session as any)._wakeForPeerMessages();
			await flushExternalActivations(session);

			// Normal message went to one follow-up batch, not the trigger payload.
			expect(followUpSpy).toHaveBeenCalledTimes(1);
			const followUpArg = followUpSpy.mock.calls[0]?.[0]?.[0] as { content: string };
			expect(followUpArg.content).toContain("whenever you finish");
			expect(followUpArg.content).not.toContain("interrupt now");
			const normalIds = (followUpArg as { details?: { ids?: string[] } }).details?.ids ?? [];
			expect(normalIds).toHaveLength(1);
			const normalId = normalIds[0];
			if (!normalId) throw new Error("normal peer message did not include a delivery id");
			const db = new DatabaseSync(join(agentDir, "messages.db"));
			try {
				const status = () =>
					(db.prepare("SELECT status FROM messages WHERE id = ?").get(normalId) as { status: string }).status;
				expect(status()).toBe("pending");
				await (session as any)._handleAgentEvent({ type: "message_end", message: followUpArg });
				expect(status()).toBe("read");
			} finally {
				db.close();
			}

			// The urgent group is the turn trigger, appended to state for the host to run.
			const messages = session.agent.state.messages;
			const last = messages[messages.length - 1];
			expect((last as any).content).toContain("interrupt now");
			expect((last as any).content).not.toContain("whenever you finish");

			// Both tracks fully drained (nothing left pending/unread).
			expect((session as any)._peerMessages.drainForInjection()).toHaveLength(0);

			followUpSpy.mockRestore();
			release();
		} finally {
			await session.dispose();
		}
	});
});
