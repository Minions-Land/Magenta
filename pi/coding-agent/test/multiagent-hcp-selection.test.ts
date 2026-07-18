import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { HcpClient } from "@magenta/harness";
import { afterEach, describe, expect, it } from "vitest";
import type { SystemPromptProvider } from "../../../HarnessComponentProtocol/system-prompt/HcpServer.ts";
import * as systemPromptServer from "../../../HarnessComponentProtocol/system-prompt/HcpServer.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

function systemPromptSource(provider: SystemPromptProvider) {
	return {
		kind: "native",
		source: "test-system-prompt",
		toCapability: () => ({
			kind: "system-prompt",
			name: "system-prompt",
			source: "test-system-prompt",
			instance: provider,
		}),
	};
}

describe("AgentSession HCP finite Tool assembly", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	});

	it("assembles tool:sub_agent without a parallel multiagent Capability", async () => {
		tempDir = join(tmpdir(), `pi-sub-agent-hcp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		const hcp = new HcpClient();
		const systemPromptProvider: SystemPromptProvider = {
			buildSystemPrompt: () => "test system prompt",
			formatSkillsForSystemPrompt: () => "",
			loadDescriptor: async () => ({ diagnostics: [] }),
		};
		hcp.registerModule(
			new systemPromptServer.HcpServer(),
			new Map([["system-prompt", systemPromptSource(systemPromptProvider)]]),
		);
		const resourceLoader = { ...createTestResourceLoader(), HcpClientgetsession: () => hcp };
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			harnessCapabilities: { workflows: true },
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
		});

		try {
			expect(hcp.addresses()).toContain("tool:sub_agent");
			expect(hcp.addresses()).toContain("tool:send_message");
			expect(hcp.addresses()).toContain("tool:multiagent");
			expect(hcp.addresses()).not.toContain("capability:multiagent");
			expect(hcp.addresses()).not.toContain("multiagent://local");
			const tool = session.agent.state.tools.find((candidate) => candidate.name === "sub_agent");
			expect(tool).toBeDefined();
			const properties = (tool!.parameters as { properties: Record<string, unknown> }).properties;
			expect(properties.workflow).toBeDefined();
			expect(properties.tasks).toBeUndefined();
			expect(properties.eventIds).toBeUndefined();
			expect(JSON.stringify(properties.action)).not.toContain("wait");
			const multiagent = hcp.resolveInstance<any>("tool:multiagent")!;
			const multiagentSchema = multiagent.parameters as { properties: Record<string, unknown> };
			expect(Object.keys(multiagentSchema.properties)).toContain("sessionId");
			expect(multiagentSchema.properties).not.toHaveProperty("teammateId");
			expect(multiagentSchema.properties).not.toHaveProperty("assignmentId");
			const sendMessage = session.agent.state.tools.find((candidate) => candidate.name === "send_message");
			expect(sendMessage).toBeDefined();
			const sendSchema = sendMessage!.parameters as {
				properties: Record<string, unknown>;
				additionalProperties: boolean;
			};
			expect(Object.keys(sendSchema.properties).sort()).toEqual(["content", "to"]);
			expect(sendSchema.additionalProperties).toBe(false);
		} finally {
			await session.dispose();
		}
	});

	it("keeps published runtime ports when a prepared HCP reload candidate fails", async () => {
		tempDir = join(tmpdir(), `pi-stateful-hcp-reload-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		const makeHcp = () => {
			const hcp = new HcpClient();
			const provider: SystemPromptProvider = {
				buildSystemPrompt: () => "test system prompt",
				formatSkillsForSystemPrompt: () => "",
				loadDescriptor: async () => ({ diagnostics: [] }),
			};
			hcp.registerModule(
				new systemPromptServer.HcpServer(),
				new Map([["system-prompt", systemPromptSource(provider)]]),
			);
			return hcp;
		};
		const publishedHcp = makeHcp();
		let failedCandidate: HcpClient | undefined;
		const resourceLoader = {
			...createTestResourceLoader(),
			HcpClientgetsession: () => publishedHcp,
			reload: async (options?: { HcpClientprepare?: (hcp: HcpClient) => void | Promise<void> }) => {
				failedCandidate = makeHcp();
				await options?.HcpClientprepare?.(failedCandidate);
				await failedCandidate.dispose();
				throw new Error("candidate publication rejected");
			},
			dispose: async () => publishedHcp.dispose(),
		};
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			harnessCapabilities: { workflows: true, teammates: true },
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
		});
		try {
			const internals = session as any;
			const before = {
				peerMessages: internals._peerMessages,
				subAgents: internals._subAgents,
				teammates: internals._teammates,
			};
			await expect(session.reload()).rejects.toThrow("candidate publication rejected");
			expect(internals._peerMessages).toBe(before.peerMessages);
			expect(internals._subAgents).toBe(before.subAgents);
			expect(internals._teammates).toBe(before.teammates);
			expect(failedCandidate).toBeDefined();
		} finally {
			await session.dispose();
		}
	});
});
