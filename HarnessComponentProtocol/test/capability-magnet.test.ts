import { describe, expect, it } from "vitest";
import { HcpClientassemble, type HcpClientcomponent } from "../.HCP/assembly/session-hcp.ts";
import type { HcpMagnetBuildContext } from "../.HCP/HcpMagnetTypes.ts";
import { HcpClient } from "../HcpClient.ts";

class FixtureHcpMagnet {
	static readonly module = "compaction";
	static readonly kind = "fixture";
	static readonly source = "fixture";

	static build(context: HcpMagnetBuildContext) {
		return new FixtureHcpMagnet(context);
	}

	readonly kind = "capability:fixture";
	readonly source: string;
	readonly hotSwappable: boolean;
	private readonly name: string;

	constructor(context: HcpMagnetBuildContext) {
		this.name = context.name;
		this.source = context.source;
		this.hotSwappable = context.hotSwappable ?? false;
	}

	toCapability() {
		return {
			kind: "fixture",
			name: this.name,
			source: this.source,
			instance: { source: this.source, hotSwappable: this.hotSwappable },
		};
	}
}

function component(overrides: Partial<HcpClientcomponent> = {}): HcpClientcomponent {
	return {
		module: "compaction",
		kind: "fixture",
		name: "fixture",
		product: "capability",
		source: "fixture",
		selected: true,
		autoload: false,
		descriptorPath: "compaction/compaction.toml",
		slot: "fixture",
		requires: [],
		HcpMagnet: FixtureHcpMagnet,
		...overrides,
	};
}

describe("capability products through HcpClient assembly", () => {
	it("builds the source declared by the component and resolves its instance", async () => {
		const hcp = new HcpClient();
		const result = await HcpClientassemble({
			hcp,
			repoRoot: process.cwd(),
			includeAutoload: false,
			components: [component({ source: "magenta" })],
		});

		expect(result.diagnostics).toEqual([]);
		expect(result.addresses).toEqual(["capability:fixture"]);
		expect(hcp.resolveCapability("fixture")).toEqual({
			source: "magenta",
			hotSwappable: false,
		});
		expect(hcp.resolveModule("compaction")?.moduleName).toBe("compaction");
	});

	it("waits for declared capability dependencies before building dependants", async () => {
		const order: string[] = [];
		class OrderedHcpMagnet extends FixtureHcpMagnet {
			static build(context: HcpMagnetBuildContext) {
				order.push(context.name);
				return new OrderedHcpMagnet(context);
			}
		}
		const hcp = new HcpClient();
		const result = await HcpClientassemble({
			hcp,
			repoRoot: process.cwd(),
			includeAutoload: false,
			components: [
				component({
					name: "dependent",
					slot: "fixture:dependent",
					requires: ["fixture:base"],
					HcpMagnet: OrderedHcpMagnet,
				}),
				component({
					name: "base",
					slot: "fixture:base",
					HcpMagnet: OrderedHcpMagnet,
				}),
			],
		});

		expect(result.diagnostics).toEqual([]);
		expect(order).toEqual(["base", "dependent"]);
		expect(hcp.resolveCapability("fixture:base")).toBeDefined();
		expect(hcp.resolveCapability("fixture:dependent")).toBeDefined();
	});

	it("reports unresolved dependencies without invoking the Magnet", async () => {
		let built = false;
		class NeverBuiltHcpMagnet extends FixtureHcpMagnet {
			static build(context: HcpMagnetBuildContext) {
				built = true;
				return new NeverBuiltHcpMagnet(context);
			}
		}
		const result = await HcpClientassemble({
			hcp: new HcpClient(),
			repoRoot: process.cwd(),
			includeAutoload: false,
			components: [component({ requires: ["missing"], HcpMagnet: NeverBuiltHcpMagnet })],
		});

		expect(built).toBe(false);
		expect(result.diagnostics).toEqual([expect.objectContaining({ code: "component_dependency_missing" })]);
	});

	it("turns build failures and unavailable sources into diagnostics", async () => {
		// biome-ignore lint/complexity/noStaticOnlyClass: test fixture must model the static HcpMagnet build role.
		class ThrowingHcpMagnet {
			static readonly module = "compaction";
			static readonly kind = "fixture";
			static readonly source = "broken";
			static build() {
				throw new Error("kaboom");
			}
		}
		// biome-ignore lint/complexity/noStaticOnlyClass: test fixture must model the static HcpMagnet build role.
		class UnavailableHcpMagnet {
			static readonly module = "compaction";
			static readonly kind = "fixture";
			static readonly source = "missing";
			static build() {
				return undefined;
			}
		}
		const result = await HcpClientassemble({
			hcp: new HcpClient(),
			repoRoot: process.cwd(),
			includeAutoload: false,
			components: [
				component({ name: "broken", slot: "fixture:broken", HcpMagnet: ThrowingHcpMagnet }),
				component({ name: "missing", slot: "fixture:missing", HcpMagnet: UnavailableHcpMagnet }),
			],
		});

		expect(result.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "component_build_failed", message: expect.stringContaining("kaboom") }),
				expect.objectContaining({ code: "component_source_unavailable" }),
			]),
		);
	});

	it("rejects a product that exposes more than its declared primitive", async () => {
		// biome-ignore lint/complexity/noStaticOnlyClass: test fixture must model the static HcpMagnet build role.
		class HybridHcpMagnet {
			static readonly module = "compaction";
			static readonly kind = "fixture";
			static readonly source = "hybrid";
			static build() {
				return {
					kind: "hybrid",
					source: "hybrid",
					toCapability: () => ({ kind: "fixture", name: "hybrid", source: "hybrid", instance: {} }),
					toTool: () => ({ name: "hybrid" }),
				};
			}
		}
		const result = await HcpClientassemble({
			hcp: new HcpClient(),
			repoRoot: process.cwd(),
			includeAutoload: false,
			components: [component({ HcpMagnet: HybridHcpMagnet })],
		});

		expect(result.diagnostics).toEqual([expect.objectContaining({ code: "component_product_invalid" })]);
	});
});

describe("HcpClient capability routing", () => {
	it("resolves single and named slots to their selected instances", () => {
		const hcp = new HcpClient();
		const server = { moduleName: "fixture", description: "fixture" };
		const single = new FixtureHcpMagnet({
			repoRoot: "/repo",
			packagesRoot: "/repo/packages",
			kind: "fixture",
			name: "fixture",
			source: "pi",
		});
		const named = new FixtureHcpMagnet({
			repoRoot: "/repo",
			packagesRoot: "/repo/packages",
			kind: "fixture",
			name: "process",
			source: "magenta",
		});
		hcp.registerModule(
			server,
			new Map([
				["fixture", single],
				["fixture:process", named],
			]),
		);

		expect(hcp.resolveCapability("fixture")).toEqual({ source: "pi", hotSwappable: false });
		expect(hcp.resolveCapability("fixture:process")).toEqual({ source: "magenta", hotSwappable: false });
		expect(hcp.resolveCapability("absent")).toBeUndefined();
	});

	it("never exposes a capability as an AgentTool", async () => {
		const hcp = new HcpClient();
		hcp.registerModule(
			{ moduleName: "fixture" },
			new Map([
				[
					"fixture",
					new FixtureHcpMagnet({
						repoRoot: "/repo",
						packagesRoot: "/repo/packages",
						kind: "fixture",
						name: "fixture",
						source: "pi",
					}),
				],
			]),
		);

		await expect(hcp.dispatch({ target: "capability:fixture", op: "toTool" })).rejects.toThrow(
			/does not produce an AgentTool/,
		);
	});
});
