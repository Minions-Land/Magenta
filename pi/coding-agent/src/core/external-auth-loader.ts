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

/** Minimal TOML lookup: find `base_url = "..."` inside the [model_providers.*] table. */
function parseCodexBaseUrl(toml: string): string | undefined {
	// Grab the first base_url under any model_providers section.
	const match = toml.match(/base_url\s*=\s*"([^"]+)"/);
	return match?.[1];
}

/** Find a top-level `model = "..."` (outside any [table]) in codex config.toml. */
function parseCodexModel(toml: string): string | undefined {
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
 * Key lives in ~/.codex/auth.json ({ "OPENAI_API_KEY": "..." }); the custom
 * base_url and default model live in ~/.codex/config.toml.
 */
export function loadCodexAuth(): ExternalCredential[] {
	const creds: ExternalCredential[] = [];
	const codexDir = join(homedir(), ".codex");

	const authPath = join(codexDir, "auth.json");
	if (!existsSync(authPath)) return creds;

	let apiKey: string | undefined;
	try {
		const auth = JSON.parse(readFileSync(authPath, "utf-8"));
		apiKey = auth.OPENAI_API_KEY || auth.openai?.key;
	} catch {
		return creds;
	}
	if (!apiKey) return creds;

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

	creds.push({ provider: "openai", apiKey, baseUrl, model, source: "codex" });
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
