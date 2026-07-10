import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { HcpClient, type OrchestrationResult } from "@magenta/harness";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MultiAgentProvider } from "../../../HarnessComponentProtocol/multiagent/HcpServer.ts";
import * as multiagentServer from "../../../HarnessComponentProtocol/multiagent/HcpServer.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

function workflowResult(): OrchestrationResult {
	return {
		pattern: "fan_out_synthesize",
		workers: [],
		terminatedBy: "completed",
	};
}

function multiAgentSource(provider: MultiAgentProvider, source: string) {
	return {
		kind: "native",
		source,
		toCapability: () => ({
			kind: "multiagent",
			name: "multiagent",
			source,
			instance: provider,
		}),
	};
}

describe("AgentSession multiagent HCP selection", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	});

	it("uses the provider currently selected by the session HCP after a package override", async () => {
		tempDir = join(tmpdir(), `pi-multiagent-hcp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });

		const defaultOrchestrate = vi.fn(async () => workflowResult());
		const packageOrchestrate = vi.fn(async () => workflowResult());
		const defaultProvider: MultiAgentProvider = {
			discover: () => ({
				provider: "multiagent",
				targets: ["multiagent://default"],
				patterns: ["fan_out_synthesize"],
			}),
			orchestrate: defaultOrchestrate,
		};
		const packageProvider: MultiAgentProvider = {
			discover: () => ({
				provider: "multiagent",
				targets: ["multiagent://package"],
				patterns: ["fan_out_synthesize"],
			}),
			orchestrate: packageOrchestrate,
		};

		const hcp = new HcpClient();
		hcp.registerModule(
			new multiagentServer.HcpServer(),
			new Map([["multiagent", multiAgentSource(defaultProvider, "default")]]),
		);
		const resourceLoader = {
			...createTestResourceLoader(),
			getSessionHcp: () => hcp,
		};
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
		});

		try {
			// Mirrors a package reload replacing the selected source after session
			// construction. The workflow must resolve now, not use a cached provider.
			hcp.registerModule(
				new multiagentServer.HcpServer(),
				new Map([["multiagent", multiAgentSource(packageProvider, "package")]]),
			);
			expect(hcp.resolveCapability("multiagent")).toBe(packageProvider);

			const subAgent = session.agent.state.tools.find((tool) => tool.name === "sub_agent");
			expect(subAgent).toBeDefined();
			const started = await subAgent!.execute("start-workflow", {
				action: "start",
				workflow: {
					pattern: "fan_out_synthesize",
					workers: [{ task: "inspect" }],
					synthesizer: { task: "summarize" },
				},
			} as never);
			await subAgent!.execute("wait-workflow", {
				action: "wait",
				eventId: (started.details as { id: string }).id,
			} as never);

			expect(defaultOrchestrate).not.toHaveBeenCalled();
			expect(packageOrchestrate).toHaveBeenCalledOnce();
			expect(packageOrchestrate).toHaveBeenCalledWith(
				expect.objectContaining({ pattern: "fan_out_synthesize", cwd: tempDir }),
				expect.any(AbortSignal),
			);
		} finally {
			session.dispose();
		}
	});
});
