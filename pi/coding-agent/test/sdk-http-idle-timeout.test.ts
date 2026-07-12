import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import * as undici from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("createAgentSession HTTP idle timeout", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;
	let server: Server | undefined;
	let sockets: Set<Socket>;
	let originalDispatcher: undici.Dispatcher;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-sdk-http-idle-timeout-"));
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		sockets = new Set();
		originalDispatcher = undici.getGlobalDispatcher();
	});

	afterEach(async () => {
		undici.setGlobalDispatcher(originalDispatcher);
		for (const socket of sockets) socket.destroy();
		if (server) {
			await new Promise<void>((resolve) => server?.close(() => resolve()));
			server = undefined;
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("applies httpIdleTimeoutMs to a stalled OpenAI response body in the public SDK", async () => {
		server = createServer((_request, response) => {
			response.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			response.write('data: {"choices":');
		});
		server.on("connection", (socket) => {
			sockets.add(socket);
			socket.on("close", () => sockets.delete(socket));
		});

		await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Test server did not bind to a TCP port");

		const model: Model<Api> = {
			id: "stalled-openai-model",
			name: "Stalled OpenAI Model",
			api: "openai-completions",
			provider: "direct-sdk-timeout",
			baseUrl: `http://127.0.0.1:${address.port}/v1`,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 4_096,
		};
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "test-api-key");
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			authStorage,
			settingsManager: SettingsManager.inMemory({ httpIdleTimeoutMs: 50 }),
			sessionManager: SessionManager.inMemory(cwd),
			noTools: "all",
		});

		try {
			const stream = await session.agent.streamFn(model, { messages: [] });
			let watchdog: ReturnType<typeof setTimeout> | undefined;
			const result = await Promise.race([
				stream.result(),
				new Promise<never>((_resolve, reject) => {
					watchdog = setTimeout(() => reject(new Error("stalled response body did not time out")), 5_000);
				}),
			]).finally(() => {
				if (watchdog) clearTimeout(watchdog);
			});

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/terminated|body timeout|timed?\s*out/i);
		} finally {
			await session.dispose();
		}
	});
});
