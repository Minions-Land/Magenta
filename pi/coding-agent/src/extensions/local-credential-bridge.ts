/**
 * Keep Magenta credentials and provider URLs sourced from local Codex/Claude Code
 * config instead of copying secrets or endpoints into this repository.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ClaudeSettings = {
	env?: Record<string, unknown>;
};

function readText(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	return readFileSync(path, "utf8");
}

function readJson<T>(path: string): T | undefined {
	const text = readText(path);
	if (!text) return undefined;
	return JSON.parse(text) as T;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readTomlStringValue(text: string, key: string): string | undefined {
	const escapedKey = escapeRegExp(key);
	const match = new RegExp(`^\\s*${escapedKey}\\s*=\\s*"((?:\\\\.|[^"\\\\])*)"\\s*(?:#.*)?$`, "m").exec(text);
	if (!match) return undefined;

	try {
		return JSON.parse(`"${match[1]}"`) as string;
	} catch {
		return match[1];
	}
}

function readCodexProviderSection(text: string, providerName: string): string | undefined {
	const sectionName = escapeRegExp(providerName);
	const match = new RegExp(`^\\s*\\[model_providers\\.${sectionName}\\]\\s*$([\\s\\S]*?)(?=^\\s*\\[|\\s*$)`, "m").exec(
		text,
	);
	return match?.[1];
}

function readCodexBaseUrl(): string | undefined {
	const configText = readText(join(homedir(), ".codex", "config.toml"));
	if (!configText) return undefined;

	const providerName = readTomlStringValue(configText, "model_provider");
	if (!providerName) return undefined;

	const providerSection = readCodexProviderSection(configText, providerName);
	if (!providerSection) return undefined;

	return readTomlStringValue(providerSection, "base_url");
}

function readClaudeBaseUrl(): string | undefined {
	const settings = readJson<ClaudeSettings>(join(homedir(), ".claude", "settings.json"));
	const value = settings?.env?.ANTHROPIC_BASE_URL;
	return typeof value === "string" && value.trim() ? value : undefined;
}

export default function localCredentialBridge(pi: ExtensionAPI) {
	const codexBaseUrl = readCodexBaseUrl();
	if (codexBaseUrl) {
		pi.registerProvider("openai", { baseUrl: codexBaseUrl });
	}

	const claudeBaseUrl = readClaudeBaseUrl();
	if (claudeBaseUrl) {
		pi.registerProvider("anthropic", { baseUrl: claudeBaseUrl });
	}
}
