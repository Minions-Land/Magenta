import { describe, expect, it } from "vitest";
import type { HcpServerRequest } from "../.HCP/HcpServerTypes.ts";
import { HcpClient } from "../HcpClient.ts";

type HcpMagnet = {
	readonly kind: string;
	readonly target: string;
	readonly product: unknown;
	toTool?(): unknown;
	toCapability?(): unknown;
};

class HcpServer {
	readonly moduleName: string;
	readonly description?: string;

	constructor(moduleName: string, description?: string) {
		this.moduleName = moduleName;
		this.description = description;
	}

	describeSource(_selector: string, magnet: HcpMagnet) {
		return { target: magnet.target, kind: magnet.target.startsWith("tool:") ? "tool" : "capability", ops: ["call"] };
	}

	sourceAddresses(_selector: string, magnet: HcpMagnet) {
		return [magnet.target];
	}

	callSource(_selector: string, magnet: HcpMagnet, request: HcpServerRequest) {
		if (request.op === "call") return { echo: request.input, from: magnet.target };
		if (request.op === "describe") return this.describeSource(_selector, magnet);
		throw new Error(`Unsupported op: ${request.op}`);
	}
}

/** Minimal fake magnet for testing module server routing. */
function createFakeMagnet(target: string, kind: string, product: unknown): HcpMagnet {
	const toolProduct =
		kind === "tool" && product && typeof product === "object" && "name" in product
			? product
			: kind === "tool"
				? { ...(product as Record<string, unknown>), name: target.slice("tool:".length) }
				: product;
	return {
		kind: "native",
		target,
		product,
		...(kind === "tool"
			? { toTool: () => toolProduct }
			: {
					toCapability: () => ({
						kind,
						name: target.split(":").at(-1) ?? kind,
						source: "fixture",
						instance: product,
					}),
				}),
	};
}

