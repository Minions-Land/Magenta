import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

const CODEX_CATALOG_PATH = "/api/models/providers/openai-codex";
const originalOffline = process.env.PI_OFFLINE;

function authenticatedStorage(): AuthStorage {
	return AuthStorage.inMemory({
		"openai-codex": {
			type: "oauth",
			access: "test-access",
			refresh: "test-refresh",
			expires: Date.now() + 3_600_000,
		},
	});
}

describe("session model network policy", () => {
	const cleanup: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		vi.unstubAllEnvs();
		if (originalOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = originalOffline;
		vi.restoreAllMocks();
		while (cleanup.length > 0) await cleanup.pop()?.();
	});

	function tempDir(): string {
		const directory = mkdtempSync(join(tmpdir(), "magenta-model-policy-"));
		cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
		return directory;
	}

	function spyOnCatalogFetch(): string[] {
		const calls: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url.includes(CODEX_CATALOG_PATH)) calls.push(url);
			return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
		});
		return calls;
	}

	it("keeps both session factories offline when PI_OFFLINE is set", async () => {
		vi.stubEnv("PI_OFFLINE", "1");
		const calls = spyOnCatalogFetch();

		const servicesDir = tempDir();
		const services = await createAgentSessionServices({
			cwd: servicesDir,
			agentDir: servicesDir,
			authStorage: authenticatedStorage(),
			resourceLoaderOptions: {
				includeBundledResources: false,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		cleanup.push(() => (services.resourceLoader as DefaultResourceLoader).dispose());

		const sdkDir = tempDir();
		const { session } = await createAgentSession({
			cwd: sdkDir,
			agentDir: sdkDir,
			authStorage: authenticatedStorage(),
			settingsManager: SettingsManager.inMemory({}),
			sessionManager: SessionManager.inMemory(sdkDir),
			resourceLoader: createTestResourceLoader(),
			noTools: "all",
		});
		cleanup.push(() => session.dispose());

		expect(calls).toHaveLength(0);
	});

	it("allows the model catalog fetch during normal service startup", async () => {
		delete process.env.PI_OFFLINE;
		const calls = spyOnCatalogFetch();
		const directory = tempDir();

		const services = await createAgentSessionServices({
			cwd: directory,
			agentDir: directory,
			authStorage: authenticatedStorage(),
			resourceLoaderOptions: {
				includeBundledResources: false,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		cleanup.push(() => (services.resourceLoader as DefaultResourceLoader).dispose());

		expect(calls).toHaveLength(1);
	});
});
