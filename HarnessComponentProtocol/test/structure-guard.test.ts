import { describe, expect, it } from "vitest";

type SourceLocation = { line: number; column: number };
type HcpClientsyntaxinspection = {
	forbiddenIdentifiers: Array<SourceLocation & { name: string }>;
	forbiddenInfrastructureIdentifiers: Array<SourceLocation & { name: string }>;
	hcpClientConstructions: SourceLocation[];
	interfaceDeclarations: Array<SourceLocation & { name: string }>;
	implementsClauses: Array<SourceLocation & { className: string }>;
	moduleDependencies: Array<SourceLocation & { source: string }>;
	toHcpServerMembers: SourceLocation[];
	unprefixedTopLevelDeclarations: Array<SourceLocation & { name: string }>;
};
type StructureGuard = {
	hasNamedClassExport(source: string, className: string, fileName?: string): boolean;
	HcpClientinspectsyntax(source: string, fileName?: string): HcpClientsyntaxinspection;
	HcpClientisconcreteroledependency(specifier: string): boolean;
	HcpClientisforbiddeninfrastructuredependency(specifier: string): boolean;
	isAllowedInfrastructurePath(relativePath: string): boolean;
};

const structureGuardUrl = new URL("../scripts/check-structure.mjs", import.meta.url);
const {
	hasNamedClassExport,
	HcpClientinspectsyntax,
	HcpClientisconcreteroledependency,
	HcpClientisforbiddeninfrastructuredependency,
	isAllowedInfrastructurePath,
}: StructureGuard = await import(structureGuardUrl.href);

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

	it("requires Hcp-prefixed private top-level helpers without policing nested implementation names", () => {
		const inspected = HcpClientinspectsyntax(`
			import { readFile } from "node:fs/promises";
			const HCP_ROOT = ".";
			type HcpClientstate = {};
			function HcpClientassemble() { function nestedHelper() {} }
			function requestId() {}
			const parseResponse = () => undefined;
		`);

		expect(inspected.unprefixedTopLevelDeclarations.map(({ name }) => name).sort()).toEqual([
			"parseResponse",
			"requestId",
		]);
	});

	it("detects Package and MCP details crossing into .HCP even through aliased imports", () => {
		const inspected = HcpClientinspectsyntax(`
			import type { PackageOverlay as Overlay } from "../../_magenta/packages/package-overlay-v2.ts";
			import type { PackageToolBuildSettings } from "../../tools/descriptor/package-tool.ts";
			import type { McpConnection as Connection } from "../../_magenta/mcp/tool.ts";
			const HcpClientsettings = value.mcp.connection;
		`);

		expect(inspected.moduleDependencies.map(({ source }) => source)).toEqual([
			"../../_magenta/packages/package-overlay-v2.ts",
			"../../tools/descriptor/package-tool.ts",
			"../../_magenta/mcp/tool.ts",
		]);
		expect(inspected.forbiddenInfrastructureIdentifiers.map(({ name }) => name).sort()).toEqual([
			"McpConnection",
			"PackageOverlay",
			"PackageToolBuildSettings",
			"mcp",
		]);
	});

	it("rejects only closed-boundary infrastructure imports", () => {
		expect(HcpClientisforbiddeninfrastructuredependency("../../_magenta/utils/pi/toml.ts")).toBe(true);
		expect(HcpClientisforbiddeninfrastructuredependency("../../tools/descriptor/package-tool.ts")).toBe(true);
		expect(HcpClientisforbiddeninfrastructuredependency("@scope/mcp-client")).toBe(true);
		expect(HcpClientisforbiddeninfrastructuredependency("smol-toml")).toBe(false);
		expect(HcpClientisforbiddeninfrastructuredependency("../HcpServerTypes.ts")).toBe(false);
	});

	it("detects concrete role imports through static and dynamic syntax", () => {
		const inspected = HcpClientinspectsyntax(`
			import type { HcpServer } from "../../runtime/HcpServer.ts";
			const HcpClientmagnet = import("../../tools/read/pi/HcpMagnet.ts");
			const HcpClientlegacy = require("../../tools/write/pi/HcpMagnet.ts");
		`);

		expect(inspected.moduleDependencies.map(({ source }) => source)).toEqual([
			"../../runtime/HcpServer.ts",
			"../../tools/read/pi/HcpMagnet.ts",
			"../../tools/write/pi/HcpMagnet.ts",
		]);
		expect(HcpClientisconcreteroledependency("../../runtime/HcpServer.ts")).toBe(true);
		expect(HcpClientisconcreteroledependency("../../tools/read/pi/HcpMagnet.ts")).toBe(true);
		expect(HcpClientisconcreteroledependency("../HcpServerTypes.ts")).toBe(false);
	});

	it("keeps .HCP as a closed protocol layout", () => {
		expect(isAllowedInfrastructurePath("assembly/session-hcp.ts")).toBe(true);
		expect(isAllowedInfrastructurePath("transport/hcp-process.ts")).toBe(true);
		expect(isAllowedInfrastructurePath("mcp/client.ts")).toBe(false);
		expect(isAllowedInfrastructurePath("packages/package-overlay-v2.ts")).toBe(false);
		expect(isAllowedInfrastructurePath("transport/client.ts")).toBe(false);
	});
});
