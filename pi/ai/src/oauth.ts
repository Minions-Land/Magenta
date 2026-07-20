/**
 * @deprecated Legacy OAuth registry compatibility layer for coding-agent extensions.
 * Delegates to provider-owned auth in `auth/oauth/*` without holding independent state.
 * W6 removes this facade after coding-agent migrates to ModelRuntime.
 */

import { anthropicOAuth } from "./auth/oauth/anthropic.ts";
import { githubCopilotOAuth } from "./auth/oauth/github-copilot.ts";
import { openaiCodexOAuth } from "./auth/oauth/openai-codex.ts";
import type { AuthInteraction, OAuthAuth, OAuthCredential } from "./auth/types.ts";
import type {
	OAuthCredentials,
	OAuthLoginCallbacks,
	OAuthProviderId,
	OAuthProviderInfo,
	OAuthProviderInterface,
} from "./compat/extension-oauth-types.ts";

// Re-export compatibility types for coding-agent
export type {
	OAuthAuthInfo,
	OAuthCredentials,
	OAuthDeviceCodeInfo,
	OAuthLoginCallbacks,
	OAuthPrompt,
	OAuthProvider,
	OAuthProviderId,
	OAuthProviderInfo,
	OAuthProviderInterface,
	OAuthSelectOption,
	OAuthSelectPrompt,
} from "./compat/extension-oauth-types.ts";

/** Convert legacy callbacks to AuthInteraction. */
function legacyCallbacksToInteraction(callbacks: OAuthLoginCallbacks): AuthInteraction {
	return {
		signal: callbacks.signal,
		prompt: async (prompt) => {
			if (prompt.type === "manual_code") {
				if (callbacks.onManualCodeInput) return callbacks.onManualCodeInput();
			}
			if (prompt.type === "select") {
				return (await callbacks.onSelect({ message: prompt.message, options: [...prompt.options] })) ?? "";
			}
			return callbacks.onPrompt({ message: prompt.message, placeholder: prompt.placeholder });
		},
		notify: (event) => {
			if (event.type === "auth_url") {
				callbacks.onAuth({ url: event.url, instructions: event.instructions });
			} else if (event.type === "device_code") {
				callbacks.onDeviceCode({
					userCode: event.userCode,
					verificationUri: event.verificationUri,
					intervalSeconds: event.intervalSeconds,
					expiresInSeconds: event.expiresInSeconds,
				});
			} else if (event.type === "progress") {
				callbacks.onProgress?.(event.message);
			}
		},
	};
}

/** Adapter wrapping canonical OAuthAuth as legacy OAuthProviderInterface. */
function createLegacyAdapter(
	id: string,
	name: string,
	oauth: OAuthAuth,
	options?: {
		usesCallbackServer?: boolean;
		modifyModels?: OAuthProviderInterface["modifyModels"];
	},
): OAuthProviderInterface {
	return {
		id,
		name,
		usesCallbackServer: options?.usesCallbackServer,
		async login(callbacks) {
			const credential = await oauth.login(legacyCallbacksToInteraction(callbacks));
			return credential;
		},
		async refreshToken(credentials) {
			const input: OAuthCredential = { type: "oauth", ...credentials };
			const refreshed = await oauth.refresh(input);
			return refreshed;
		},
		getApiKey(credentials) {
			// All built-in providers use credentials.access as the API key
			return credentials.access;
		},
		modifyModels: options?.modifyModels,
	};
}

// Built-in provider adapters delegating to canonical flows
const BUILT_IN_PROVIDERS: OAuthProviderInterface[] = [
	createLegacyAdapter("anthropic", "Anthropic (Claude Pro/Max)", anthropicOAuth, {
		usesCallbackServer: true,
	}),
	createLegacyAdapter("github-copilot", "GitHub Copilot", githubCopilotOAuth, {
		usesCallbackServer: false,
		// GitHub Copilot baseUrl is now per-credential via oauth.toAuth; modifyModels stays for W6 migration
		modifyModels(models, _credentials) {
			// Sync adapter: baseUrl comes from toAuth, but modifyModels is legacy sync API.
			// Since W6 removes this, keep simple pass-through; coding-agent ModelRegistry
			// will invoke this but the baseUrl rewrite moved to provider.auth.oauth.toAuth.
			return models;
		},
	}),
	createLegacyAdapter("openai-codex", "OpenAI (ChatGPT Plus/Pro)", openaiCodexOAuth, {
		usesCallbackServer: true,
	}),
];

/** Registry map: built-in adapters + extension-registered custom providers. */
const registry = new Map<string, OAuthProviderInterface>(BUILT_IN_PROVIDERS.map((p) => [p.id, p]));

/** @deprecated Get OAuth provider by id. */
export function getOAuthProvider(id: OAuthProviderId): OAuthProviderInterface | undefined {
	return registry.get(id);
}

/** @deprecated Register custom OAuth provider (extensions only). */
export function registerOAuthProvider(provider: OAuthProviderInterface): void {
	registry.set(provider.id, provider);
}

/** @deprecated Unregister OAuth provider. Restores built-in if present. */
export function unregisterOAuthProvider(id: string): void {
	const builtIn = BUILT_IN_PROVIDERS.find((p) => p.id === id);
	if (builtIn) {
		registry.set(id, builtIn);
	} else {
		registry.delete(id);
	}
}

/** @deprecated Reset to built-in providers. */
export function resetOAuthProviders(): void {
	registry.clear();
	for (const provider of BUILT_IN_PROVIDERS) {
		registry.set(provider.id, provider);
	}
}

/** @deprecated Get all registered OAuth providers. */
export function getOAuthProviders(): OAuthProviderInterface[] {
	return Array.from(registry.values());
}

/** @deprecated Get provider info list. */
export function getOAuthProviderInfoList(): OAuthProviderInfo[] {
	return getOAuthProviders().map((p) => ({ id: p.id, name: p.name, available: true }));
}

/** @deprecated Refresh OAuth token via provider. */
export async function refreshOAuthToken(
	providerId: OAuthProviderId,
	credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
	const provider = getOAuthProvider(providerId);
	if (!provider) throw new Error(`Unknown OAuth provider: ${providerId}`);
	return provider.refreshToken(credentials);
}

/**
 * @deprecated Get API key for a provider from OAuth credentials.
 * Refreshes expired tokens and returns updated credentials + API key.
 */
export async function getOAuthApiKey(
	providerId: OAuthProviderId,
	credentials: Record<string, OAuthCredentials>,
): Promise<{ newCredentials: OAuthCredentials; apiKey: string } | null> {
	const provider = getOAuthProvider(providerId);
	if (!provider) throw new Error(`Unknown OAuth provider: ${providerId}`);

	let creds = credentials[providerId];
	if (!creds) return null;

	// Refresh if expired
	if (Date.now() >= creds.expires) {
		try {
			creds = await provider.refreshToken(creds);
		} catch (_error) {
			throw new Error(`Failed to refresh OAuth token for ${providerId}`);
		}
	}

	const apiKey = provider.getApiKey(creds);
	return { newCredentials: creds, apiKey };
}
