import { describe, expect, it } from "vitest";
import { HcpClient } from "../harness-component-protocol/HcpClient.ts";
import type { HcpServerRequest } from "../harness-component-protocol/HcpServerTypes.ts";

/** Minimal fake magnet for testing module server routing. */
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
		const hcp = new HcpClient();
		hcp.registerModule("compaction", new Map([["compaction", compactionMagnet]]));

		const module = hcp.resolveModule("compaction")!;
		expect(module).toBeDefined();
		expect(module.describe().metadata?.moduleName).toBe("compaction");

		// Single-slot ergonomic rule: no selector needed.
		expect(module.instance()).toEqual({ compact: true });
		expect(module.instance("compaction")).toEqual({ compact: true });
	});

	it("multi-slot module: instance(selector) routes to the right magnet", () => {
		const readMagnet = createFakeMagnet("tool:read", "tool", { name: "read", execute: "read-fn" });
		const bashMagnet = createFakeMagnet("tool:bash", "tool", { name: "bash", execute: "bash-fn" });
		const hcp = new HcpClient();
		hcp.registerModule(
			"tools",
			new Map([
				["read", readMagnet],
				["bash", bashMagnet],
			]),
		);

		const module = hcp.resolveModule("tools")!;
		expect(module).toBeDefined();
		expect(module.describe().metadata?.moduleName).toBe("tools");

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
		const hcp = new HcpClient();
		hcp.registerModule(
			"tools",
			new Map([
				["read", readMagnet],
				["bash", bashMagnet],
			]),
		);

		const module = hcp.resolveModule("tools")!;

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
		const hcp = new HcpClient();
		hcp.registerModule("compaction", new Map([["compaction", compactionMagnet]]));

		const module = hcp.resolveModule("compaction")!;
		const echoed = await module.call({ target: "capability:compaction", op: "call", input: { y: 2 } });
		expect(echoed).toEqual({ echo: { y: 2 }, from: "capability:compaction" });
	});

	it("describe() returns synthetic module-level summary", () => {
		const processMagnet = createFakeMagnet("capability:runtime:process", "capability", {});
		const scriptsMagnet = createFakeMagnet("capability:runtime:script-runtimes", "capability", {});
		const hcp = new HcpClient();
		hcp.registerModule(
			"runtime",
			new Map([
				["runtime:process", processMagnet],
				["runtime:script-runtimes", scriptsMagnet],
			]),
		);

		const module = hcp.resolveModule("runtime")!;
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
		const hcp = new HcpClient();
		hcp.registerModule(
			"tools",
			new Map([
				["read", readMagnet],
				["bash", bashMagnet],
			]),
		);

		const module = hcp.resolveModule("tools")!;
		const slots = module.describeSlots();
		expect(slots.map((s) => s.target)).toEqual(["tool:read", "tool:bash"]);
		expect(slots.every((s) => s.kind === "tool")).toBe(true);
	});
});
