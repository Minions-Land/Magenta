import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const harnessRoot = fileURLToPath(new URL("..", import.meta.url));
const inspectScript = fileURLToPath(new URL("../scripts/inspect.mjs", import.meta.url));

function HcpClientinspectoutput(...args: string[]): string {
	return execFileSync(process.execPath, [inspectScript, ...args], {
		cwd: harnessRoot,
		encoding: "utf8",
	});
}

describe("Harness inspect", () => {
	it("reports legal HcpServer and HcpMagnet count fields in JSON", () => {
		const report = JSON.parse(HcpClientinspectoutput("--json")) as {
			hcp: Record<string, unknown>;
		};

		expect(report.hcp.HcpServerCount).toBeTypeOf("number");
		expect(report.hcp.HcpMagnetCount).toBeTypeOf("number");
		expect(report.hcp).not.toHaveProperty("HcpMagnetClassCount");
	});

	it("prints the HcpMagnet role count", () => {
		const report = JSON.parse(HcpClientinspectoutput("--json")) as {
			hcp: { HcpServerCount: number; HcpMagnetCount: number };
		};
		const output = HcpClientinspectoutput();

		expect(output).toContain(`HcpServers: ${report.hcp.HcpServerCount}`);
		expect(output).toContain(`HcpMagnet classes: ${report.hcp.HcpMagnetCount}`);
	});
});
