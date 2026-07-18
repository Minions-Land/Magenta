/**
 * RuntimeCredentials (CC-048 P2.3, upstream 9993c969).
 *
 * Async credential store overlay for non-persistent runtime API keys (--api-key).
 * Runtime overrides win over the underlying store's stored/external credentials,
 * matching the legacy AuthStorage runtime-override precedence.
 */

import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { hasRuntimeApiKeyProbe, type RuntimeApiKeyProbe } from "./external-credential-adapter.ts";

export class RuntimeCredentials implements CredentialStore, RuntimeApiKeyProbe {
	private readonly store: CredentialStore;
	private readonly overrides = new Map<string, string>();

	constructor(store: CredentialStore) {
		this.store = store;
	}

	setRuntimeApiKey(providerId: string, apiKey: string): void {
		this.overrides.set(providerId, apiKey);
	}

	removeRuntimeApiKey(providerId: string): void {
		this.overrides.delete(providerId);
	}

	/**
	 * Live sync check for runtime API key overrides. Covers overrides set on this
	 * wrapper (ModelRuntime.setRuntimeApiKey) and those set directly on the shared
	 * AuthStorage further down the chain (authStorage.setRuntimeApiKey), so a
	 * synchronous auth check sees them without an async availability refresh.
	 */
	hasRuntimeApiKey(providerId: string): boolean {
		if (this.overrides.has(providerId)) return true;
		return hasRuntimeApiKeyProbe(this.store) && this.store.hasRuntimeApiKey(providerId);
	}

	async read(providerId: string): Promise<Credential | undefined> {
		const override = this.overrides.get(providerId);
		return override ? { type: "api_key", key: override } : this.store.read(providerId);
	}

	async list(): Promise<readonly CredentialInfo[]> {
		const entries = new Map((await this.store.list()).map((entry) => [entry.providerId, entry]));
		for (const providerId of this.overrides.keys()) {
			entries.set(providerId, { providerId, type: "api_key" });
		}
		return [...entries.values()];
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		return this.store.modify(providerId, fn);
	}

	async delete(providerId: string): Promise<void> {
		this.overrides.delete(providerId);
		await this.store.delete(providerId);
	}
}
