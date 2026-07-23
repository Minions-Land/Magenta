import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR } from "../src/config.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { migrateAuthToAuthJson, migrateLegacyPiAgentDirToCurrentConfigDir, runMigrations } from "../src/migrations.ts";
import { createTestModelRegistry } from "./utilities.ts";

describe("config value env var syntax migration", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
		vi.restoreAllMocks();
	});

	function createAgentDir(): string {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-value-migration-test-"));
		tempDirs.push(agentDir);
		return agentDir;
	}

	function withAgentDir(agentDir: string, fn: () => void): void {
		const previousAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
		try {
			fn();
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env[ENV_AGENT_DIR];
			} else {
				process.env[ENV_AGENT_DIR] = previousAgentDir;
			}
		}
	}

	describe("legacy .pi agent dir migration", () => {
		it("copies ~/.pi/agent to the current branded agent dir without deleting the source", () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-legacy-agent-dir-test-"));
			tempDirs.push(root);
			const oldAgentDir = path.join(root, ".pi", "agent");
			const newAgentDir = path.join(root, CONFIG_DIR_NAME, "agent");
			fs.mkdirSync(path.join(oldAgentDir, "sessions", "demo"), { recursive: true });
			fs.writeFileSync(path.join(oldAgentDir, "settings.json"), '{"theme":"dark"}\n', "utf-8");
			fs.writeFileSync(path.join(oldAgentDir, "sessions", "demo", "session.jsonl"), "{}\n", "utf-8");

			const migrated = migrateLegacyPiAgentDirToCurrentConfigDir({
				oldAgentDir,
				newAgentDir,
				envAgentDir: undefined,
				configDirName: CONFIG_DIR_NAME,
			});

			expect(migrated).toBe(true);
			expect(fs.existsSync(path.join(oldAgentDir, "settings.json"))).toBe(true);
			expect(fs.readFileSync(path.join(newAgentDir, "settings.json"), "utf-8")).toBe('{"theme":"dark"}\n');
			expect(fs.readFileSync(path.join(newAgentDir, "sessions", "demo", "session.jsonl"), "utf-8")).toBe("{}\n");
		});

		it("does not overwrite an existing branded agent dir", () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-legacy-agent-dir-existing-test-"));
			tempDirs.push(root);
			const oldAgentDir = path.join(root, ".pi", "agent");
			const newAgentDir = path.join(root, CONFIG_DIR_NAME, "agent");
			fs.mkdirSync(oldAgentDir, { recursive: true });
			fs.mkdirSync(newAgentDir, { recursive: true });
			fs.writeFileSync(path.join(oldAgentDir, "settings.json"), '{"theme":"old"}\n', "utf-8");
			fs.writeFileSync(path.join(newAgentDir, "settings.json"), '{"theme":"new"}\n', "utf-8");

			const migrated = migrateLegacyPiAgentDirToCurrentConfigDir({
				oldAgentDir,
				newAgentDir,
				envAgentDir: undefined,
				configDirName: CONFIG_DIR_NAME,
			});

			expect(migrated).toBe(false);
			expect(fs.readFileSync(path.join(newAgentDir, "settings.json"), "utf-8")).toBe('{"theme":"new"}\n');
		});

		it("skips migration when the agent dir is explicitly overridden", () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-legacy-agent-dir-env-test-"));
			tempDirs.push(root);
			const oldAgentDir = path.join(root, ".pi", "agent");
			const newAgentDir = path.join(root, CONFIG_DIR_NAME, "agent");
			fs.mkdirSync(oldAgentDir, { recursive: true });
			fs.writeFileSync(path.join(oldAgentDir, "settings.json"), '{"theme":"old"}\n', "utf-8");

			const migrated = migrateLegacyPiAgentDirToCurrentConfigDir({
				oldAgentDir,
				newAgentDir,
				envAgentDir: path.join(root, "custom-agent"),
				configDirName: CONFIG_DIR_NAME,
			});

			expect(migrated).toBe(false);
			expect(fs.existsSync(newAgentDir)).toBe(false);
		});

		it.skipIf(process.platform === "win32")("does not expose a partial destination when copying fails", () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-legacy-agent-dir-failure-test-"));
			tempDirs.push(root);
			const oldAgentDir = path.join(root, ".pi", "agent");
			const newAgentDir = path.join(root, CONFIG_DIR_NAME, "agent");
			fs.mkdirSync(oldAgentDir, { recursive: true });
			fs.writeFileSync(path.join(oldAgentDir, "settings.json"), '{"theme":"old"}\n', "utf-8");
			const unreadablePath = path.join(oldAgentDir, "unreadable-state");
			fs.writeFileSync(unreadablePath, "private\n", "utf-8");
			fs.chmodSync(unreadablePath, 0o000);
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

			try {
				const migrated = migrateLegacyPiAgentDirToCurrentConfigDir({
					oldAgentDir,
					newAgentDir,
					envAgentDir: undefined,
					configDirName: CONFIG_DIR_NAME,
				});

				expect(migrated).toBe(false);
				expect(fs.existsSync(newAgentDir)).toBe(false);
				expect(fs.readdirSync(path.dirname(newAgentDir)).some((name) => name.startsWith(".agent.migration-"))).toBe(
					false,
				);
				expect(logSpy).toHaveBeenCalledOnce();
			} finally {
				fs.chmodSync(unreadablePath, 0o600);
			}
		});
	});

	it("leaves uppercase auth.json API key values unchanged", () => {
		const agentDir = createAgentDir();
		fs.writeFileSync(
			path.join(agentDir, "auth.json"),
			`${JSON.stringify(
				{
					anthropic: { type: "api_key", key: "ANTHROPIC_API_KEY" },
					openai: { type: "api_key", key: "$OPENAI_API_KEY" },
					opencode: { type: "api_key", key: "public" },
					github: { type: "oauth", access: "ACCESS_TOKEN", refresh: "REFRESH_TOKEN", expires: 1 },
				},
				null,
				2,
			)}\n`,
			"utf-8",
		);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		withAgentDir(agentDir, () => runMigrations(agentDir));

		const migrated = JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf-8")) as Record<
			string,
			Record<string, unknown>
		>;
		expect(migrated.anthropic.key).toBe("ANTHROPIC_API_KEY");
		expect(migrated.openai.key).toBe("$OPENAI_API_KEY");
		expect(migrated.opencode.key).toBe("public");
		expect(migrated.github.access).toBe("ACCESS_TOKEN");
		expect(logSpy).not.toHaveBeenCalled();
	});

	it("persists migrated credentials before retiring legacy sources", () => {
		const agentDir = createAgentDir();
		const oauthPath = path.join(agentDir, "oauth.json");
		const settingsPath = path.join(agentDir, "settings.json");
		fs.writeFileSync(oauthPath, JSON.stringify({ github: { access: "oauth-token" } }), "utf-8");
		fs.writeFileSync(settingsPath, JSON.stringify({ theme: "dark", apiKeys: { openai: "api-key" } }), "utf-8");

		let providers: string[] = [];
		withAgentDir(agentDir, () => {
			providers = migrateAuthToAuthJson();
		});

		const authPath = path.join(agentDir, "auth.json");
		expect(providers.sort()).toEqual(["github", "openai"]);
		expect(JSON.parse(fs.readFileSync(authPath, "utf-8"))).toEqual({
			github: { type: "oauth", access: "oauth-token" },
			openai: { type: "api_key", key: "api-key" },
		});
		expect(fs.existsSync(oauthPath)).toBe(false);
		expect(fs.existsSync(`${oauthPath}.migrated`)).toBe(true);
		expect(JSON.parse(fs.readFileSync(settingsPath, "utf-8"))).toEqual({ theme: "dark" });
		if (process.platform !== "win32") {
			expect(fs.lstatSync(authPath).mode & 0o777).toBe(0o600);
			expect(fs.lstatSync(settingsPath).mode & 0o777).toBe(0o600);
		}
	});

	it.each([
		["malformed", '{\n  "providers": {\n'],
		["blank", ""],
	])("does not throw on %s models.json during migrations", async (_name, content) => {
		const agentDir = createAgentDir();
		const modelsPath = path.join(agentDir, "models.json");
		fs.writeFileSync(modelsPath, content, "utf-8");

		withAgentDir(agentDir, () => expect(() => runMigrations(agentDir)).not.toThrow());

		expect(fs.readFileSync(modelsPath, "utf-8")).toBe(content);
		const registry = await createTestModelRegistry(AuthStorage.create(path.join(agentDir, "auth.json")), modelsPath);
		const loadError = registry.getError();
		expect(loadError).toContain("Failed to parse models.json");
		expect(loadError).toContain(`File: ${modelsPath}`);
	});

	it("leaves uppercase models.json API key and header values unchanged", async () => {
		const agentDir = createAgentDir();
		const envKeys = ["CUSTOM_API_KEY", "HEADER_API_KEY", "MODEL_API_KEY", "OVERRIDE_API_KEY"];
		const savedEnv: Record<string, string | undefined> = {};
		for (const key of envKeys) {
			savedEnv[key] = process.env[key];
			process.env[key] = `env-${key}`;
		}

		try {
			fs.writeFileSync(
				path.join(agentDir, "models.json"),
				`${JSON.stringify(
					{
						providers: {
							"custom-provider": {
								baseUrl: "https://example.com/v1",
								apiKey: "CUSTOM_API_KEY",
								api: "openai-completions",
								headers: {
									"x-api-key": "HEADER_API_KEY",
									"x-literal": "literal",
								},
								models: [
									{
										id: "model-a",
										headers: { "x-model-key": "MODEL_API_KEY" },
									},
								],
								modelOverrides: {
									"model-b": { headers: { "x-override-key": "OVERRIDE_API_KEY" } },
								},
							},
						},
					},
					null,
					2,
				)}\n`,
				"utf-8",
			);
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

			withAgentDir(agentDir, () => runMigrations(agentDir));

			const migrated = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf-8")) as {
				providers: Record<
					string,
					{
						apiKey?: string;
						headers?: Record<string, string>;
						models?: Array<{ headers?: Record<string, string> }>;
						modelOverrides?: Record<string, { headers?: Record<string, string> }>;
					}
				>;
			};
			const provider = migrated.providers["custom-provider"]!;
			expect(provider.apiKey).toBe("CUSTOM_API_KEY");
			expect(provider.headers?.["x-api-key"]).toBe("HEADER_API_KEY");
			expect(provider.headers?.["x-literal"]).toBe("literal");
			expect(provider.models?.[0]?.headers?.["x-model-key"]).toBe("MODEL_API_KEY");
			expect(provider.modelOverrides?.["model-b"]?.headers?.["x-override-key"]).toBe("OVERRIDE_API_KEY");
			expect(logSpy).not.toHaveBeenCalled();

			const registry = await createTestModelRegistry(
				AuthStorage.create(path.join(agentDir, "auth.json")),
				path.join(agentDir, "models.json"),
			);
			const model = registry.find("custom-provider", "model-a");
			expect(model).toBeDefined();
			expect(await registry.getApiKeyForProvider("custom-provider")).toBe("CUSTOM_API_KEY");
			expect(await registry.getApiKeyAndHeaders(model!)).toMatchObject({
				ok: true,
				apiKey: "CUSTOM_API_KEY",
				headers: {
					"x-api-key": "HEADER_API_KEY",
					"x-literal": "literal",
					"x-model-key": "MODEL_API_KEY",
				},
			});
		} finally {
			for (const key of envKeys) {
				if (savedEnv[key] === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = savedEnv[key];
				}
			}
		}
	});
});
