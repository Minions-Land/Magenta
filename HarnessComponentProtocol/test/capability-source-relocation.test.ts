import { describe, expect, it } from "vitest";
import { HcpClientassemble, HcpClientbuildsession, type HcpClientcomponent } from "../.HCP/assembly/session-hcp.ts";
import { HCP_MAGNETS } from "../.HCP/assembly/sources.generated.ts";
import type { HcpMagnetBuildContext } from "../.HCP/HcpMagnetTypes.ts";
import { HcpClient } from "../HcpClient.ts";

const CAPABILITY_COMPONENTS = HCP_MAGNETS.filter((entry) => entry.product === "capability");

describe("generated capability Magnet rows", () => {
	it("contains each TOML component/source row without a derived capability table", () => {
		const keys = CAPABILITY_COMPONENTS.map((entry) => `${entry.module}:${entry.name}:${entry.source}`);
		expect(new Set(keys).size).toBe(keys.length);
		expect(keys.sort()).toEqual(
			[
				"compaction:compaction:pi",
				"context:workspace:magenta",
				"hooks:hooks:magenta",
				"memory:memory:magenta",
				"policy:policy:magenta",
				"prompt-templates:prompt-templates:pi",
				"runtime:process:magenta",
				"runtime:script-runtimes:magenta",
				"sandbox:sandbox:magenta",
				"system-prompt:system-prompt:pi",
			].sort(),
		);
	});

	it("keeps identity and construction on the generated row", () => {
		for (const entry of CAPABILITY_COMPONENTS) {
			expect(entry.selected, `${entry.module}:${entry.name}`).toBe(true);
			expect(entry.slot, `${entry.module}:${entry.name}`).toBeTruthy();
			expect(typeof entry.HcpMagnet.build, `${entry.module}:${entry.source}`).toBe("function");
			expect(entry.HcpMagnet.module).toBe(entry.module);
			expect(entry.HcpMagnet.kind).toBe(entry.kind);
			expect(entry.HcpMagnet.source).toBe(entry.source);
		}
	});

	it("assembles all selected slots through their real module Servers", async () => {
		const result = await HcpClientbuildsession({
			repoRoot: process.cwd(),
			modules: CAPABILITY_COMPONENTS.map((entry) => entry.module),
		});
		const expectedSlots = CAPABILITY_COMPONENTS.map((entry) => entry.slot!);

		for (const slot of expectedSlots) {
			expect(result.hcp.resolveCapability(slot), `capability:${slot}`).toBeDefined();
		}
		expect(result.hcp.modules()).toEqual(
			expect.arrayContaining([
				"compaction",
				"context",
				"hooks",
				"memory",
				"policy",
				"prompt-templates",
				"runtime",
				"sandbox",
				"system-prompt",
			]),
		);
		expect(result.hcp.addresses().filter((address) => address.startsWith("capability:"))).toHaveLength(
			expectedSlots.length,
		);
		expect(result.hcp.resolveCapability("multiagent")).toBeUndefined();
	});
});

describe("hot-swappable node metadata", () => {
	class HcpMagnet {
		static readonly module = "compaction";
		static readonly kind = "fixture";
		static readonly source = "fixture";
		static build(context: HcpMagnetBuildContext) {
			return new HcpMagnet(context);
		}

		readonly kind = "capability:fixture";
		readonly source = "fixture";
		readonly hotSwappable: boolean;

		constructor(context: HcpMagnetBuildContext) {
			this.hotSwappable = context.hotSwappable ?? false;
		}

		toCapability() {
			return { kind: "fixture", name: "fixture", source: this.source, instance: this };
		}
	}

	function component(hotSwappable?: boolean): HcpClientcomponent {
		return {
			module: "compaction",
			kind: "fixture",
			name: "fixture",
			product: "capability",
			source: "fixture",
			selected: true,
			autoload: false,
			hotSwappable,
			descriptorPath: "compaction/compaction.toml",
			slot: "fixture",
			requires: [],
			HcpMagnet,
		};
	}

	it("defaults capabilities to frozen", async () => {
		const hcp = new HcpClient();
		await HcpClientassemble({
			hcp,
			repoRoot: process.cwd(),
			includeAutoload: false,
			components: [component()],
		});

		expect(hcp.describeAll()[0]?.metadata?.hotSwappable).toBe(false);
	});

	it("passes an explicit opt-in to the Magnet and Server description", async () => {
		const hcp = new HcpClient();
		await HcpClientassemble({
			hcp,
			repoRoot: process.cwd(),
			includeAutoload: false,
			components: [component(true)],
		});

		expect((hcp.resolveCapability("fixture") as HcpMagnet).hotSwappable).toBe(true);
		expect(hcp.describeAll()[0]?.metadata?.hotSwappable).toBe(true);
	});
});