describe("HcpServer module routing", () => {
	it("single-slot module: instance() with no selector uses the sole slot", () => {
		const compactionMagnet = createFakeMagnet("capability:compaction", "capability", { compact: true });
		const hcp = new HcpClient();
		const server = new HcpServer("compaction");
		hcp.registerModule(server, new Map([["compaction", compactionMagnet]]));

		const module = hcp.resolveModule("compaction")!;
		expect(module).toBeDefined();
		expect(module).toBe(server);
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
			new HcpServer("tools"),
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
			new HcpServer("tools"),
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
		hcp.registerModule(new HcpServer("compaction"), new Map([["compaction", compactionMagnet]]));

		const module = hcp.resolveModule("compaction")!;
		const echoed = await module.call({ target: "capability:compaction", op: "call", input: { y: 2 } });
		expect(echoed).toEqual({ echo: { y: 2 }, from: "capability:compaction" });
	});

	it("dispatch routes a multi-slot target without input.selector", async () => {
		const hcp = new HcpClient();
		hcp.registerModule(
			new HcpServer("tools"),
			new Map([
				["read", createFakeMagnet("tool:read", "tool", { name: "read" })],
				["bash", createFakeMagnet("tool:bash", "tool", { name: "bash" })],
			]),
		);

		await expect(hcp.dispatch({ target: "tool:bash", op: "call", input: { command: "pwd" } })).resolves.toEqual({
			echo: { selector: "bash", command: "pwd" },
			from: "tool:bash",
		});
	});

	it("replacing a module removes its retired addresses", () => {
		const hcp = new HcpClient();
		hcp.registerModule(
			new HcpServer("tools"),
			new Map([
				["read", createFakeMagnet("tool:read", "tool", {})],
				["bash", createFakeMagnet("tool:bash", "tool", {})],
			]),
		);
		hcp.registerModule(new HcpServer("tools"), new Map([["read", createFakeMagnet("tool:read", "tool", {})]]));

		expect(hcp.resolve("tool:read")).toBeDefined();
		expect(hcp.resolve("tool:bash")).toBeUndefined();
		expect(hcp.addresses()).toEqual(["tool:read"]);
	});

	it("registering a parent replaces its child-module subtree", () => {
		const hcp = new HcpClient();
		hcp.registerModule(new HcpServer("tools"), new Map());
		hcp.registerModule(
			new HcpServer("tools/read"),
			new Map([["pi", createFakeMagnet("tool:read", "tool", { name: "read" })]]),
		);
		hcp.registerModule(
			new HcpServer("tools/bash"),
			new Map([["pi", createFakeMagnet("tool:bash", "tool", { name: "bash" })]]),
		);

		hcp.registerModule(new HcpServer("tools"), new Map());

		expect(hcp.modules()).toEqual(["tools"]);
		expect(hcp.resolveModule("tools/read")).toBeUndefined();
		expect(hcp.resolveModule("tools/bash")).toBeUndefined();
		expect(hcp.resolve("tool:read")).toBeUndefined();
		expect(hcp.resolve("tool:bash")).toBeUndefined();
		expect(hcp.addresses()).toEqual([]);
	});

	it("merging a parent preserves its child-module subtree", () => {
		const hcp = new HcpClient();
		const tools = new HcpServer("tools");
		hcp.registerModule(tools, new Map());
		hcp.registerModule(
			new HcpServer("tools/read"),
			new Map([["pi", createFakeMagnet("tool:read", "tool", { name: "read" })]]),
		);

		hcp.registerModule(tools, new Map([["package", createFakeMagnet("tool:package", "tool", { name: "package" })]]), {
			merge: true,
		});

		expect(hcp.modules()).toEqual(["tools", "tools/read"]);
		expect(hcp.resolve("tool:read")).toBe(hcp.resolveModule("tools/read"));
		expect(hcp.resolve("tool:package")).toBe(hcp.resolveModule("tools"));
		expect(hcp.resolveModule("tools")?.describe().metadata?.children).toEqual(["tools/read"]);
	});

	it("atomically swaps addresses between slots updated in one merge", () => {
		const hcp = new HcpClient();
		const tools = new HcpServer("tools");
		hcp.registerModule(
			tools,
			new Map([
				["left", createFakeMagnet("tool:left", "tool", { name: "left-v1" })],
				["right", createFakeMagnet("tool:right", "tool", { name: "right-v1" })],
			]),
		);

		hcp.registerModule(
			tools,
			new Map([
				["left", createFakeMagnet("tool:right", "tool", { name: "left-v2" })],
				["right", createFakeMagnet("tool:left", "tool", { name: "right-v2" })],
			]),
			{ merge: true },
		);

		expect(hcp.resolveInstance<{ name: string }>("tool:right")?.name).toBe("left-v2");
		expect(hcp.resolveInstance<{ name: string }>("tool:left")?.name).toBe("right-v2");
	});

	it("keeps existing routes intact when a replacement Server cannot be attached", () => {
		const hcp = new HcpClient();
		const original = createFakeMagnet("tool:read", "tool", { name: "original" });
		hcp.registerModule(new HcpServer("tools"), new Map([["read", original]]));
		const lockedServer = Object.freeze({ moduleName: "tools", description: "locked" });

		expect(() =>
			hcp.registerModule(lockedServer, new Map([["read", createFakeMagnet("tool:read", "tool", { name: "new" })]])),
		).toThrow();

		expect(hcp.resolveInstance("tool:read")).toEqual({ name: "original" });
		expect(hcp.modules()).toEqual(["tools"]);
		expect(hcp.addresses()).toEqual(["tool:read"]);
	});

	it("keeps one HcpServer entity for every merged Module", () => {
		const hcp = new HcpClient();
		const server = new HcpServer("runtime");
		hcp.registerModule(
			server,
			new Map([["runtime:process", createFakeMagnet("capability:runtime:process", "capability", {})]]),
		);
		hcp.registerModule(
			server,
			new Map([
				["runtime:script-runtimes", createFakeMagnet("capability:runtime:script-runtimes", "capability", {})],
			]),
			{ merge: true },
		);

		expect(hcp.resolveModule("runtime")).toBe(server);
		expect(() => hcp.registerModule(new HcpServer("runtime"), new Map(), { merge: true })).toThrow(
			/reuse the existing HcpServer instance/,
		);
	});

	it("disposes each routed Magnet once and clears the Client", async () => {
		const hcp = new HcpClient();
		let disposeCalls = 0;
		class SelectorHcpServer extends HcpServer {
			describeSource(selector: string, _magnet: HcpMagnet) {
				return { target: `tool:${selector}`, kind: "tool", ops: ["call"] };
			}

			sourceAddresses(selector: string) {
				return [`tool:${selector}`];
			}
		}
		const shared = {
			...createFakeMagnet("tool:shared", "tool", { name: "shared" }),
			dispose: () => {
				disposeCalls += 1;
			},
		};
		hcp.registerModule(
			new SelectorHcpServer("tools"),
			new Map([
				["first", shared],
				["second", shared],
			]),
		);

		await hcp.dispose();

		expect(disposeCalls).toBe(1);
		expect(hcp.modules()).toEqual([]);
		expect(hcp.addresses()).toEqual([]);
	});

	it("disposes a Magnet retired by a slot replacement", async () => {
		const disposed: string[] = [];
		const hcp = new HcpClient();
		const server = new HcpServer("tools");
		const first = {
			...createFakeMagnet("tool:shared", "tool", { name: "shared" }),
			dispose: () => {
				disposed.push("first");
			},
		};
		const second = {
			...createFakeMagnet("tool:shared", "tool", { name: "shared" }),
			dispose: () => {
				disposed.push("second");
			},
		};
		hcp.registerModule(server, new Map([["shared", first]]));
		hcp.registerModule(server, new Map([["shared", second]]), { merge: true });
		await Promise.resolve();

		expect(disposed).toEqual(["first"]);
		await hcp.dispose();
		expect(disposed).toEqual(["first", "second"]);
	});

	it("does not dispose a retired Magnet that is synchronously reattached", async () => {
		const disposed: string[] = [];
		const hcp = new HcpClient();
		const server = new HcpServer("tools");
		const first = {
			...createFakeMagnet("tool:shared", "tool", { name: "first" }),
			dispose: () => {
				disposed.push("first");
			},
		};
		const second = {
			...createFakeMagnet("tool:shared", "tool", { name: "second" }),
			dispose: () => {
				disposed.push("second");
			},
		};
		const third = createFakeMagnet("tool:shared", "tool", { name: "third" });

		hcp.registerModule(server, new Map([["shared", first]]));
		hcp.registerModule(server, new Map([["shared", second]]), { merge: true });
		hcp.registerModule(server, new Map([["shared", first]]), { merge: true });
		await Promise.resolve();
		await Promise.resolve();

		expect(disposed).toEqual(["second"]);
		expect(hcp.resolveInstance("tool:shared")).toEqual({ name: "first" });

		hcp.registerModule(server, new Map([["shared", third]]), { merge: true });
		await Promise.resolve();
		await Promise.resolve();
		expect(disposed).toEqual(["second", "first"]);
		await hcp.dispose();
	});

	it("waits for async retirement after preserving a synchronously reattached Magnet", async () => {
		const hcp = new HcpClient();
		const server = new HcpServer("tools");
		let releaseDisposal!: () => void;
		const disposalGate = new Promise<void>((resolve) => {
			releaseDisposal = resolve;
		});
		let disposalStarted = 0;
		let disposalCompleted = 0;
		const first = {
			...createFakeMagnet("tool:shared", "tool", { name: "first" }),
			dispose: async () => {
				disposalStarted += 1;
				await disposalGate;
				disposalCompleted += 1;
			},
		};
		const second = createFakeMagnet("tool:shared", "tool", { name: "second" });
		const third = createFakeMagnet("tool:shared", "tool", { name: "third" });

		hcp.registerModule(server, new Map([["shared", first]]));
		hcp.registerModule(server, new Map([["shared", second]]), { merge: true });
		hcp.registerModule(server, new Map([["shared", first]]), { merge: true });
		await Promise.resolve();
		await Promise.resolve();

		expect(disposalStarted).toBe(0);
		expect(hcp.resolveInstance("tool:shared")).toEqual({ name: "first" });

		hcp.registerModule(server, new Map([["shared", third]]), { merge: true });
		await Promise.resolve();
		expect(disposalStarted).toBe(1);
		expect(disposalCompleted).toBe(0);

		let HcpClientdisposed = false;
		const disposing = hcp.dispose().then(() => {
			HcpClientdisposed = true;
		});
		await Promise.resolve();
		expect(HcpClientdisposed).toBe(false);

		releaseDisposal();
		await disposing;
		expect(disposalCompleted).toBe(1);
		expect(HcpClientdisposed).toBe(true);
	});

	it("keeps the tools root independent and lists its direct children", () => {
		const hcp = new HcpClient();
		const root = new HcpServer("tools");
		const read = new HcpServer("tools/read");
		const deep = new HcpServer("tools/read/internal");
		hcp.registerModule(root, new Map());
		hcp.registerModule(read, new Map([["pi", createFakeMagnet("tool:read", "tool", { name: "read" })]]));
		hcp.registerModule(new HcpServer("tools/bash"), new Map());
		hcp.registerModule(deep, new Map());

		expect(hcp.modules()).toEqual(["tools", "tools/bash", "tools/read", "tools/read/internal"]);
		expect(hcp.resolveModule("tools")).toBe(root);
		expect(hcp.resolve("tool:read")).toBe(read);
		expect(hcp.resolve("tool:read")).toBe(hcp.resolveModule("tools/read"));
		expect(hcp.resolve("tool:read")).not.toBe(root);
		expect(hcp.resolveModule("tools")?.describe().metadata?.children).toEqual(["tools/read", "tools/bash"]);
		expect(hcp.resolveModule("tools/read")?.describe().metadata?.children).toEqual(["tools/read/internal"]);
	});

	it("lets an explicit overlay replace a descendant address without leaving a stale Magnet", async () => {
		const disposed: string[] = [];
		const hcp = new HcpClient();
		const root = new HcpServer("tools");
		const original = {
			...createFakeMagnet("tool:read", "tool", { name: "read", source: "repository" }),
			dispose: () => {
				disposed.push("repository");
			},
		};
		const replacement = createFakeMagnet("tool:read", "tool", { name: "read", source: "package" });
		hcp.registerModule(root, new Map());
		hcp.registerModule(new HcpServer("tools/read"), new Map([["pi", original]]));

		hcp.registerModule(root, new Map([["tool:read", replacement]]), { merge: true, override: true });
		await Promise.resolve();

		expect(hcp.resolve("tool:read")).toBe(root);
		expect(hcp.resolveInstance("tool:read")).toEqual({ name: "read", source: "package" });
		expect(hcp.resolveModule("tools/read")).toBeUndefined();
		expect(disposed).toEqual(["repository"]);
		await hcp.dispose();
	});

	it("describe() returns synthetic module-level summary", () => {
		const processMagnet = createFakeMagnet("capability:runtime:process", "capability", {});
		const scriptsMagnet = createFakeMagnet("capability:runtime:script-runtimes", "capability", {});
		const hcp = new HcpClient();
		hcp.registerModule(
			new HcpServer("runtime"),
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

	it("describeAll() returns each magnet's own per-slot description", () => {
		const readMagnet = createFakeMagnet("tool:read", "tool", { name: "read" });
		const bashMagnet = createFakeMagnet("tool:bash", "tool", { name: "bash" });
		const hcp = new HcpClient();
		hcp.registerModule(
			new HcpServer("tools"),
			new Map([
				["read", readMagnet],
				["bash", bashMagnet],
			]),
		);

		const slots = hcp.describeAll();
		expect(slots.map((s) => s.target)).toEqual(["tool:read", "tool:bash"]);
		expect(slots.every((s) => s.kind === "tool")).toBe(true);
	});
});
