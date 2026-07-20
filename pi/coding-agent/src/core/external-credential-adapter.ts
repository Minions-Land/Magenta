/**
 * External Credential Adapter (PHASE 1)
 *
 * Adapts Magenta's AuthStorage to pi-ai's CredentialStore contract and layers
 * external read-only file sources (Claude Code, Codex) as ambient credentials.
 *
 * Precedence per provider:
 *   1. Runtime override (--api-key, handled by RuntimeCredentials wrapper)
 *   2. Stored Magenta credential (auth.json via AuthStorage)
 *   3. External read-only file (Claude Code ~/.claude/settings.json, Codex ~/.codex/auth.json)
 *
 * External files are NEVER mutated or deleted. They provide ambient discovery only.
 * logout() removes stored credentials but leaves external files intact.
 *
 * External baseUrl and model are NOT stored in credentials; they're returned
 * through separate accessors for Phase 2 to inject into request auth.
 */

import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import type { AuthCredential, AuthStorage } from "./auth-storage.ts";
import { type ExternalCredential, loadClaudeCodeAuth, loadCodexAuth } from "./external-auth-loader.ts";
import { resolveConfigValue } from "./resolve-config-value.ts";

/**
 * Sync probe for non-persistent runtime API key overrides (--api-key set on the
 * shared AuthStorage). Layered credential stores delegate this downward so a
 * synchronous auth check (ModelRuntime.hasConfiguredAuth) can observe overrides
 * set after the availability snapshot was built, without an async refresh.
 */
export interface RuntimeApiKeyProbe {
	hasRuntimeApiKey(providerId: string): boolean;
}

/**
 * Type guard for credential stores that can synchronously report runtime API
 * key overrides. Used to traverse layered stores without an async refresh.
 */
export function hasRuntimeApiKeyProbe(store: unknown): store is RuntimeApiKeyProbe {
	return typeof (store as Partial<RuntimeApiKeyProbe>)?.hasRuntimeApiKey === "function";
}

/**
 * Adapt Magenta's AuthStorage to pi-ai CredentialStore.
 * AuthStorage has a sync API with OAuth refresh; pi-ai expects async with
 * OAuth refresh delegated to Models. We bridge the gap here.
 */
export class AuthStorageCredentialAdapter implements CredentialStore, RuntimeApiKeyProbe {
	private readonly authStorage: AuthStorage;

	constructor(authStorage: AuthStorage) {
		this.authStorage = authStorage;
	}

	hasRuntimeApiKey(providerId: string): boolean {
		return this.authStorage.getRuntimeApiKey(providerId) !== undefined;
	}

	async read(providerId: string): Promise<Credential | undefined> {
		// Runtime overrides (--api-key) set directly on the shared AuthStorage win,
		// matching the legacy AuthStorage runtime-override precedence.
		const runtimeKey = this.authStorage.getRuntimeApiKey(providerId);
		if (runtimeKey) return { type: "api_key", key: runtimeKey };

		const cred = this.authStorage.get(providerId);
		if (!cred) return undefined;

		// api_key credentials may carry $ENV/command config values that must be
		// resolved to a concrete key, matching upstream AuthStorage.read().
		if (cred.type === "api_key") {
			if (cred.key === undefined) return cred as Credential;
			return { ...cred, key: resolveConfigValue(cred.key, cred.env) } as Credential;
		}

		// OAuth credentials include refresh/access/expires per pi-ai OAuthCredential.
		return cred as Credential;
	}

	async list(): Promise<readonly CredentialInfo[]> {
		const entries = new Map<string, CredentialInfo>();
		for (const providerId of this.authStorage.list()) {
			const cred = this.authStorage.get(providerId);
			entries.set(providerId, { providerId, type: cred?.type ?? "api_key" });
		}
		// Surface runtime overrides set directly on AuthStorage as available api_key providers.
		for (const providerId of this.authStorage.listRuntimeApiKeyProviders()) {
			if (!entries.has(providerId)) entries.set(providerId, { providerId, type: "api_key" });
		}
		return [...entries.values()];
	}

	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		// AuthStorage.modify() provides the serialized read-modify-write under the
		// file lock, so concurrent OAuth refreshes cannot double-rotate a token.
		const result = await this.authStorage.modify(providerId, async (current) => {
			const next = await fn(current as Credential | undefined);
			return next as AuthCredential | undefined;
		});
		return result as Credential | undefined;
	}

	async delete(providerId: string): Promise<void> {
		this.authStorage.remove(providerId);
	}
}

