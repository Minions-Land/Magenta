import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import type { MultiagentController } from "@magenta/harness";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext } from "../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";
import type { SideChatHandoffRequest, SideChatHandoffResult } from "../src/core/side-chat.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()!();
});

function request(): SideChatHandoffRequest {
	return {
		confirmed: true,
		origin: "side",
		conversationId: "side-conversation",
		label: "side · queue design",
		context: "Human: promote this discussion",
		messageCount: 1,
		originalBytes: 31,
		truncated: false,
	};
}

async function makeSession(settings?: { harness: { teammates: boolean } }) {
	const root = join(tmpdir(), `pi-side-handoff-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	const settingsManager = settings
		? (() => {
				const storage = new InMemorySettingsStorage();
				storage.withLock("global", () => JSON.stringify(settings));
				return SettingsManager.fromStorage(storage);
			})()
		: SettingsManager.create(root, agentDir);
	const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager });
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: root,
		agentDir,
		model: getModel("anthropic", "claude-sonnet-4-5")!,
		executionProfile: "high",
		settingsManager,
		sessionManager: SessionManager.inMemory(),
		resourceLoader,
	});
	cleanups.push(async () => {
		await session.dispose();
		if (existsSync(root)) rmSync(root, { recursive: true, force: true });
	});
	return session;
}

type SessionInternals = {
	_teammates: MultiagentController;
	_enqueueHumanSideHandoff: (
		request: SideChatHandoffRequest,
		ctx: ExtensionCommandContext,
	) => Promise<SideChatHandoffResult>;
};

describe("AgentSession human Side/BTW handoff", () => {
	it("activates the HCP multiagent Tool only for the confirmed human action", async () => {
		const session = await makeSession();
		const internals = session as unknown as SessionInternals;
		const start = vi.spyOn(internals._teammates, "startHumanSideHandoff").mockResolvedValue({
			handoffId: "handoff-1",
			sessionId: "child-session",
		});

		expect(session.getActiveToolNames()).not.toContain("multiagent");
		const result = await internals._enqueueHumanSideHandoff(request(), {} as ExtensionCommandContext);

		expect(result.sessionId).toBe("child-session");
		expect(start).toHaveBeenCalledTimes(1);
		expect(session.getActiveToolNames()).toContain("multiagent");
		expect(session.systemPrompt).toContain("multiagent");
		expect(session.systemPrompt).not.toContain("Side/BTW invitation");
		expect(session.systemPrompt).not.toContain("human handoff");
	});

	it("honors an explicit multiagent capability denial", async () => {
		const session = await makeSession({ harness: { teammates: false } });
		const internals = session as unknown as SessionInternals;
		const start = vi.spyOn(internals._teammates, "startHumanSideHandoff");

		await expect(internals._enqueueHumanSideHandoff(request(), {} as ExtensionCommandContext)).rejects.toThrow(
			"explicitly disabled in settings",
		);
		expect(start).not.toHaveBeenCalled();
		expect(session.getActiveToolNames()).not.toContain("multiagent");
	});
});
