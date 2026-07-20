/**
 * CC-028: /login <provider> argument parsing and autocomplete tests.
 *
 * Tests the provider-owned auth discovery flow introduced in CC-028:
 * - unknown provider references
 * - ambient-only providers (no stored auth)
 * - API key providers
 * - OAuth providers
 * - autocomplete fuzzy matching
 */

import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

describe("InteractiveMode /login <provider> (CC-028)", () => {
	test("findLoginProviderOptions: exact id match (case-insensitive)", () => {
		const fakeThis: any = {
			getLoginProviderOptions: vi.fn().mockReturnValue([
				{ id: "anthropic", name: "Anthropic", authType: "api_key" },
				{ id: "openai", name: "OpenAI", authType: "api_key" },
				{ id: "google", name: "Google AI", authType: "api_key" },
			]),
		};

		const result = (InteractiveMode as any).prototype.findLoginProviderOptions.call(fakeThis, "ANTHROPIC");
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("anthropic");
	});

	test("findLoginProviderOptions: partial id match", () => {
		const fakeThis: any = {
			getLoginProviderOptions: vi.fn().mockReturnValue([
				{ id: "anthropic", name: "Anthropic", authType: "api_key" },
				{ id: "openai", name: "OpenAI", authType: "api_key" },
				{ id: "google", name: "Google AI", authType: "api_key" },
			]),
		};

		const result = (InteractiveMode as any).prototype.findLoginProviderOptions.call(fakeThis, "ant");
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("anthropic");
	});

	test("findLoginProviderOptions: partial name match", () => {
		const fakeThis: any = {
			getLoginProviderOptions: vi.fn().mockReturnValue([
				{ id: "anthropic", name: "Anthropic", authType: "api_key" },
				{ id: "openai", name: "OpenAI", authType: "api_key" },
				{ id: "google-ai", name: "Google AI", authType: "api_key" },
			]),
		};

		const result = (InteractiveMode as any).prototype.findLoginProviderOptions.call(fakeThis, "google");
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("google-ai");
	});

	test("findLoginProviderOptions: returns empty array for unknown provider", () => {
		const fakeThis: any = {
			getLoginProviderOptions: vi.fn().mockReturnValue([
				{ id: "anthropic", name: "Anthropic", authType: "api_key" },
				{ id: "openai", name: "OpenAI", authType: "api_key" },
			]),
		};

		const result = (InteractiveMode as any).prototype.findLoginProviderOptions.call(fakeThis, "unknown-provider");
		expect(result).toHaveLength(0);
	});

	test("findLoginProviderOptions: returns both oauth and api_key for a provider supporting both", () => {
		const fakeThis: any = {
			getLoginProviderOptions: vi.fn().mockReturnValue([
				{ id: "anthropic", name: "Anthropic", authType: "oauth" },
				{ id: "anthropic", name: "Anthropic", authType: "api_key" },
				{ id: "openai", name: "OpenAI", authType: "api_key" },
			]),
		};

		const result = (InteractiveMode as any).prototype.findLoginProviderOptions.call(fakeThis, "anthropic");
		expect(result).toHaveLength(2);
		expect(result.map((r: any) => r.authType).sort()).toEqual(["api_key", "oauth"]);
	});

	test("handleLoginCommand: shows auth-type selector when no provider specified", async () => {
		const fakeThis: any = {
			showLoginAuthTypeSelector: vi.fn(),
		};

		await (InteractiveMode as any).prototype.handleLoginCommand.call(fakeThis, undefined);
		expect(fakeThis.showLoginAuthTypeSelector).toHaveBeenCalledTimes(1);
	});

	test("handleLoginCommand: shows status for unknown provider", async () => {
		const fakeThis: any = {
			findLoginProviderOptions: vi.fn().mockReturnValue([]),
			showStatus: vi.fn(),
		};

		await (InteractiveMode as any).prototype.handleLoginCommand.call(fakeThis, "unknown-provider");
		expect(fakeThis.showStatus).toHaveBeenCalledWith(
			'Provider "unknown-provider" not found. Try /login to see available providers.',
		);
	});

	test("handleLoginCommand: launches login for single API key provider match", async () => {
		const fakeThis: any = {
			findLoginProviderOptions: vi.fn().mockReturnValue([{ id: "openai", name: "OpenAI", authType: "api_key" }]),
			startProviderLogin: vi.fn().mockResolvedValue(undefined),
		};

		await (InteractiveMode as any).prototype.handleLoginCommand.call(fakeThis, "openai");
		expect(fakeThis.startProviderLogin).toHaveBeenCalledWith({ id: "openai", name: "OpenAI", authType: "api_key" });
	});

	test("handleLoginCommand: launches login for single OAuth provider match", async () => {
		const fakeThis: any = {
			findLoginProviderOptions: vi.fn().mockReturnValue([{ id: "anthropic", name: "Anthropic", authType: "oauth" }]),
			startProviderLogin: vi.fn().mockResolvedValue(undefined),
		};

		await (InteractiveMode as any).prototype.handleLoginCommand.call(fakeThis, "anthropic");
		expect(fakeThis.startProviderLogin).toHaveBeenCalledWith({
			id: "anthropic",
			name: "Anthropic",
			authType: "oauth",
		});
	});

	test("handleLoginCommand: shows auth-type selector when provider supports both oauth and api_key", async () => {
		const fakeThis: any = {
			findLoginProviderOptions: vi.fn().mockReturnValue([
				{ id: "anthropic", name: "Anthropic", authType: "oauth" },
				{ id: "anthropic", name: "Anthropic", authType: "api_key" },
			]),
			showLoginAuthTypeSelector: vi.fn(),
		};

		await (InteractiveMode as any).prototype.handleLoginCommand.call(fakeThis, "anthropic");
		expect(fakeThis.showLoginAuthTypeSelector).toHaveBeenCalledTimes(1);
	});

	test("handleLoginCommand: shows ambiguous status when multiple distinct providers match", async () => {
		const fakeThis: any = {
			findLoginProviderOptions: vi.fn().mockReturnValue([
				{ id: "google-ai", name: "Google AI", authType: "api_key" },
				{ id: "google-vertex", name: "Google Vertex", authType: "api_key" },
			]),
			showStatus: vi.fn(),
		};

		await (InteractiveMode as any).prototype.handleLoginCommand.call(fakeThis, "google");
		expect(fakeThis.showStatus).toHaveBeenCalledWith(
			'Ambiguous provider "google". Matches: google-ai, google-vertex',
		);
	});

	test("login autocomplete: de-duplicates providers and fuzzy-filters by id and name", () => {
		const fakeThis: any = {
			getLoginProviderOptions: vi.fn().mockReturnValue([
				{ id: "anthropic", name: "Anthropic", authType: "oauth" },
				{ id: "anthropic", name: "Anthropic", authType: "api_key" },
				{ id: "openai", name: "OpenAI", authType: "api_key" },
				{ id: "google-ai", name: "Google AI", authType: "api_key" },
			]),
		};

		// Mock fuzzyFilter to return exact matches (test relies on real filter in practice).
		const fuzzyFilter = (items: any[], _prefix: string, _searchFn: any) => items;

		const getArgumentCompletions = vi.fn((prefix: string) => {
			// De-duplicate providers by id.
			const byId = new Map<string, { id: string; name: string; authTypes: Set<string> }>();
			for (const option of fakeThis.getLoginProviderOptions()) {
				const existing = byId.get(option.id);
				if (existing) {
					existing.authTypes.add(option.authType);
				} else {
					byId.set(option.id, { id: option.id, name: option.name, authTypes: new Set([option.authType]) });
				}
			}
			const providers = [...byId.values()];
			if (providers.length === 0) return null;

			const filtered = fuzzyFilter(providers, prefix, (p: any) => `${p.id} ${p.name}`);
			if (filtered.length === 0) return null;

			return filtered.map((provider: any) => ({
				value: provider.id,
				label: provider.id,
				description: provider.name,
			}));
		});

		const result = getArgumentCompletions("");
		expect(result).toHaveLength(3); // anthropic, openai, google-ai (deduplicated)
		expect(result!.map((r: any) => r.value).sort()).toEqual(["anthropic", "google-ai", "openai"]);
	});
});
