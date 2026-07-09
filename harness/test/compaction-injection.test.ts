import { describe, expect, it } from "vitest";
import {
	buildDefaultCapabilityHcp,
	type CapabilityBuilderTable,
	createCapabilityMagnet,
} from "../harness-component-protocol/assembly/capability.ts";
import { piCompactionProvider } from "../modules/compaction/pi/provider.ts";

const CONTEXT = { repoRoot: process.cwd(), packagesRoot: process.cwd() };

/**
 * Compaction capability HCP resolution & source-selection tests.
 *
 * Route B (post AgentHarness removal): these test the HCP assembly/resolution
 * layer DIRECTLY — the layer that actually decides which source's provider a
 * consumer runs. The former AgentHarness-wrapper plumbing tests (harness.compact(),
 * setResources round-trips) went away with the wrapper; the capability-injection
 * SEMANTICS they guarded (by-name resolution, source switchability) are preserved
 * here at the layer that owns them.
 */
describe("compaction capability HCP resolution", () => {
	it("assembles the compaction capability from the pi source and returns the pi provider", async () => {
		// The built-in table maps compaction:pi -> piCompactionProvider by reference.
		const { magnet, diagnostics } = await createCapabilityMagnet({
			component: { kind: "compaction", name: "compaction", source: "pi" },
			context: CONTEXT,
		});
		expect(diagnostics).toEqual([]);
		const binding = magnet?.toCapability?.();
		expect(binding).toMatchObject({ kind: "compaction", name: "compaction", source: "pi" });
		expect(binding?.instance).toBe(piCompactionProvider);
	});

	it("resolves compaction by name from HCP, reaching the injected implementation", async () => {
		// A one-entry table proves source selection lives in assembly, not the consumer.
		// The consumer names only "compaction" and gets the spy the table selected.
		const spy = { defaultSettings: piCompactionProvider.defaultSettings, marker: "SPY" };
		const { hcp, diagnostics } = await buildDefaultCapabilityHcp(CONTEXT, {
			builders: { "compaction:spy": () => spy } as CapabilityBuilderTable,
			defaults: { compaction: "spy" },
		});
		expect(diagnostics).toEqual([]);

		const resolved = hcp.resolveCapability<typeof spy>("compaction");
		expect(resolved).toBe(spy);
		expect(resolved?.marker).toBe("SPY");
	});

	it("flips the resolved implementation when the selected source changes", async () => {
		// End-to-end switchability: identical consumer code, two sources in one table.
		// Flipping which source the default policy picks changes the instance the
		// consumer resolves — proving selection lives in assembly, consumer is source-agnostic.
		const builders: CapabilityBuilderTable = {
			"compaction:pi": () => ({ label: "PI IMPL" }),
			"compaction:magenta": () => ({ label: "MAGENTA IMPL" }),
		};

		async function labelFor(source: string): Promise<string> {
			const { hcp } = await buildDefaultCapabilityHcp(CONTEXT, { builders, defaults: { compaction: source } });
			const resolved = hcp.resolveCapability<{ label: string }>("compaction");
			return resolved?.label ?? "NONE";
		}

		expect(await labelFor("pi")).toBe("PI IMPL");
		expect(await labelFor("magenta")).toBe("MAGENTA IMPL");
	});
});
