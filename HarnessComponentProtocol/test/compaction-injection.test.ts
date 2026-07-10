import { describe, expect, it } from "vitest";
import { HcpClientassemble, type HcpClientcomponent } from "../.HCP/assembly/session-hcp.ts";
import type { HcpMagnetBuildContext } from "../.HCP/HcpMagnetTypes.ts";
import { piCompactionProvider } from "../compaction/pi/provider.ts";
import { HcpClient } from "../HcpClient.ts";

// biome-ignore lint/complexity/noStaticOnlyClass: test fixture must model the static HcpMagnet build role.
class HcpMagnet {
	static readonly module = "compaction";
	static readonly kind = "compaction";
	static readonly source = "fixture";
	static build(context: HcpMagnetBuildContext) {
		const instance = (context.settings as { instance: unknown }).instance;
		return {
			kind: "capability:compaction",
			source: context.source,
			toCapability: () => ({
				kind: "compaction",
				name: "compaction",
				source: context.source,
				instance,
			}),
		};
	}
}

function selectedCompaction(source: string, instance: unknown): HcpClientcomponent {
	return {
		module: "compaction",
		kind: "compaction",
		name: "compaction",
		product: "capability",
		source,
		selected: true,
		autoload: false,
		descriptorPath: "compaction/compaction.toml",
		slot: "compaction",
		requires: [],
		settings: { instance },
		HcpMagnet,
	};
}

describe("compaction capability injection", () => {
	it("assembles the selected Pi source and returns its provider by slot", async () => {
		const hcp = new HcpClient();
		const result = await HcpClientassemble({
			hcp,
			repoRoot: process.cwd(),
			includeAutoload: false,
			modules: ["compaction"],
		});

		expect(result.diagnostics).toEqual([]);
		expect(hcp.resolveCapability("compaction")).toBe(piCompactionProvider);
		expect(hcp.describeAll()[0]).toMatchObject({
			target: "capability:compaction",
			metadata: { source: "pi" },
		});
	});

	it("lets assembly replace the selected source while consumers keep the same slot", async () => {
		const spy = { defaultSettings: piCompactionProvider.defaultSettings, marker: "SPY" };
		const hcp = new HcpClient();
		const result = await HcpClientassemble({
			hcp,
			repoRoot: process.cwd(),
			includeAutoload: false,
			components: [selectedCompaction("fixture", spy)],
		});

		expect(result.diagnostics).toEqual([]);
		expect(hcp.resolveCapability<typeof spy>("compaction")).toBe(spy);
		expect(hcp.describeAll()[0]?.metadata?.source).toBe("fixture");
	});

	it("changes the implementation only when the selected component changes", async () => {
		async function resolveLabel(source: string, label: string): Promise<string | undefined> {
			const hcp = new HcpClient();
			await HcpClientassemble({
				hcp,
				repoRoot: process.cwd(),
				includeAutoload: false,
				components: [selectedCompaction(source, { label })],
			});
			return hcp.resolveCapability<{ label: string }>("compaction")?.label;
		}

		expect(await resolveLabel("pi", "PI IMPL")).toBe("PI IMPL");
		expect(await resolveLabel("magenta", "MAGENTA IMPL")).toBe("MAGENTA IMPL");
	});
});
