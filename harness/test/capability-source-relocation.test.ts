import { describe, expect, it } from "vitest";
import { buildDefaultCapabilityHcp, createCapabilityMagnet } from "../hcp-client/assembly/capability.ts";
import { CAPABILITY_SOURCE_MAGNETS } from "../hcp-client/assembly/sources.ts";

/**
 * Locks in the spec §8 Magnet relocation: the central `BUILTIN_CAPABILITY_BUILDERS`
 * / `DEFAULT_CAPABILITY_SOURCES` literals were dissolved. Each built-in capability
 * source now owns `<module>/<source>/magnet.ts` and is collected by the dumb
 * `sources.ts` barrel; the builder table + default map are DERIVED from it.
 *
 * These guards fail if a source magnet silently drops out of the barrel, loses
 * its `isDefault` flag, or a duplicate/default collision creeps in — the failure
 * modes that would otherwise only surface as a missing capability at runtime.
 */
describe("§8 capability source-magnet relocation", () => {
	it("barrel enumerates every built-in source exactly once", () => {
		const keys = CAPABILITY_SOURCE_MAGNETS.map((m) => `${m.kind}:${m.source}`);
		expect(new Set(keys).size).toBe(keys.length);
		expect([...keys].sort()).toEqual(
			[
				"compaction:pi",
				"context:magenta",
				"hook:magenta",
				"memory:magenta",
				"policy:magenta",
				"prompt-template:pi",
				"runtime:magenta",
				"sandbox:magenta",
				"system-prompt:pi",
			].sort(),
		);
	});

	it("every barrel magnet declares a default and a build function", () => {
		for (const magnet of CAPABILITY_SOURCE_MAGNETS) {
			expect(magnet.isDefault, `${magnet.kind}:${magnet.source} isDefault`).toBe(true);
			expect(typeof magnet.build, `${magnet.kind}:${magnet.source} build`).toBe("function");
		}
	});

	it("derived defaults cover exactly the expected slots (incl. the runtime family's two slots)", async () => {
		const context = { repoRoot: process.cwd(), packagesRoot: process.cwd() };
		const { hcp, diagnostics } = await buildDefaultCapabilityHcp(context);
		expect(diagnostics).toEqual([]);

		// The runtime source serves two named slots via defaultSlotNames; both must resolve.
		const expectedSlots = [
			"compaction",
			"context",
			"hook",
			"memory",
			"policy",
			"prompt-template",
			"runtime:process",
			"runtime:script-runtimes",
			"sandbox",
			"system-prompt",
		];
		for (const slot of expectedSlots) {
			expect(hcp.resolveCapability(slot), `slot ${slot}`).toBeDefined();
		}
	});
});

/**
 * Locks in the spec §9 `hotSwappable` node attribute. It is a per-node boolean
 * that surfaces on the magnet's `describe()` metadata; it defaults to frozen
 * (`false`) so stateful capabilities are safe by omission, and it is distinct
 * from the `bundledWith`/`bundles` selection-graph edges (modeled elsewhere).
 */
describe("§9 hotSwappable node attribute", () => {
	const CONTEXT = { repoRoot: process.cwd(), packagesRoot: process.cwd() };

	it("every built-in capability source is frozen (stateful) by default", () => {
		for (const magnet of CAPABILITY_SOURCE_MAGNETS) {
			expect(magnet.hotSwappable ?? false, `${magnet.kind}:${magnet.source} hotSwappable`).toBe(false);
		}
	});

	it("surfaces hotSwappable:false on a frozen capability's describe() metadata", async () => {
		const { magnet, diagnostics } = await createCapabilityMagnet({
			component: { kind: "memory", name: "memory", source: "magenta" },
			context: CONTEXT,
		});
		expect(diagnostics).toEqual([]);
		expect(magnet?.toHcpServer?.().describe().metadata).toMatchObject({ hotSwappable: false });
	});

	it("surfaces hotSwappable:true when a component opts in", async () => {
		const { magnet, diagnostics } = await createCapabilityMagnet({
			component: { kind: "fixture-hot", name: "fixture-hot", source: "x", hotSwappable: true },
			context: CONTEXT,
			builders: { "fixture-hot:x": () => ({}) },
		});
		expect(diagnostics).toEqual([]);
		expect(magnet?.toHcpServer?.().describe().metadata).toMatchObject({ hotSwappable: true });
	});

	it("defaults to frozen when hotSwappable is omitted on the component", async () => {
		const { magnet } = await createCapabilityMagnet({
			component: { kind: "fixture-cold", name: "fixture-cold", source: "x" },
			context: CONTEXT,
			builders: { "fixture-cold:x": () => ({}) },
		});
		expect(magnet?.toHcpServer?.().describe().metadata).toMatchObject({ hotSwappable: false });
	});
});
