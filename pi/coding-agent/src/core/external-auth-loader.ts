/**
 * External Auth Loader
 *
 * Automatically loads API keys and base URLs from local tools so Magenta works
 * out of the box without a manual /login. Sources, in priority order:
 *   1. Environment variables (ANTHROPIC_AUTH_TOKEN/ANTHROPIC_API_KEY, OPENAI_API_KEY, ...)
 *   2. Claude Code  (~/.claude/settings.json -> env.ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL)
 *   3. Codex        (~/.codex/auth.json -> OPENAI_API_KEY, ~/.codex/config.toml -> base_url)
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export type ExternalCredentialSource = "env" | "claude-code" | "codex";

export type ExternalCredential = {
	provider: string;
	apiKey?: string;
	baseUrl?: string;
	model?: string;
	source: ExternalCredentialSource;
};

/** Read credentials from environment variables. */
export function loadEnvAuth(): ExternalCredential[] {
	const creds: ExternalCredential[] = [];

	const anthropicKey = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
	if (anthropicKey) {
		creds.push({
			provider: "anthropic",
			apiKey: anthropicKey,
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
		const key = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY;
		if (key) {
			creds.push({
				provider: "anthropic",
				apiKey: key,
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

/** Minimal TOML lookup: find `base_url` for the active provider in config.toml.
 *
 * Resolution order:
 *   1. Read `model_provider = "<name>"` from the top-level (pre-table) section.
 *   2. Find the matching `[model_providers.<name>]` section and return its base_url.
 *   3. Fall back to the first base_url found anywhere in the file.
 *
 * Exported for unit testing.
 */
export function parseCodexBaseUrl(toml: string): string | undefined {
	const lines = toml.split("\n");

	// Step 1: find active provider name from top-level config (before any [table]).
	let activeProvider: string | undefined;
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith("[")) break;
		const m = trimmed.match(/^model_provider\s*=\s*"([^"]+)"/);
		if (m) {
			activeProvider = m[1];
			break;
		}
	}

	// Step 2: if we know the active provider, read base_url from its section only.
	// We must NOT fall back to a different provider's base_url here, otherwise we'd
	// mislabel the active provider with someone else's endpoint.
	if (activeProvider) {
		const sectionHeader = `[model_providers.${activeProvider}]`;
		let inSection = false;
		for (const line of lines) {
			const trimmed = line.trim();
			if (trimmed === sectionHeader) {
				inSection = true;
				continue;
			}
			if (inSection) {
				if (trimmed.startsWith("[")) break; // left the section
				const m = trimmed.match(/^base_url\s*=\s*"([^"]+)"/);
				if (m) return m[1];
			}
		}
		// Active provider declared but has no base_url: return undefined rather than
		// borrowing another provider's URL.
		return undefined;
	}

	// Step 3: no active provider declared — fall back to first base_url anywhere.
	const fallback = toml.match(/base_url\s*=\s*"([^"]+)"/);
	return fallback?.[1];
}

/** Find a top-level `model = "..."` (outside any [table]) in codex config.toml.
 *  Exported for unit testing. */
export function parseCodexModel(toml: string): string | undefined {
	for (const line of toml.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith("[")) break; // stop at first table header
		const match = trimmed.match(/^model\s*=\s*"([^"]+)"/);
		if (match) return match[1];
	}
	return undefined;
}

/**
 * Read credentials from Codex.
 * Key lives in ~/.codex/auth.json, which can be:
 *   - OAuth format: { "auth_mode": "chatgpt", "tokens": { "access_token": "..." } }
 *   - API key format: { "OPENAI_API_KEY": "sk-..." }
 * The custom base_url and default model live in ~/.codex/config.toml.
 *
 * Strategy:
 *   - OAuth tokens (ChatGPT Plus/Pro): ignore custom base_url, use official OpenAI API
 *   - API key: respect custom base_url and model from config.toml
 *   - If both OPENAI_API_KEY and custom provider exist: create multiple credentials
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

	// Case 1: OAuth token (ChatGPT Plus/Pro)
	// OAuth tokens only work with official OpenAI API, ignore custom base_url
	if (auth.auth_mode === "chatgpt" && auth.tokens?.access_token) {
		creds.push({
			provider: "openai",
			apiKey: auth.tokens.access_token,
			baseUrl: undefined, // Force official API for OAuth
			model: undefined, // Let Magenta choose default model
			source: "codex",
		});
	}

	// Case 2: API key (can use custom base_url)
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
