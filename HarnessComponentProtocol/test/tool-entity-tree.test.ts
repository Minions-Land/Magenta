import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HcpClientassemble } from "../.HCP/assembly/session-hcp.ts";
import { HCP_MAGNETS, HCP_SERVERS } from "../.HCP/assembly/sources.generated.ts";
import { parseToml } from "../_magenta/utils/pi/toml.ts";
import { HcpClient } from "../HcpClient.ts";

const HARNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOOL_COMPONENTS = HCP_MAGNETS.filter((entry) => entry.product === "tool" && entry.module.startsWith("tools/"));

function toolComponentsByDescriptor() {
	const grouped = new Map<string, (typeof TOOL_COMPONENTS)[number][]>();
	for (const entry of TOOL_COMPONENTS) {
		const entries = grouped.get(entry.descriptorPath) ?? [];
		entries.push(entry);
		grouped.set(entry.descriptorPath, entries);
	}
	return grouped;
}

describe("HCP tool entity tree", () => {
	it("gives every TOML tool row a real leaf Server and source Magnet", () => {
		for (const entry of TOOL_COMPONENTS) {
			expect(HCP_SERVERS.has(entry.module), `${entry.module} Server`).toBe(true);
			expect(entry.HcpMagnet.module).toBe(entry.module);
			expect(entry.HcpMagnet.kind).toBe(entry.kind);
			expect(entry.HcpMagnet.source).toBe(entry.source);
			expect(typeof entry.HcpMagnet.build).toBe("function");

			const sourceDirectory = resolve(HARNESS_ROOT, dirname(entry.descriptorPath), entry.source);
			const magnetSource = readFileSync(resolve(sourceDirectory, "HcpMagnet.ts"), "utf8");
			expect(magnetSource).toMatch(/\bexport\s+class\s+HcpMagnet\b/);
			expect(magnetSource).toMatch(/\btoTool\s*\(/);
			expect(magnetSource).not.toMatch(/\btoHcpServer\s*\(/);
		}
	});

	it("marks exactly the source selected by each tool descriptor", () => {
		for (const [descriptorPath, entries] of toolComponentsByDescriptor()) {
			const descriptor = parseToml(readFileSync(resolve(HARNESS_ROOT, descriptorPath), "utf8"));
			expect(descriptor.product).toBe("tool");
			expect(entries.filter((entry) => entry.selected).map((entry) => entry.source)).toEqual([descriptor.source]);
		}
	});

	it("keeps tools/HcpServer as the explicit grouping node", () => {
		expect(HCP_SERVERS.has("tools")).toBe(true);
		const groupingPath = resolve(HARNESS_ROOT, "tools", "HcpServer.ts");
		expect(readFileSync(groupingPath, "utf8")).toContain('readonly moduleName = "tools"');
	});

	it("routes explicitly selected host tools through root and leaf Servers", async () => {
		const modules = [
			"tools/read",
			"tools/edit",
			"tools/write",
			"tools/grep",
			"tools/find",
			"tools/ls",
			"tools/show",
			"tools/todo",
		];
		const hcp = new HcpClient();
		const result = await HcpClientassemble({
			hcp,
			repoRoot: HARNESS_ROOT,
			includeAutoload: false,
			modules,
		});

		expect(result.diagnostics).toEqual([]);
		expect(hcp.resolveModule("tools")).toBeDefined();
		for (const module of modules) {
			const name = module.slice("tools/".length);
			expect(hcp.resolve(`tool:${name}`), name).toBe(hcp.resolveModule(module));
			expect(hcp.resolveInstance<{ name: string }>(`tool:${name}`)?.name, name).toBe(name);
		}
	});
});
