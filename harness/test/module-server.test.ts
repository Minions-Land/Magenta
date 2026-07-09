import { describe, expect, it } from "vitest";
import type { HcpMagnet } from "../hcp-client/HcpMagnetTypes.ts";
import type { HcpServer, HcpServerRequest } from "../hcp-client/HcpServerTypes.ts";
import { ModuleHcpServer } from "../hcp-client/server/module-server.ts";

/** Minimal fake magnet for testing ModuleHcpServer routing. */
function createFakeMagnet(target: string, kind: string, product: unknown): HcpMagnet {
	return {
		kind: "native",
		toHcpServer: (): HcpServer => ({
			describe: () => ({ target, kind, ops: ["call"], description: `Fake ${target}` }),
			call: async (req: HcpServerRequest) => {
				if (req.op === "call") return { echo: req.input, from: target };
				if (req.op === "describe") return { target, kind, ops: ["call"] };
				throw new Error(`Unsupported op: ${req.op}`);
			},
			instance: <T>(): T | undefined => product as T,
		}),
	};
}

describe("ModuleHcpServer (strict Model B — module IS the HcpServer)", () => {
	it("single-slot module: instance() with no selector uses the sole slot", () => {
		const compactionMagnet = createFakeMagnet("capability:compaction", "capability", { compact: true });
		const module = new ModuleHcpServer("compaction", new Map([["compaction", compactionMagnet]]));

		expect(module.moduleName).toBe("compaction");
		expect(module.selectors()).toEqual(["compaction"]);
		expect(module.slotAddresses()).toEqual([{ address: "capability:compaction", selector: "compaction" }]);

		// Single-slot ergonomic rule: no selector needed.
		expect(module.instance()).toEqual({ compact: true });
		expect(module.instance("compaction")).toEqual({ compact: true });
	});

	it("multi-slot module: instance(selector) routes to the right magnet", () => {
		const readMagnet = createFakeMagnet("tool:read", "tool", { name: "read", execute: "read-fn" });
		const bashMagnet = createFakeMagnet("tool:bash", "tool", { name: "bash", execute: "bash-fn" });
		const module = new ModuleHcpServer(
			"tools",
			new Map([
				["read", readMagnet],
				["bash", bashMagnet],
			]),
		);

		expect(module.moduleName).toBe("tools");
		expect(module.selectors()).toEqual(["read", "bash"]);
		expect(module.slotAddresses()).toEqual([
			{ address: "tool:read", selector: "read" },
			{ address: "tool:bash", selector: "bash" },
		]);

		expect(module.instance("read")).toEqual({ name: "read", execute: "read-fn" });
		expect(module.instance("bash")).toEqual({ name: "bash", execute: "bash-fn" });
		// Multi-slot with no selector → undefined (caller must disambiguate).
		expect(module.instance()).toBeUndefined();
		// Unknown selector → undefined.
		expect(module.instance("nonexistent")).toBeUndefined();
	});

	it("call() routes ops to the selected slot's magnet server", async () => {
		const readMagnet = createFakeMagnet("tool:read", "tool", { name: "read" });
		const bashMagnet = createFakeMagnet("tool:bash", "tool", { name: "bash" });
		const module = new ModuleHcpServer(
			"tools",
			new Map([
				["read", readMagnet],
				["bash", bashMagnet],
			]),
		);

		// Module-level describe (no selector) returns the aggregate.
		const agg = module.call({ target: "module:tools", op: "describe" }) as { kind: string };
		expect(agg.kind).toBe("module");

		// A slot op requires input.selector on a multi-slot module, and routes to
		// the CORRECT slot (from:target proves no mis-routing between read/bash).
		const readEcho = (await module.call({
			target: "tool:read",
			op: "call",
			input: { selector: "read", x: 1 },
		})) as { echo: unknown; from: string };
		expect(readEcho).toEqual({ echo: { selector: "read", x: 1 }, from: "tool:read" });
		const bashEcho = (await module.call({
			target: "tool:bash",
			op: "call",
			input: { selector: "bash", y: 2 },
		})) as { from: string };
		expect(bashEcho.from).toBe("tool:bash");

		// Missing selector on a multi-slot op throws (no silent default).
		expect(() => module.call({ target: "tool:x", op: "call", input: { x: 1 } })).toThrow(/needs a selector/);
	});

	it("single-slot call() defaults to the sole slot", async () => {
		const compactionMagnet = createFakeMagnet("capability:compaction", "capability", { compact: true });
		const module = new ModuleHcpServer("compaction", new Map([["compaction", compactionMagnet]]));
		const echoed = await module.call({ target: "capability:compaction", op: "call", input: { y: 2 } });
		expect(echoed).toEqual({ echo: { y: 2 }, from: "capability:compaction" });
	});

	it("describe() returns synthetic module-level summary", () => {
		const processMagnet = createFakeMagnet("capability:runtime:process", "capability", {});
		const scriptsMagnet = createFakeMagnet("capability:runtime:script-runtimes", "capability", {});
		const module = new ModuleHcpServer(
			"runtime",
			new Map([
				["runtime:process", processMagnet],
				["runtime:script-runtimes", scriptsMagnet],
			]),
		);

		const desc = module.describe();
		expect(desc.target).toBe("module:runtime");
		expect(desc.kind).toBe("module");
		expect(desc.metadata?.moduleName).toBe("runtime");
		expect(desc.metadata?.slotCount).toBe(2);
		expect(desc.metadata?.slots).toEqual(["runtime:process", "runtime:script-runtimes"]);
		expect(desc.metadata?.componentKind).toBe("capability");
	});

	it("describeSlots() returns each magnet's own per-slot description", () => {
		const readMagnet = createFakeMagnet("tool:read", "tool", { name: "read" });
		const bashMagnet = createFakeMagnet("tool:bash", "tool", { name: "bash" });
		const module = new ModuleHcpServer(
			"tools",
			new Map([
				["read", readMagnet],
				["bash", bashMagnet],
			]),
		);

		const slots = module.describeSlots();
		expect(slots.map((s) => s.target)).toEqual(["tool:read", "tool:bash"]);
		expect(slots.every((s) => s.kind === "tool")).toBe(true);
	});
});
