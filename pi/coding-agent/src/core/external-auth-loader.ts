/**
 * External Auth Loader
 *
 * Automatically loads API keys and credentials from external tools:
 * - Claude Code (~/.claude/)
 * - OpenAI Codex (~/.openai/)
 * - Environment variables (ANTHROPIC_AUTH_TOKEN, etc.)
 *
 * This allows Magenta to reuse existing credentials without manual configuration.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export type ExternalCredential = {
	provider: string;
	apiKey?: string;
	baseUrl?: string;
	source: "claude-code" | "codex" | "openai" | "env";
};

/**
 * Load credentials from environment variables
 */
export function loadEnvAuth(): ExternalCredential[] {
	const credentials: ExternalCredential[] = [];

	// Check for Anthropic credentials
	const anthropicToken = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
	if (anthropicToken) {
		credentials.push({
			provider: "anthropic",
			apiKey: anthropicToken,
			baseUrl: process.env.ANTHROPIC_BASE_URL,
			source: "env",
		});
	}

	// Check for OpenAI credentials
	const openaiKey = process.env.OPENAI_API_KEY;
	if (openaiKey) {
		credentials.push({
			provider: "openai",
			apiKey: openaiKey,
			baseUrl: process.env.OPENAI_BASE_URL,
			source: "env",
		});
	}

	// Check for Google/Gemini credentials
	const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
	if (geminiKey) {
		credentials.push({
			provider: "google",
			apiKey: geminiKey,
			baseUrl: process.env.GOOGLE_BASE_URL,
			source: "env",
		});
	}

	return credentials;
}

/**
 * Attempt to load credentials from Claude Code configuration
 */
export function loadClaudeCodeAuth(): ExternalCredential[] {
	const credentials: ExternalCredential[] = [];
	const claudeDir = join(homedir(), ".claude");

	// Try auth.json
	const authPath = join(claudeDir, "auth.json");
	if (existsSync(authPath)) {
		try {
			const content = readFileSync(authPath, "utf-8");
			const authData = JSON.parse(content);

			// Claude Code stores Anthropic credentials
			if (authData.anthropic?.type === "api_key" && authData.anthropic.key) {
				credentials.push({
					provider: "anthropic",
					apiKey: authData.anthropic.key,
					source: "claude-code",
				});
			}

			// May also have other providers
			for (const [provider, cred] of Object.entries(authData)) {
				if (typeof cred === "object" && cred !== null && "key" in cred && typeof cred.key === "string") {
					if (provider !== "anthropic") { // Already added above
						credentials.push({
							provider,
							apiKey: cred.key,
							source: "claude-code",
						});
					}
				}
			}
		} catch (error) {
			// Silently ignore parsing errors
		}
	}

	// Try settings.json for custom API endpoints
	const settingsPath = join(claudeDir, "settings.json");
	if (existsSync(settingsPath)) {
		try {
			const content = readFileSync(settingsPath, "utf-8");
			const settings = JSON.parse(content);

			// Check for custom API base URLs
			if (settings.apiBaseUrl) {
				// Find matching credential and add baseUrl
				const existingCred = credentials.find(c => c.provider === "anthropic");
				if (existingCred) {
					existingCred.baseUrl = settings.apiBaseUrl;
				}
			}
		} catch (error) {
			// Silently ignore
		}
	}

	return credentials;
}

/**
 * Attempt to load credentials from OpenAI Codex configuration
 */
export function loadCodexAuth(): ExternalCredential[] {
	const credentials: ExternalCredential[] = [];
	const openaiDir = join(homedir(), ".openai");

	// Try auth.json
	const authPath = join(openaiDir, "auth.json");
	if (existsSync(authPath)) {
		try {
			const content = readFileSync(authPath, "utf-8");
			const authData = JSON.parse(content);

			// Codex stores OpenAI credentials
			if (authData.openai?.type === "api_key" && authData.openai.key) {
				credentials.push({
					provider: "openai",
					apiKey: authData.openai.key,
					source: "codex",
				});
			}

			// Check for base URL customization
			if (authData.openai?.env?.OPENAI_BASE_URL) {
				const existingCred = credentials.find(c => c.provider === "openai");
				if (existingCred) {
					existingCred.baseUrl = authData.openai.env.OPENAI_BASE_URL;
				}
			}
		} catch (error) {
			// Silently ignore
		}
	}

	// Also check ~/.openai/config for older Codex versions
	const configPath = join(openaiDir, "config");
	if (existsSync(configPath)) {
		try {
			const content = readFileSync(configPath, "utf-8");
			const lines = content.split("\n");

			let apiKey: string | undefined;
			let baseUrl: string | undefined;

			for (const line of lines) {
				const trimmed = line.trim();
				if (trimmed.startsWith("api_key=") || trimmed.startsWith("OPENAI_API_KEY=")) {
					apiKey = trimmed.split("=")[1]?.trim();
				}
				if (trimmed.startsWith("base_url=") || trimmed.startsWith("OPENAI_BASE_URL=")) {
					baseUrl = trimmed.split("=")[1]?.trim();
				}
			}

			if (apiKey && !credentials.find(c => c.provider === "openai")) {
				credentials.push({
					provider: "openai",
					apiKey,
					baseUrl,
					source: "codex",
				});
			}
		} catch (error) {
			// Silently ignore
		}
	}

	return credentials;
}

/**
 * Load all available external credentials
 */
export function loadExternalAuth(): ExternalCredential[] {
	const credentials: ExternalCredential[] = [];

	// Load from environment variables first (highest priority for external sources)
	credentials.push(...loadEnvAuth());

	// Load from Claude Code
	credentials.push(...loadClaudeCodeAuth());

	// Load from Codex
	credentials.push(...loadCodexAuth());

	// Deduplicate by provider (first one wins)
	const seen = new Set<string>();
	return credentials.filter(cred => {
		if (seen.has(cred.provider)) {
			return false;
		}
		seen.add(cred.provider);
		return true;
	});
}

/**
 * Get a specific provider's credentials from external sources
 */
export function getExternalAuth(provider: string): ExternalCredential | undefined {
	const allCreds = loadExternalAuth();
	return allCreds.find(cred => cred.provider === provider);
}

/**
 * Check if any external credentials are available
 */
export function hasExternalAuth(): boolean {
	return loadExternalAuth().length > 0;
}
