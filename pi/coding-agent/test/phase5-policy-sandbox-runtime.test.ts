/**
 * Phase 5 tests: policy/sandbox/runtime resolution via HCP (C5.1-C5.3)
 *
 * C5.1: bash/command execution resolves runtime+sandbox+policy from HCP.
 * C5.2: DEFAULT behavior = current (portable guards only, no new prompts/denials).
 * C5.3: no new user-visible approval prompts by default (parity test).
 *
 * These tests verify that policy/sandbox/runtime capabilities ARE resolved from
 * the session HCP but pi's bash execution remains byte-identical (local spawn,
 * full shell env, zero approval prompts) because policy defaults to `yolo` mode
 * and sandbox enforcement is not-ported.
 */

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

describe("Phase 5: policy/sandbox/runtime resolution (C5.1-C5.3)", () => {
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

	it("C5.1: resolves policy/sandbox/runtime from session HCP", async () => {
		const { session, resourceLoader } = await createSession();
		const sessionHcp = resourceLoader.getSessionHcp();

		// Verify the session HCP exposes policy/sandbox/runtime capabilities
		expect(sessionHcp).toBeDefined();
		const policy = sessionHcp?.resolveCapability<any>("policy");
		const sandbox = sessionHcp?.resolveCapability<any>("sandbox");
		const runtimeProcess = sessionHcp?.resolveCapability<any>("runtime:process");

		expect(policy).toBeDefined();
		expect(policy?.approval).toBeDefined();
		expect(policy?.shell).toBeDefined();
		expect(sandbox).toBeDefined();
		expect(runtimeProcess).toBeDefined();

		// Verify default modes (C5.2)
		const approvalStatus = policy?.approval?.status?.();
		expect(approvalStatus?.mode_default).toBe("yolo");

		const approvalDecision = policy?.approval?.decide?.({ tool: "bash", tier: "exec" });
		expect(approvalDecision?.decision).toBe("allow");
		expect(approvalDecision?.requires_prompt).toBe(false);

		const shellClassification = policy?.shell?.classify?.({ command: "rm -rf /" });
		expect(shellClassification?.decision).toBe("allow");

		session.dispose();
	});

	it("C5.3: bash execution is byte-identical with default policy (no prompts, no denials)", async () => {
		const { session } = await createSession();

		// Write a test script
		const scriptPath = join(tempDir, "test.sh");
		writeFileSync(scriptPath, "#!/bin/bash\necho 'Phase 5 parity test'\n", "utf-8");

		// Execute bash command (this consults policy provider if wired, but with
		// yolo mode the result is identical to pre-Phase-5 local spawn).
		const bashTool = session.agent.state.tools.find((t) => t.name === "bash");
		expect(bashTool).toBeDefined();

		const result = await bashTool!.execute("test-call", { command: `cat ${scriptPath}` });

		// Assert execution succeeded without prompts/blocks
		expect(result).toBeDefined();
		const text = result.content
			.filter((item: any): item is { type: "text"; text: string } => item.type === "text")
			.map((item: any) => item.text)
			.join("");
		expect(text).toContain("Phase 5 parity test");

		session.dispose();
	});

	it("AgentSession caches policy/sandbox/runtime providers when HCP present", async () => {
		const { session } = await createSession();

		// Access private fields via reflection (test-only assertion)
		const sessionAny = session as any;
		expect(sessionAny._policyProvider).toBeDefined();
		expect(sessionAny._sandboxProvider).toBeDefined();
		expect(sessionAny._runtimeProvider).toBeDefined();

		// Verify policy provider methods work (yolo default → allow)
		const approvalDecision = sessionAny._policyProvider.decideApproval({ tool: "read", tier: "read" });
		expect(approvalDecision.decision).toBe("allow");

		session.dispose();
	});
});
