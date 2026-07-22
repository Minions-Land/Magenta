import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadCodexAuth, parseCodexBaseUrl, parseCodexModel } from "../src/core/external-auth-loader.ts";

describe("parseCodexBaseUrl", () => {
	it("resolves base_url from the active model_provider section", () => {
		// Mirrors a real config.toml where base_url lives in [model_providers.custom]
		// and is followed by many unrelated [projects.*] tables.
		const toml = `model_provider = "custom"
model = "gpt-5.5"
model_reasoning_effort = "xhigh"

[projects."/Users/test-user/foo"]
trust_level = "trusted"

[model_providers.custom]
name = "custom"
wire_api = "responses"
base_url = "https://tok.fan/v1"

[projects."/Users/test-user/bar"]
trust_level = "trusted"
`;
		expect(parseCodexBaseUrl(toml)).toBe("https://tok.fan/v1");
	});

	it("picks the active provider's base_url when multiple providers exist", () => {
		const toml = `model_provider = "second"

[model_providers.first]
base_url = "https://first.example/v1"

[model_providers.second]
base_url = "https://second.example/v1"
`;
		expect(parseCodexBaseUrl(toml)).toBe("https://second.example/v1");
	});

	it("does not guess a base_url when model_provider is absent", () => {
		const toml = `[model_providers.only]
base_url = "https://only.example/v1"
`;
		expect(parseCodexBaseUrl(toml)).toBeUndefined();
	});

	it("returns undefined when no base_url is present", () => {
		const toml = `model_provider = "custom"
model = "gpt-5.5"
`;
		expect(parseCodexBaseUrl(toml)).toBeUndefined();
	});

	it("does not leak a different provider's base_url when the active one lacks it", () => {
		// Active provider "custom" has no base_url; must not fall through to "other".
		// (Fallback only applies when model_provider is absent, so this returns undefined.)
		const toml = `model_provider = "custom"

[model_providers.custom]
name = "custom"

[model_providers.other]
base_url = "https://other.example/v1"
`;
		expect(parseCodexBaseUrl(toml)).toBeUndefined();
	});
});

describe("parseCodexModel", () => {
	it("reads a top-level model declaration", () => {
		const toml = `model_provider = "custom"
model = "gpt-5.5"

[model_providers.custom]
model = "should-not-win"
`;
		expect(parseCodexModel(toml)).toBe("gpt-5.5");
	});

	it("returns undefined when model is only inside a table", () => {
		const toml = `model_provider = "custom"

[model_providers.custom]
model = "inside-table"
`;
		expect(parseCodexModel(toml)).toBeUndefined();
	});
});

describe("loadCodexAuth", () => {
	it("ignores ChatGPT OAuth access tokens while preserving an explicit OpenAI API key", () => {
		const home = mkdtempSync(join(tmpdir(), "magenta-codex-auth-"));
		const codexDir = join(home, ".codex");
		mkdirSync(codexDir, { recursive: true });
		vi.stubEnv("HOME", home);

		try {
			writeFileSync(
				join(codexDir, "auth.json"),
				JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "oauth-access-token" } }),
			);
			expect(loadCodexAuth()).toEqual([]);

			writeFileSync(
				join(codexDir, "auth.json"),
				JSON.stringify({
					auth_mode: "chatgpt",
					tokens: { access_token: "oauth-access-token" },
					OPENAI_API_KEY: "explicit-api-key",
				}),
			);
			writeFileSync(
				join(codexDir, "config.toml"),
				'model_provider = "proxy"\nmodel = "gpt-test"\n[model_providers.proxy]\nbase_url = "https://proxy.example/v1"\n',
			);
			expect(loadCodexAuth()).toEqual([
				{
					provider: "openai",
					apiKey: "explicit-api-key",
					baseUrl: "https://proxy.example/v1",
					model: "gpt-test",
					source: "codex",
				},
			]);
		} finally {
			vi.unstubAllEnvs();
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("discovers credentials without mutating Codex auth or config files", () => {
		const home = mkdtempSync(join(tmpdir(), "magenta-codex-readonly-"));
		const codexDir = join(home, ".codex");
		const authPath = join(codexDir, "auth.json");
		const configPath = join(codexDir, "config.toml");
		mkdirSync(codexDir, { recursive: true });
		vi.stubEnv("HOME", home);

		try {
			writeFileSync(authPath, JSON.stringify({ OPENAI_API_KEY: "synthetic-readonly-key" }), { mode: 0o600 });
			writeFileSync(
				configPath,
				'model_provider = "proxy"\nmodel = "gpt-test"\n[model_providers.proxy]\nbase_url = "https://proxy.example/v1"\n',
				{ mode: 0o640 },
			);
			chmodSync(authPath, 0o600);
			chmodSync(configPath, 0o640);

			// A fixed old timestamp makes even a same-byte rewrite observable.
			const fixedTime = new Date("2001-02-03T04:05:06.000Z");
			utimesSync(authPath, fixedTime, fixedTime);
			utimesSync(configPath, fixedTime, fixedTime);
			const snapshot = (path: string) => {
				const stats = statSync(path, { bigint: true });
				return { bytes: readFileSync(path), mtimeNs: stats.mtimeNs, mode: stats.mode & 0o777n, inode: stats.ino };
			};
			const authBefore = snapshot(authPath);
			const configBefore = snapshot(configPath);

			expect(loadCodexAuth()).toEqual([
				{
					provider: "openai",
					apiKey: "synthetic-readonly-key",
					baseUrl: "https://proxy.example/v1",
					model: "gpt-test",
					source: "codex",
				},
			]);

			expect(snapshot(authPath)).toEqual(authBefore);
			expect(snapshot(configPath)).toEqual(configBefore);
		} finally {
			vi.unstubAllEnvs();
			rmSync(home, { recursive: true, force: true });
		}
	});
});
