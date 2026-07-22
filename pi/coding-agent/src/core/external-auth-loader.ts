/**
 * External Auth Loader
 *
 * Automatically loads API keys and base URLs from local tools so Magenta works
 * out of the box without a manual /login. Sources, in priority order:
 *   1. Environment variables (ANTHROPIC_AUTH_TOKEN/ANTHROPIC_API_KEY, OPENAI_API_KEY, ...)
 *   2. Claude Code  (~/.claude/settings.json -> env.ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL)
 *   3. Codex        (~/.codex/auth.json -> OPENAI_API_KEY, ~/.codex/config.toml -> base_url)
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";

export type ExternalCredentialSource = "env" | "claude-code" | "codex";

export type ExternalCredential = {
	provider: string;
	apiKey?: string;
	apiKeyIsBearerToken?: boolean;
	baseUrl?: string;
	model?: string;
	source: ExternalCredentialSource;
};

/** Read credentials from environment variables. */
export function loadEnvAuth(): ExternalCredential[] {
	const creds: ExternalCredential[] = [];

	const anthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
	const anthropicKey = anthropicAuthToken || process.env.ANTHROPIC_API_KEY;
	if (anthropicKey) {
		creds.push({
			provider: "anthropic",
			apiKey: anthropicKey,
			apiKeyIsBearerToken: Boolean(anthropicAuthToken),
			baseUrl: process.env.ANTHROPIC_BASE_URL,
			model: process.env.ANTHROPIC_MODEL,
			source: "env",
		});
	}

	if (process.env.OPENAI_API_KEY) {
		creds.push({
			provider: "openai",
			apiKey: process.env.OPENAI_API_KEY,
			baseUrl: process.env.OPENAI_BASE_URL,
			source: "env",
		});
	}

	const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
	if (geminiKey) {
		creds.push({ provider: "google", apiKey: geminiKey, baseUrl: process.env.GOOGLE_BASE_URL, source: "env" });
	}

	return creds;
}

/**
 * Read credentials from Claude Code's settings.json.
 * Claude Code keeps its provider config under the top-level `env` object,
 * e.g. { "env": { "ANTHROPIC_AUTH_TOKEN": "...", "ANTHROPIC_BASE_URL": "..." } }.
 */
export function loadClaudeCodeAuth(): ExternalCredential[] {
	const creds: ExternalCredential[] = [];
	const settingsPath = join(homedir(), ".claude", "settings.json");
	if (!existsSync(settingsPath)) return creds;

	try {
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		const env = (settings.env ?? {}) as Record<string, string>;
		const authToken = env.ANTHROPIC_AUTH_TOKEN;
		const key = authToken || env.ANTHROPIC_API_KEY;
		if (key) {
			creds.push({
				provider: "anthropic",
				apiKey: key,
				apiKeyIsBearerToken: Boolean(authToken),
				baseUrl: env.ANTHROPIC_BASE_URL,
				model: env.ANTHROPIC_MODEL || (typeof settings.model === "string" ? settings.model : undefined),
				source: "claude-code",
			});
		}
	} catch {
		// Ignore malformed settings.
	}

	return creds;
}

type TomlTable = Record<string, unknown>;

function asTomlTable(value: unknown): TomlTable | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as TomlTable) : undefined;
}

/** Structured TOML lookup: find `base_url` for the active provider in config.toml.
 *
 * Resolution order:
 *   1. Read `model_provider = "<name>"` from the top-level (pre-table) section.
 *   2. Find the matching `[model_providers.<name>]` section and return its base_url.
 *   3. If no provider is selected, return undefined rather than guessing an
 *      endpoint from an inactive or stale provider table.
 *
 * Exported for unit testing.
 */
export function parseCodexBaseUrl(toml: string): string | undefined {
	const config = asTomlTable(parse(toml));
	if (!config) return undefined;
	const activeProvider = typeof config.model_provider === "string" ? config.model_provider : undefined;

	if (!activeProvider) return undefined;
	const providers = asTomlTable(config.model_providers);
	const activeConfig = asTomlTable(providers?.[activeProvider]);
	return typeof activeConfig?.base_url === "string" ? activeConfig.base_url : undefined;
}

/** Find a top-level `model = "..."` (outside any [table]) in codex config.toml.
 *  Exported for unit testing. */
export function parseCodexModel(toml: string): string | undefined {
	const config = asTomlTable(parse(toml));
	return typeof config?.model === "string" ? config.model : undefined;
}

/**
 * Read credentials from Codex.
 * Key lives in ~/.codex/auth.json, which can be:
 *   - OAuth format: { "auth_mode": "chatgpt", "tokens": { "access_token": "..." } }
 *   - API key format: { "OPENAI_API_KEY": "sk-..." }
 * The custom base_url and default model live in ~/.codex/config.toml.
 *
 * Strategy:
 *   - OAuth tokens (ChatGPT Plus/Pro): ignore them here; the access token is
 *     not an OpenAI API key and Codex OAuth belongs to the openai-codex provider
 *   - API key: respect custom base_url and model from config.toml
 *   - If both OAuth and an API key exist, import only the explicit API key
 */
export function loadCodexAuth(): ExternalCredential[] {
	const creds: ExternalCredential[] = [];
	const codexDir = join(homedir(), ".codex");

	const authPath = join(codexDir, "auth.json");
	if (!existsSync(authPath)) return creds;

	let auth: any;
	try {
		auth = JSON.parse(readFileSync(authPath, "utf-8"));
	} catch {
		return creds;
	}

	// Read config.toml for base_url and model
	let baseUrl: string | undefined;
	let model: string | undefined;
	const configPath = join(codexDir, "config.toml");
	if (existsSync(configPath)) {
		try {
			const toml = readFileSync(configPath, "utf-8");
			baseUrl = parseCodexBaseUrl(toml);
			model = parseCodexModel(toml);
		} catch {
			// Ignore malformed config.
		}
	}

	// ChatGPT OAuth access tokens are deliberately not imported as OpenAI API keys.
	// An explicit API key can use the configured custom base URL.
	const explicitApiKey = auth.OPENAI_API_KEY || auth.openai?.key;
	if (explicitApiKey) {
		creds.push({
			provider: "openai",
			apiKey: explicitApiKey,
			baseUrl,
			model,
			source: "codex",
		});
	}

	return creds;
}

/** Load and merge all external credentials (first source wins per provider). */
export function loadExternalAuth(): ExternalCredential[] {
	const all = [...loadEnvAuth(), ...loadClaudeCodeAuth(), ...loadCodexAuth()];
	const seen = new Set<string>();
	return all.filter((cred) => {
		if (seen.has(cred.provider)) return false;
		seen.add(cred.provider);
		return true;
	});
}

/** Get credentials for a single provider from external sources. */
export function getExternalAuth(provider: string): ExternalCredential | undefined {
	return loadExternalAuth().find((cred) => cred.provider === provider);
}

/** True if any external credential is available. */
export function hasExternalAuth(): boolean {
	return loadExternalAuth().length > 0;
}
