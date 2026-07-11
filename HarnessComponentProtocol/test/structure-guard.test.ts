import { describe, expect, it } from "vitest";

type SourceLocation = { line: number; column: number };
type HcpClientsyntaxinspection = {
	forbiddenIdentifiers: Array<SourceLocation & { name: string }>;
	hcpClientConstructions: SourceLocation[];
	interfaceDeclarations: Array<SourceLocation & { name: string }>;
	implementsClauses: Array<SourceLocation & { className: string }>;
	toHcpServerMembers: SourceLocation[];
};
type StructureGuard = {
	hasNamedClassExport(source: string, className: string, fileName?: string): boolean;
	HcpClientinspectsyntax(source: string, fileName?: string): HcpClientsyntaxinspection;
	isAllowedInfrastructurePath(relativePath: string): boolean;
};

const structureGuardUrl = new URL("../scripts/check-structure.mjs", import.meta.url);
const { hasNamedClassExport, HcpClientinspectsyntax, isAllowedInfrastructurePath }: StructureGuard = await import(
	structureGuardUrl.href
);

describe("HCP structure guard syntax checks", () => {
	it("requires a named role-class export", () => {
		expect(hasNamedClassExport("export class HcpServer {}", "HcpServer")).toBe(true);
		expect(hasNamedClassExport("export default class HcpServer {}", "HcpServer")).toBe(false);
		expect(hasNamedClassExport("// export class HcpServer {}\nexport interface HcpServer {}", "HcpServer")).toBe(
			false,
		);
	});

	it("finds retired production identifiers without matching comments or strings", () => {
		const inspected = HcpClientinspectsyntax(`
			// ModuleHcpServer and CapabilitySourceMagnet are historical names.
			const note = "ModuleHcpServer";
			class ModuleHcpServer {}
			type Source = CapabilitySourceMagnet;
		`);

		expect(inspected.forbiddenIdentifiers.map(({ name }) => name).sort()).toEqual([
			"CapabilitySourceMagnet",
			"ModuleHcpServer",
		]);
	});

	it("finds direct and qualified HcpClient construction", () => {
		const inspected = HcpClientinspectsyntax(`
			const one = new HcpClient();
			const two = new protocol.HcpClient();
		`);

		expect(inspected.hcpClientConstructions).toHaveLength(2);
	});

	it("finds interfaces, implements clauses, and HcpMagnet server factories", () => {
		const inspected = HcpClientinspectsyntax(`
			// interface IgnoredComment {}
			const ignoredString = "class Ignored implements Contract { toHcpServer() {} }";
			interface Contract {}
			class Adapter implements Contract {}
			export class HcpMagnet { toHcpServer() {} }
		`);

		expect(inspected.interfaceDeclarations.map(({ name }) => name)).toEqual(["Contract"]);
		expect(inspected.implementsClauses.map(({ className }) => className)).toEqual(["Adapter"]);
		expect(inspected.toHcpServerMembers).toHaveLength(1);
	});

	it("keeps .HCP as a closed protocol layout", () => {
		expect(isAllowedInfrastructurePath("assembly/session-hcp.ts")).toBe(true);
		expect(isAllowedInfrastructurePath("transport/hcp-process.ts")).toBe(true);
		expect(isAllowedInfrastructurePath("mcp/client.ts")).toBe(false);
		expect(isAllowedInfrastructurePath("packages/package-overlay.ts")).toBe(false);
		expect(isAllowedInfrastructurePath("transport/client.ts")).toBe(false);
	});
});
