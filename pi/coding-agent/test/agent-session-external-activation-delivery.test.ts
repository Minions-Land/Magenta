import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	ExternalActivationEntry,
	ExternalActivationMessage,
} from "../src/core/external-activation-coordinator.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const harnesses: Harness[] = [];

afterEach(async () => {
	while (harnesses.length > 0) await harnesses.pop()!.cleanup();
});

function backgroundMessage(id: string): ExternalActivationMessage {
	return {
		customType: "bg-shell-return",
		content: `background ${id}`,
		display: true,
		details: { id },
	};
}

function backgroundEntry(id: string, delivery: ExternalActivationEntry["delivery"]): ExternalActivationEntry {
	return {
		key: `bg-shell:${id}`,
		source: { kind: "background", controller: "bg_shell", eventIds: [id] },
		consumeIds: [id],
		message: backgroundMessage(id),
		delivery,
		idlePolicy: delivery === "nextTurn" ? "passive" : "activate",
	};
}

function peerEntry(id: string, delivery: "steer" | "followUp" = "steer"): ExternalActivationEntry {
	return {
		key: `peer:${delivery}:${id}`,
		source: { kind: "peer", messageIds: [id] },
		consumeIds: [id],
		message: {
			customType: "magenta-peer-message",
			content: `peer ${id}`,
			display: true,
			details: { ids: [id] },
		},
		delivery,
		idlePolicy: delivery === "steer" ? "activate" : "passive",
	};
}

async function injectBatch(harness: Harness, entries: ExternalActivationEntry[]): Promise<void> {
	await (
		harness.session as unknown as {
			_injectExternalActivationBatch: (value: ExternalActivationEntry[]) => Promise<void>;
		}
	)._injectExternalActivationBatch(entries);
}

function externalCoordinator(harness: Harness): {
	register: (entry: ExternalActivationEntry) => void;
	registerBatch: (entries: readonly ExternalActivationEntry[]) => void;
	flushReady: () => Promise<void>;
} {
	return (
		harness.session as unknown as {
			_externalActivations: ReturnType<typeof externalCoordinator>;
		}
	)._externalActivations;
}

