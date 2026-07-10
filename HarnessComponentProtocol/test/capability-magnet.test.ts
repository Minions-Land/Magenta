import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HcpClientassemble, type HcpClientcomponent } from "../.HCP/assembly/session-hcp.ts";
import type { HcpMagnetBuildContext } from "../.HCP/HcpMagnetTypes.ts";
import { HcpClient } from "../HcpClient.ts";
import { loadSandboxProviderFromPackSync } from "../sandbox/magenta/sandbox.ts";

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

	it("adds selected generated providers required by an explicitly selected product", async () => {
		const hcp = new HcpClient();
		const result = await HcpClientassemble({
			hcp,
			repoRoot: process.cwd(),
			includeAutoload: false,
			includeSelectedProducts: ["tool"],
			settings: {
				"tools/read": {},
				"tools/bash": {},
			},
		});

		expect(result.diagnostics).toEqual([]);
		expect(hcp.resolveCapability("runtime:process")).toBeDefined();
		expect(hcp.resolveCapability("sandbox")).toBeDefined();
		expect(hcp.resolveCapability("compaction")).toBeUndefined();
		expect(hcp.resolveCapability("hook")).toBeUndefined();
		expect(hcp.resolveInstance("tool:lsp")).toBeDefined();
	});

	it("uses an existing Client capability instead of rebuilding its selected default Source", async () => {
		const hcp = new HcpClient();
		const packageSandbox = loadSandboxProviderFromPackSync(
			fileURLToPath(new URL("../sandbox/sandbox.toml", import.meta.url)),
		);
		hcp.registerModule(
			{ moduleName: "sandbox" },
			new Map([
				[
					"sandbox",
					{
						kind: "capability:sandbox",
						source: "package",
						toCapability: () => ({
							kind: "sandbox",
							name: "sandbox",
							source: "package",
							instance: packageSandbox,
						}),
					},
				],
			]),
		);

		const result = await HcpClientassemble({
			hcp,
			repoRoot: process.cwd(),
			includeAutoload: false,
			modules: ["tools/lsp"],
		});

		expect(result.diagnostics).toEqual([]);
		expect(hcp.resolveCapability("sandbox")).toBe(packageSandbox);
	});

	it("does not pull a generated dependency from a disabled Module", async () => {
		const hcp = new HcpClient();
		const result = await HcpClientassemble({
			hcp,
			repoRoot: process.cwd(),
			includeAutoload: false,
			modules: ["tools/lsp"],
			disabledModules: ["runtime"],
		});

		expect(result.diagnostics).toEqual([
			expect.objectContaining({
				code: "component_dependency_missing",
				name: "lsp",
				message: expect.stringContaining("runtime:process"),
			}),
		]);
		expect(hcp.resolveCapability("runtime:process")).toBeUndefined();
		expect(hcp.resolveInstance("tool:lsp")).toBeUndefined();
	});

	it("prefers a provider from the current assembly pass over an older Client value", async () => {
		const hcp = new HcpClient();
		await HcpClientassemble({
			hcp,
			repoRoot: process.cwd(),
			includeAutoload: false,
			components: [component({ name: "base", slot: "fixture:base", source: "old" })],
		});
		const observedSources: string[] = [];
		class ObservingHcpMagnet extends FixtureHcpMagnet {
			static build(context: HcpMagnetBuildContext) {
				observedSources.push(context.resolveCapability?.<{ source: string }>("fixture:base")?.source ?? "missing");
				return new ObservingHcpMagnet(context);
			}
		}

		const result = await HcpClientassemble({
			hcp,
			repoRoot: process.cwd(),
			includeAutoload: false,
			components: [
				component({
					name: "dependent",
					slot: "fixture:dependent",
					requires: ["fixture:base"],
					HcpMagnet: ObservingHcpMagnet,
				}),
				component({ name: "base", slot: "fixture:base", source: "new" }),
			],
		});

		expect(result.diagnostics).toEqual([]);
		expect(observedSources).toEqual(["new"]);
	});

	it("does not fall back to an older provider when the current provider fails", async () => {
		const hcp = new HcpClient();
		await HcpClientassemble({
			hcp,
			repoRoot: process.cwd(),
			includeAutoload: false,
			components: [component({ name: "base", slot: "fixture:base", source: "old" })],
		});
		let dependentBuilt = false;
		class ThrowingHcpMagnet extends FixtureHcpMagnet {
			static build(): FixtureHcpMagnet {
				throw new Error("new provider failed");
			}
		}
		class DependentHcpMagnet extends FixtureHcpMagnet {
			static build(context: HcpMagnetBuildContext) {
				dependentBuilt = true;
				return new DependentHcpMagnet(context);
			}
		}

		const result = await HcpClientassemble({
			hcp,
			repoRoot: process.cwd(),
			includeAutoload: false,
			components: [
				component({
					name: "dependent",
					slot: "fixture:dependent",
					requires: ["fixture:base"],
					HcpMagnet: DependentHcpMagnet,
				}),
				component({ name: "base", slot: "fixture:base", source: "new", HcpMagnet: ThrowingHcpMagnet }),
			],
		});

		expect(dependentBuilt).toBe(false);
		expect(result.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "component_build_failed", name: "base" }),
				expect.objectContaining({
					code: "component_dependency_missing",
					name: "dependent",
					message: expect.stringContaining("fixture:base"),
				}),
			]),
		);
		expect(hcp.resolveCapability<{ source: string }>("fixture:base")?.source).toBe("old");
	});

	it("keeps dependency assembly deterministic across a diamond", async () => {
		const order: string[] = [];
		class OrderedHcpMagnet extends FixtureHcpMagnet {
			static build(context: HcpMagnetBuildContext) {
				order.push(context.name);
				return new OrderedHcpMagnet(context);
			}
		}
		const result = await HcpClientassemble({
			hcp: new HcpClient(),
			repoRoot: process.cwd(),
			includeAutoload: false,
			components: [
				component({
					name: "leaf",
					slot: "fixture:leaf",
					requires: ["fixture:right", "fixture:left"],
					HcpMagnet: OrderedHcpMagnet,
				}),
				component({
					name: "right",
					slot: "fixture:right",
					requires: ["fixture:root"],
					HcpMagnet: OrderedHcpMagnet,
				}),
				component({ name: "independent", slot: "fixture:independent", HcpMagnet: OrderedHcpMagnet }),
				component({
					name: "left",
					slot: "fixture:left",
					requires: ["fixture:root"],
					HcpMagnet: OrderedHcpMagnet,
				}),
				component({ name: "root", slot: "fixture:root", HcpMagnet: OrderedHcpMagnet }),
			],
		});

		expect(result.diagnostics).toEqual([]);
		expect(order).toEqual(["independent", "root", "right", "left", "leaf"]);
	});

	it("assembles a reverse-ordered dependency chain", async () => {
		const length = 128;
		const order: string[] = [];
		class OrderedHcpMagnet extends FixtureHcpMagnet {
			static build(context: HcpMagnetBuildContext) {
				order.push(context.name);
				return new OrderedHcpMagnet(context);
			}
		}
		const components = Array.from({ length }, (_, index) => {
			const position = length - index - 1;
			return component({
				name: `chain-${position}`,
				slot: `fixture:chain-${position}`,
				requires: position === 0 ? [] : [`fixture:chain-${position - 1}`],
				HcpMagnet: OrderedHcpMagnet,
			});
		});
		const hcp = new HcpClient();
		const result = await HcpClientassemble({
			hcp,
			repoRoot: process.cwd(),
			includeAutoload: false,
			components,
		});

		expect(result.diagnostics).toEqual([]);
		expect(order).toEqual(Array.from({ length }, (_, index) => `chain-${index}`));
		expect(hcp.resolveCapability(`fixture:chain-${length - 1}`)).toBeDefined();
	});

	it("reports dependency cycles separately from absent dependencies", async () => {
		const result = await HcpClientassemble({
			hcp: new HcpClient(),
			repoRoot: process.cwd(),
			includeAutoload: false,
			components: [
				component({ name: "cycle-a", slot: "fixture:cycle-a", requires: ["fixture:cycle-b"] }),
				component({ name: "cycle-b", slot: "fixture:cycle-b", requires: ["fixture:cycle-a"] }),
				component({ name: "self-cycle", slot: "fixture:self-cycle", requires: ["fixture:self-cycle"] }),
				component({ name: "missing", slot: "fixture:missing", requires: ["fixture:absent"] }),
			],
		});

		expect(result.diagnostics.filter(({ code }) => code === "component_dependency_cycle")).toHaveLength(3);
		expect(result.diagnostics.filter(({ code }) => code === "component_dependency_missing")).toEqual([
			expect.objectContaining({ name: "missing", message: expect.stringContaining("fixture:absent") }),
		]);
	});

	it("indexes many same-module components without revisiting older Magnet products", async () => {
		const length = 512;
		let productCalls = 0;
		class CountedHcpMagnet extends FixtureHcpMagnet {
			static build(context: HcpMagnetBuildContext) {
				return new CountedHcpMagnet(context);
			}

			toCapability() {
				productCalls += 1;
				return super.toCapability();
			}
		}
		const hcp = new HcpClient();
		const result = await HcpClientassemble({
			hcp,
			repoRoot: process.cwd(),
			includeAutoload: false,
			components: Array.from({ length }, (_, index) =>
				component({
					name: `wide-${index}`,
					slot: `fixture:wide-${index}`,
					HcpMagnet: CountedHcpMagnet,
				}),
			),
		});

		expect(result.diagnostics).toEqual([]);
		expect(result.addresses).toHaveLength(length);
		expect(productCalls).toBe(length);
		expect(hcp.addresses()).toHaveLength(length);
	});

	it("rejects colliding addresses without partially routing the second component", async () => {
		const disposed: string[] = [];
		// biome-ignore lint/complexity/noStaticOnlyClass: test fixture models the static HcpMagnet build role.
		class DuplicateToolHcpMagnet {
			static readonly module = "tools/read";
			static readonly kind = "tool";
			static readonly source = "fixture";
			static build(context: HcpMagnetBuildContext) {
				return {
					kind: "fixture",
					source: "fixture",
					dispose: () => disposed.push(context.name),
					toTool: () => ({
						name: "duplicate",
						description: "duplicate",
						parameters: {},
						execute: async () => ({}),
					}),
				};
			}
		}
		const toolComponent = (module: string, name: string): HcpClientcomponent => ({
			module,
			kind: "tool",
			name,
			product: "tool",
			source: "fixture",
			selected: true,
			autoload: false,
			descriptorPath: `${module}/${name}.toml`,
			requires: [],
			HcpMagnet: DuplicateToolHcpMagnet,
		});
		const hcp = new HcpClient();
		const result = await HcpClientassemble({
			hcp,
			repoRoot: process.cwd(),
			includeAutoload: false,
			components: [toolComponent("tools/read", "first"), toolComponent("tools/write", "second")],
		});

		expect(result.diagnostics).toEqual([
			expect.objectContaining({ code: "component_address_collision", name: "second" }),
		]);
		expect(disposed).toEqual(["second"]);
		expect(hcp.resolve("tool:duplicate")?.moduleName).toBe("tools/read");
		expect(hcp.resolveModule("tools/write")).toBeUndefined();
		await hcp.dispose();
		expect(disposed).toEqual(["second", "first"]);
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

	it("rejects a product that exposes more than its declared product method", async () => {
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

	it("turns selector failures into diagnostics and disposes the product", async () => {
		let disposed = false;
		// biome-ignore lint/complexity/noStaticOnlyClass: test fixture models the static HcpMagnet build role.
		class ThrowingToolHcpMagnet {
			static readonly module = "tools";
			static readonly kind = "tool";
			static readonly source = "fixture";
			static build() {
				return {
					kind: "fixture",
					source: "fixture",
					toTool: () => {
						throw new Error("tool projection failed");
					},
					dispose: () => {
						disposed = true;
					},
				};
			}
		}
		const result = await HcpClientassemble({
			hcp: new HcpClient(),
			repoRoot: process.cwd(),
			includeAutoload: false,
			components: [
				component({
					module: "tools",
					kind: "tool",
					name: "throwing-tool",
					product: "tool",
					slot: undefined,
					HcpMagnet: ThrowingToolHcpMagnet,
				}),
			],
		});

		expect(result.diagnostics).toEqual([
			expect.objectContaining({
				code: "component_routing_failed",
				message: expect.stringContaining("tool projection failed"),
			}),
		]);
		expect(disposed).toBe(true);
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