/**
 * Layer external read-only file credentials on top of a base CredentialStore.
 * External sources (Claude Code, Codex) are consulted only when the base store
 * has no credential for a provider.
 */
export class ExternalCredentialStore implements CredentialStore, RuntimeApiKeyProbe {
	private readonly store: CredentialStore;
	private externalCache: Map<string, ExternalCredential> | undefined;
	private externalCacheTime = 0;

	constructor(store: CredentialStore) {
		this.store = store;
	}

	hasRuntimeApiKey(providerId: string): boolean {
		return hasRuntimeApiKeyProbe(this.store) && this.store.hasRuntimeApiKey(providerId);
	}

	/**
	 * Load external credentials with a 5-second cache to avoid repeated file reads.
	 */
	private getExternalCredentials(): Map<string, ExternalCredential> {
		const now = Date.now();
		if (this.externalCache && now - this.externalCacheTime < 5000) {
			return this.externalCache;
		}

		// Claude Code takes precedence over Codex for the same provider.
		const all = [...loadClaudeCodeAuth(), ...loadCodexAuth()];
		const map = new Map<string, ExternalCredential>();
		for (const cred of all) {
			if (!map.has(cred.provider) && cred.apiKey) {
				map.set(cred.provider, cred);
			}
		}

		this.externalCache = map;
		this.externalCacheTime = now;
		return map;
	}

	async read(providerId: string): Promise<Credential | undefined> {
		// Stored credential always wins.
		const stored = await this.store.read(providerId);
		if (stored) return stored;

		// Fall back to external file if no stored credential.
		const external = this.getExternalCredentials().get(providerId);
		if (!external?.apiKey) return undefined;

		// Return as api_key credential. External baseUrl/model are NOT part of
		// the credential; they're accessed separately via getExternalBaseUrl/Model.
		return {
			type: "api_key",
			key: external.apiKey,
		};
	}

	async list(): Promise<readonly CredentialInfo[]> {
		const stored = await this.store.list();
		const storedProviders = new Set(stored.map((entry) => entry.providerId));

		// Add external providers not already stored.
		const external = this.getExternalCredentials();
		const combined = [...stored];
		for (const [providerId, cred] of external) {
			if (!storedProviders.has(providerId) && cred.apiKey) {
				combined.push({ providerId, type: "api_key" });
			}
		}

		return combined;
	}

	/**
	 * Modify always targets the underlying store. External files are read-only.
	 */
	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		// Pass only the stored credential to fn, not external.
		// After a successful write, the stored credential shadows external.
		return this.store.modify(providerId, fn);
	}

	/**
	 * Delete removes stored credential. External files are NEVER deleted.
	 * After logout, read() may still return an external credential.
	 */
	async delete(providerId: string): Promise<void> {
		await this.store.delete(providerId);
		// External files remain untouched.
	}
}

/**
 * Get external baseUrl for a provider (from Claude Code or Codex config).
 * Returns undefined if no external source provides a baseUrl for this provider.
 *
 * Phase 2 will use this to inject baseUrl into request auth without mutating
 * the immutable provider catalog.
 */
export function getExternalBaseUrl(providerId: string): string | undefined {
	const all = [...loadClaudeCodeAuth(), ...loadCodexAuth()];
	for (const cred of all) {
		if (cred.provider === providerId && cred.baseUrl) {
			return cred.baseUrl;
		}
	}
	return undefined;
}

/**
 * Get external default model for a provider (from Claude Code or Codex config).
 * Returns undefined if no external source provides a model for this provider.
 */
export function getExternalModel(providerId: string): string | undefined {
	const all = [...loadClaudeCodeAuth(), ...loadCodexAuth()];
	for (const cred of all) {
		if (cred.provider === providerId && cred.model) {
			return cred.model;
		}
	}
	return undefined;
}

/**
 * Create a composite credential store for Magenta:
 * AuthStorage (stored) + External files (Claude/Codex, read-only).
 */
export function createMagentaCredentialStore(authStorage: AuthStorage): CredentialStore {
	const adapter = new AuthStorageCredentialAdapter(authStorage);
	return new ExternalCredentialStore(adapter);
}