function seedCompactableSession(harness: Harness): void {
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "old context ".repeat(100) }],
		timestamp: now - 1_000,
	});
	const assistant = fauxAssistantMessage("old response ".repeat(100), { timestamp: now - 500 });
	const model = harness.getModel();
	assistant.api = model.api;
	assistant.provider = model.provider;
	assistant.model = model.id;
	harness.sessionManager.appendMessage(assistant);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("AgentSession external activation delivery", () => {
	it("uses the shared activation coordinator for Ultra's proactive stall reminder", async () => {
		const harness = await createHarness({ executionProfile: "ultra", initialActiveToolNames: [] });
		harnesses.push(harness);
		const internals = harness.session as unknown as {
			_backgroundReminders: { upsertNextTurn: (key: string, content: string) => void };
			_externalActivations: { register: (entry: ExternalActivationEntry) => void };
		};
		const register = vi.spyOn(internals._externalActivations, "register").mockImplementation(() => {});

		internals._backgroundReminders.upsertNextTurn("stalled", "Check the stalled worker");

		expect(register).toHaveBeenCalledTimes(1);
		expect(register.mock.calls[0]?.[0]).toMatchObject({
			source: { kind: "reminder", key: "stalled" },
			delivery: "steer",
			idlePolicy: "activate",
		});

		register.mockClear();
		harness.session.setExecutionProfile("high");
		internals._backgroundReminders.upsertNextTurn("stalled", "Check the stalled worker");
		expect(register.mock.calls[0]?.[0]).toMatchObject({ delivery: "nextTurn", idlePolicy: "passive" });
	});

	it("keeps an idle nextTurn return passive until the next user prompt", async () => {
		const harness = await createHarness({ initialActiveToolNames: [] });
		harnesses.push(harness);

		await injectBatch(harness, [backgroundEntry("next", "nextTurn")]);
		expect(harness.eventsOfType("external_activation")).toHaveLength(0);
		expect(harness.session.messages.some((message) => message.role === "custom")).toBe(false);

		harness.setResponses([fauxAssistantMessage("handled")]);
		await harness.session.prompt("continue");
		expect(
			harness.session.messages.some((message) => message.role === "custom" && message.content === "background next"),
		).toBe(true);
	});

	it("does not upgrade nextTurn when batched with an activating return", async () => {
		const harness = await createHarness({ initialActiveToolNames: [] });
		harnesses.push(harness);
		const releaseRunner = harness.session.claimExternalTurnRunner();

		try {
			await injectBatch(harness, [backgroundEntry("passive", "nextTurn"), backgroundEntry("active", "followUp")]);

			const activations = harness.eventsOfType("external_activation");
			expect(activations).toHaveLength(1);
			expect(activations[0]?.sources).toEqual(["bg_shell"]);
			expect(
				activations[0]?.messages.map((message) => (message.role === "custom" ? message.content : undefined)),
			).toEqual(["background active"]);
			expect(
				harness.session.messages.some(
					(message) => message.role === "custom" && message.content === "background passive",
				),
			).toBe(false);
		} finally {
			releaseRunner();
		}
	});

	it("combines due peer and background sources into one claimed-host activation", async () => {
		const harness = await createHarness({ initialActiveToolNames: [] });
		harnesses.push(harness);
		const releaseRunner = harness.session.claimExternalTurnRunner();
		try {
			await injectBatch(harness, [backgroundEntry("done", "followUp"), peerEntry("urgent")]);
			const activations = harness.eventsOfType("external_activation");
			expect(activations).toHaveLength(1);
			expect(activations[0]?.sources).toEqual(["peer", "bg_shell"]);
			expect(
				activations[0]?.messages.map((message) => (message.role === "custom" ? message.content : undefined)),
			).toEqual(["peer urgent", "background done"]);
		} finally {
			releaseRunner();
		}
	});

	it("retries a retained claimed-host activation once after the competing run becomes idle", async () => {
		const harness = await createHarness({ initialActiveToolNames: [] });
		harnesses.push(harness);
		const releaseRunner = harness.session.claimExternalTurnRunner();
		let settleIdle!: () => void;
		const idle = new Promise<void>((resolve) => {
			settleIdle = resolve;
		});

		try {
			await injectBatch(harness, [backgroundEntry("idle-race", "followUp")]);
			harness.setResponses([fauxAssistantMessage("handled once")]);
			const waitForIdle = vi.spyOn(harness.session.agent, "waitForIdle").mockReturnValueOnce(idle);
			vi.spyOn(harness.session, "isStreaming", "get").mockReturnValueOnce(true).mockReturnValue(false);
			const continuation = vi.spyOn(harness.session.agent, "continue");

			const running = harness.session.runExternalActivation();
			await vi.waitFor(() => expect(waitForIdle).toHaveBeenCalledOnce());
			expect(continuation).not.toHaveBeenCalled();

			settleIdle();
			await running;
			expect(continuation).toHaveBeenCalledOnce();

			await harness.session.runExternalActivation();
			expect(continuation).toHaveBeenCalledOnce();
		} finally {
			releaseRunner();
		}
	});

	it("tracks a claimed-host continuation through waitForIdle and one settled event", async () => {
		const harness = await createHarness({ initialActiveToolNames: [] });
		harnesses.push(harness);
		const releaseRunner = harness.session.claimExternalTurnRunner();
		let finishContinuation!: () => void;
		const continuationGate = new Promise<void>((resolve) => {
			finishContinuation = resolve;
		});

		try {
			await injectBatch(harness, [backgroundEntry("lifecycle", "followUp")]);
			const continuation = vi
				.spyOn(harness.session.agent, "continue")
				.mockImplementationOnce(async () => continuationGate);
			const settledBefore = harness.eventsOfType("agent_settled").length;
			const running = harness.session.runExternalActivation();
			await vi.waitFor(() => expect(continuation).toHaveBeenCalledOnce());

			expect(harness.session.isIdle).toBe(false);
			let idleResolved = false;
			const waitingForIdle = harness.session.waitForIdle().then(() => {
				idleResolved = true;
			});
			await Promise.resolve();
			expect(idleResolved).toBe(false);

			finishContinuation();
			await running;
			await waitingForIdle;
			expect(harness.session.isIdle).toBe(true);
			expect(harness.eventsOfType("agent_settled")).toHaveLength(settledBefore + 1);
		} finally {
			releaseRunner();
		}
	});

	it("submits one atomic Agent batch per lane while streaming", async () => {
		const harness = await createHarness({ initialActiveToolNames: [] });
		harnesses.push(harness);
		vi.spyOn(harness.session, "isStreaming", "get").mockReturnValue(true);
		const steerBatch = vi.spyOn(harness.session.agent, "steerBatch");
		await injectBatch(harness, [peerEntry("one"), peerEntry("two")]);
		expect(steerBatch).toHaveBeenCalledTimes(1);
		expect(steerBatch.mock.calls[0]?.[0]).toHaveLength(2);
	});

	it("buffers display and model injection through successful compaction, including the completion race", async () => {
		let enteredCompaction!: () => void;
		const compactionEntered = new Promise<void>((resolve) => {
			enteredCompaction = resolve;
		});
		let finishCompaction!: () => void;
		const finish = new Promise<void>((resolve) => {
			finishCompaction = resolve;
		});
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			initialActiveToolNames: [],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						enteredCompaction();
						await finish;
						return {
							compaction: {
								summary: "barrier summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const releaseRunner = harness.session.claimExternalTurnRunner();
		const backgroundPersisted = vi.fn();
		const peerPersisted = vi.fn();
		const background = { ...backgroundEntry("during-success", "followUp"), onPersisted: backgroundPersisted };
		const peer = { ...peerEntry("completion-race"), onPersisted: peerPersisted };
		let registeredCompletionRace = false;
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && !registeredCompletionRace) {
				registeredCompletionRace = true;
				externalCoordinator(harness).register(peer);
			}
		});

		try {
			const compacting = harness.session.compact();
			await compactionEntered;
			externalCoordinator(harness).register(background);
			await externalCoordinator(harness).flushReady();

			expect(harness.eventsOfType("external_activation")).toHaveLength(0);
			expect(
				harness.session.messages.some(
					(message) =>
						message.role === "custom" &&
						(message.customType === "bg-shell-return" || message.customType === "magenta-peer-message"),
				),
			).toBe(false);
			expect(backgroundPersisted).not.toHaveBeenCalled();

			finishCompaction();
			await compacting;

			const activations = harness.eventsOfType("external_activation");
			expect(activations).toHaveLength(1);
			expect(
				activations[0]?.messages.map((message) => (message.role === "custom" ? message.customType : undefined)),
			).toEqual(["magenta-peer-message", "bg-shell-return"]);
			const compactionEndIndex = harness.events.findIndex((event) => event.type === "compaction_end");
			const firstExternalDisplayIndex = harness.events.findIndex(
				(event) =>
					event.type === "message_start" &&
					event.message.role === "custom" &&
					(event.message.customType === "bg-shell-return" || event.message.customType === "magenta-peer-message"),
			);
			expect(firstExternalDisplayIndex).toBeGreaterThan(compactionEndIndex);
			expect(backgroundPersisted).toHaveBeenCalledOnce();
			expect(peerPersisted).toHaveBeenCalledOnce();
		} finally {
			releaseRunner();
		}
	});

	it("buffers external payloads throughout auto-compaction summarizing", async () => {
		let enteredCompaction!: () => void;
		const compactionEntered = new Promise<void>((resolve) => {
			enteredCompaction = resolve;
		});
		let finishCompaction!: () => void;
		const finish = new Promise<void>((resolve) => {
			finishCompaction = resolve;
		});
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			initialActiveToolNames: [],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						enteredCompaction();
						await finish;
						return {
							compaction: {
								summary: "auto barrier summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const releaseRunner = harness.session.claimExternalTurnRunner();
		const persisted = vi.fn();
		const entry = backgroundEntry("auto-summarizing", "followUp");
		entry.onPersisted = persisted;
		const internals = harness.session as unknown as {
			_runAutoCompaction: (reason: "threshold", willRetry: boolean) => Promise<boolean>;
		};

		try {
			const compacting = internals._runAutoCompaction("threshold", false);
			await compactionEntered;
			expect(harness.eventsOfType("compaction_start").at(-1)?.reason).toBe("threshold");
			externalCoordinator(harness).register(entry);
			await externalCoordinator(harness).flushReady();
			expect(harness.eventsOfType("external_activation")).toHaveLength(0);
			expect(
				harness.session.messages.some(
					(message) => message.role === "custom" && message.customType === "bg-shell-return",
				),
			).toBe(false);

			finishCompaction();
			await compacting;
			expect(harness.eventsOfType("external_activation")).toHaveLength(1);
			expect(persisted).toHaveBeenCalledOnce();
		} finally {
			releaseRunner();
		}
	});

	it("releases held work once after manual compaction failure", async () => {
		const harness = await createHarness({ initialActiveToolNames: [] });
		harnesses.push(harness);
		const releaseRunner = harness.session.claimExternalTurnRunner();
		const persisted = vi.fn();
		const dropped = vi.fn();
		const entry = backgroundEntry("failure", "followUp");
		entry.onPersisted = persisted;
		entry.onInjectionError = dropped;
		harness.session.subscribe((event) => {
			if (event.type === "compaction_start") externalCoordinator(harness).register(entry);
		});
		harness.session.agent.state.model = undefined as never;

		try {
			await expect(harness.session.compact()).rejects.toThrow("No model selected");
			expect(harness.eventsOfType("external_activation")).toHaveLength(1);
			expect(persisted).toHaveBeenCalledOnce();
			expect(dropped).not.toHaveBeenCalled();
		} finally {
			releaseRunner();
		}
	});

	it("releases held work once after user cancellation", async () => {
		let enteredCompaction!: () => void;
		const compactionEntered = new Promise<void>((resolve) => {
			enteredCompaction = resolve;
		});
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			initialActiveToolNames: [],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						enteredCompaction();
						return await new Promise<{ cancel: true }>((resolve) => {
							event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
						});
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const releaseRunner = harness.session.claimExternalTurnRunner();
		const persisted = vi.fn();
		const dropped = vi.fn();
		const entry = backgroundEntry("cancel", "followUp");
		entry.onPersisted = persisted;
		entry.onInjectionError = dropped;

		try {
			const compacting = harness.session.compact();
			await compactionEntered;
			externalCoordinator(harness).register(entry);
			harness.session.abortCompaction();
			await expect(compacting).rejects.toThrow("Compaction cancelled");
			expect(harness.eventsOfType("external_activation")).toHaveLength(1);
			expect(persisted).toHaveBeenCalledOnce();
			expect(dropped).not.toHaveBeenCalled();
		} finally {
			releaseRunner();
		}
	});
});
