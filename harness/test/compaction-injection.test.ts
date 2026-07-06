import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../core/env/pi/nodejs.ts";
import { AgentHarness } from "../core/loop/pi/agent-harness.ts";
import { InMemorySessionStorage } from "../core/session/pi/memory-storage.ts";
import { Session } from "../core/session/pi/session.ts";
import { ok } from "../core/types/types.ts";
import {
	buildDefaultCapabilityHcp,
	type CapabilityBuilderTable,
	createCapabilityMagnet,
} from "../hcp-client/assembly/capability.ts";
import type { CompactionPreparation, CompactionResult } from "../modules/compaction/contract.ts";
import { type CompactionProvider, piCompactionProvider } from "../modules/compaction/pi/provider.ts";

const models = createModels();

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 0 } as AgentMessage;
}

/**
 * A spy CompactionProvider: records calls and returns canned values so the loop
 * never touches an LLM. Proves the harness consumes the INJECTED capability
 * instead of the statically imported pi implementation.
 */
function spyProvider(): { provider: CompactionProvider; calls: string[] } {
	const calls: string[] = [];
	const preparation: CompactionPreparation = {
		firstKeptEntryId: "kept",
		messagesToSummarize: [],
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: 42,
		fileOps: { read: new Set(), written: new Set(), edited: new Set() },
		settings: piCompactionProvider.defaultSettings,
	};
	const result: CompactionResult = {
		summary: "SPY SUMMARY",
		firstKeptEntryId: "kept",
		tokensBefore: 42,
	};
	return {
		calls,
		provider: {
			defaultSettings: piCompactionProvider.defaultSettings,
			prepareCompaction: () => {
				calls.push("prepareCompaction");
				return ok(preparation);
			},
			compact: async () => {
				calls.push("compact");
				return ok(result);
			},
			collectEntriesForBranchSummary: async () => {
				calls.push("collectEntriesForBranchSummary");
				return { entries: [], commonAncestorId: null };
			},
			generateBranchSummary: async () => {
				calls.push("generateBranchSummary");
				return ok({ summary: "SPY BRANCH", readFiles: [], modifiedFiles: [] });
			},
		},
	};
}

describe("compaction capability injection", () => {
	it("routes harness.compact() through the injected provider, not the static import", async () => {
		const session = new Session(new InMemorySessionStorage());
		await session.appendMessage(userMessage("hello"));
		const { provider, calls } = spyProvider();
		const harness = new AgentHarness({
			models,
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: getModel("anthropic", "claude-sonnet-4-5"),
			resources: { compaction: provider },
		});

		const result = await harness.compact();

		expect(calls).toContain("prepareCompaction");
		expect(calls).toContain("compact");
		expect(result.summary).toBe("SPY SUMMARY");
		// The compaction entry the loop persisted came from the injected provider.
		const entries = await session.getEntries();
		expect(entries.some((entry) => entry.type === "compaction")).toBe(true);
	});

	it("falls back to the pi provider when none is injected", async () => {
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			models,
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: getModel("anthropic", "claude-sonnet-4-5"),
		});
		// Empty branch -> pi prepareCompaction returns undefined -> "Nothing to compact".
		await expect(harness.compact()).rejects.toThrow(/Nothing to compact/);
	});

	it("assembles the compaction capability from the pi source and feeds it to the harness", async () => {
		// The built-in capability table maps compaction:pi to piCompactionProvider;
		// no import side-effect or registration is involved.
		const { magnet, diagnostics } = await createCapabilityMagnet({
			component: { kind: "compaction", name: "compaction", source: "pi" },
			context: { repoRoot: process.cwd(), packagesRoot: process.cwd() },
		});
		expect(diagnostics).toEqual([]);
		const binding = magnet?.toCapability?.();
		expect(binding).toMatchObject({ kind: "compaction", name: "compaction", source: "pi" });
		expect(binding?.instance).toBe(piCompactionProvider);

		// The assembled binding is exactly what the harness accepts as its capability.
		const session = new Session(new InMemorySessionStorage());
		await session.appendMessage(userMessage("hello"));
		const harness = new AgentHarness({
			models,
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: getModel("anthropic", "claude-sonnet-4-5"),
			resources: { compaction: binding?.instance as CompactionProvider },
		});
		// pi provider on a single-user-message branch also has nothing to compact,
		// which confirms the assembled pi instance is wired in and executing.
		await expect(harness.compact()).rejects.toThrow(/Nothing to compact/);
	});

	it("resolves compaction by name from resources.hcp when no provider is injected directly", async () => {
		// The loop names no source: it resolves "compaction" from the injected HCP.
		// A one-entry table proves selection lives in assembly, not the loop.
		const { hcp, diagnostics } = await buildDefaultCapabilityHcp(
			{ repoRoot: process.cwd(), packagesRoot: process.cwd() },
			{ builders: { "compaction:spy": () => spyProvider().provider }, defaults: { compaction: "spy" } },
		);
		expect(diagnostics).toEqual([]);

		const session = new Session(new InMemorySessionStorage());
		await session.appendMessage(userMessage("hello"));
		const harness = new AgentHarness({
			models,
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: getModel("anthropic", "claude-sonnet-4-5"),
			resources: { hcp },
		});

		// The spy's canned preparation is non-empty, so compaction runs to completion —
		// proving the by-name HCP resolution reached the injected implementation.
		const result = await harness.compact();
		expect(result.summary).toBe("SPY SUMMARY");
	});

	it("flips the implementation the consumer runs when the selected source changes", async () => {
		// End-to-end switchability: identical harness/consumer code, two sources in
		// one table. Flipping which source the default policy picks changes the
		// provider harness.compact() actually executes — proving selection lives in
		// assembly and the loop is source-agnostic.
		function labelledProvider(summary: string): CompactionProvider {
			const base = spyProvider().provider;
			return { ...base, compact: async () => ok({ summary, firstKeptEntryId: "kept", tokensBefore: 42 }) };
		}
		const builders: CapabilityBuilderTable = {
			"compaction:pi": () => labelledProvider("PI SUMMARY"),
			"compaction:magenta": () => labelledProvider("MAGENTA SUMMARY"),
		};
		const context = { repoRoot: process.cwd(), packagesRoot: process.cwd() };

		async function summaryFor(source: string): Promise<string> {
			const { hcp } = await buildDefaultCapabilityHcp(context, { builders, defaults: { compaction: source } });
			const session = new Session(new InMemorySessionStorage());
			await session.appendMessage(userMessage("hello"));
			const harness = new AgentHarness({
				models,
				env: new NodeExecutionEnv({ cwd: process.cwd() }),
				session,
				model: getModel("anthropic", "claude-sonnet-4-5"),
				resources: { hcp },
			});
			return (await harness.compact()).summary;
		}

		expect(await summaryFor("pi")).toBe("PI SUMMARY");
		expect(await summaryFor("magenta")).toBe("MAGENTA SUMMARY");
	});

	it("preserves injected capabilities across setResources round-trips", async () => {
		const session = new Session(new InMemorySessionStorage());
		await session.appendMessage(userMessage("hello"));
		const { provider } = spyProvider();
		const harness = new AgentHarness({
			models,
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: getModel("anthropic", "claude-sonnet-4-5"),
			resources: { compaction: provider },
		});

		// setResources with only skills must NOT drop the injected compaction capability.
		await harness.setResources({ skills: [] });
		expect(harness.getResources().compaction).toBe(provider);
		const result = await harness.compact();
		expect(result.summary).toBe("SPY SUMMARY");
	});
});
