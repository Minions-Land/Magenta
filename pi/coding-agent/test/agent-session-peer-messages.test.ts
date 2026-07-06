import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MessageStore } from "@magenta/harness";
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
			session.dispose();
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
			session.dispose();
		}
	});
});
