import { describe, expect, it } from "vitest";
import type { HcpMagnetResource } from "../.HCP/HcpMagnetTypes.ts";
import { HcpClient } from "../HcpClient.ts";
import * as paperAnalysisServer from "../skills/paper-analysis/HcpServer.ts";
import * as paperAnalysisPi from "../skills/paper-analysis/pi/HcpMagnet.ts";
import * as systemPromptPi from "../system-prompt/pi/HcpMagnet.ts";

const context = {
	repoRoot: process.cwd(),
	kind: "skill",
	name: "paper-analysis",
	source: "pi",
};

describe("Resource product", () => {
	it("is the only product produced by a skill Source Magnet", () => {
		const magnet = paperAnalysisPi.HcpMagnet.build(context);

		expect(magnet.toResource()).toMatchObject({
			kind: "skill",
			name: "paper-analysis",
			source: "pi",
			mergeMode: "replace",
		});
		expect((magnet as { toTool?: unknown }).toTool).toBeUndefined();
		expect((magnet as { toCapability?: unknown }).toCapability).toBeUndefined();
		expect((magnet as { toHcpServer?: unknown }).toHcpServer).toBeUndefined();
	});

	it("resolves through HcpClient and the real skill leaf Server", async () => {
		const magnet = paperAnalysisPi.HcpMagnet.build(context);
		const hcp = new HcpClient();
		hcp.registerModule(new paperAnalysisServer.HcpServer(), new Map([["pi", magnet]]));

		const resource = hcp.resolveInstance<HcpMagnetResource>("skill:paper-analysis");
		expect(resource).toEqual(magnet.toResource());
		await expect(hcp.dispatch({ target: "skill:paper-analysis", op: "describe" })).resolves.toMatchObject({
			target: "skill:paper-analysis",
			kind: "skill",
			metadata: { source: "pi", contentPath: resource?.contentPath },
		});
	});

	it("remains structurally distinct from a code capability", () => {
		const capability = new systemPromptPi.HcpMagnet({
			...context,
			kind: "system-prompt",
			name: "system-prompt",
		});

		expect(capability.toCapability()).toMatchObject({ kind: "system-prompt", source: "pi" });
		expect((capability as { toResource?: unknown }).toResource).toBeUndefined();
	});
});
