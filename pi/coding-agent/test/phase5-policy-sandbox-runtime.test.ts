/** HCP safety capability scope and native-tool parity tests. */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("HCP safety capability scope", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-phase5-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createSession() {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			authStorage,
			resourceLoader,
		});

		return { session, resourceLoader };
	}

	it("autoloads connected process capabilities but not experimental providers", async () => {
		const { session, resourceLoader } = await createSession();
		const sessionHcp = resourceLoader.HcpClientgetsession();

		expect(sessionHcp).toBeDefined();
		expect(sessionHcp?.resolveCapability("sandbox")).toBeDefined();
		expect(sessionHcp?.resolveCapability("runtime:process")).toBeDefined();
		expect(sessionHcp?.resolveCapability("policy")).toBeUndefined();
		expect(sessionHcp?.resolveCapability("hook")).toBeUndefined();
		expect(sessionHcp?.resolveCapability("memory")).toBeUndefined();

		await session.dispose();
	});

	it("keeps the native bash path unchanged", async () => {
		const { session } = await createSession();

		// Write a test script
		const scriptPath = join(tempDir, "test.sh");
		writeFileSync(scriptPath, "#!/bin/bash\necho 'Phase 5 parity test'\n", "utf-8");

		const bashTool = session.agent.state.tools.find((t) => t.name === "bash");
		expect(bashTool).toBeDefined();

		const result = await bashTool!.execute("test-call", { command: `cat ${scriptPath}` });

		expect(result).toBeDefined();
		const text = result.content
			.filter((item: any): item is { type: "text"; text: string } => item.type === "text")
			.map((item: any) => item.text)
			.join("");
		expect(text).toContain("Phase 5 parity test");

		await session.dispose();
	});

	it("does not cache unused safety providers on AgentSession", async () => {
		const { session } = await createSession();

		expect(session).not.toHaveProperty("_policyProvider");
		expect(session).not.toHaveProperty("_sandboxProvider");
		expect(session).not.toHaveProperty("_runtimeProvider");

		await session.dispose();
	});
});
