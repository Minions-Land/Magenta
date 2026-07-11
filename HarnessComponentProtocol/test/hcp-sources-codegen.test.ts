import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

type HcpClientcollectedsources = {
	harnessRoot: string;
	harnessTomlPath: string;
	servers: Array<{ module: string; path: string }>;
	magnets: Array<{ kind: unknown; module: string; source: string; path: string }>;
	entries: Array<{
		module: string;
		kind: string;
		name: string;
		product: "tool" | "capability" | "resource";
		source: string;
		selected: boolean;
		autoload: boolean;
		hotSwappable: boolean;
		descriptorPath: string;
		slot?: string;
		requires: string[];
		path: string;
	}>;
};

type GeneratorOptions = {
	harnessRoot?: string;
	harnessTomlPath?: string;
	outputPath?: string;
	check?: boolean;
};

type HcpClientsourcegenerator = {
	HcpClientcollectsources(options?: GeneratorOptions): HcpClientcollectedsources;
	HcpClientrendersources(collected: HcpClientcollectedsources, outputPath: string): string;
	HcpClientgeneratesources(options?: GeneratorOptions): {
		changed: boolean;
		outputPath: string;
		collected: HcpClientcollectedsources;
	};
};

const generatorUrl = new URL("../scripts/generate-hcp-sources.mjs", import.meta.url);
const { HcpClientcollectsources, HcpClientgeneratesources, HcpClientrendersources }: HcpClientsourcegenerator =
	await import(generatorUrl.href);

const HARNESS_ROOT = fileURLToPath(new URL("..", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function createFixture(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "hcp-sources-codegen-"));
	temporaryDirectories.push(root);
	await mkdir(join(root, "lifecycle", "workflow", "magenta"), { recursive: true });
	await mkdir(join(root, "skills", "demo", "pi"), { recursive: true });
	await mkdir(join(root, "tools", "magenta"), { recursive: true });
	await mkdir(join(root, "tools", "read", "magenta"), { recursive: true });
	await mkdir(join(root, "tools", "read", "pi"), { recursive: true });
	await mkdir(join(root, ".HCP", "assembly"), { recursive: true });
	await writeFile(
		join(root, "harness.toml"),
		`[[modules]]
kind = "tool"
name = "tools"
path = "tools"
sources = ["magenta"]
product = "tool"

[[components]]
kind = "hook"
name = "hooks"
path = "lifecycle/hooks.toml"

[[components]]
kind = "tool"
name = "read"
path = "tools/read/read.toml"

[[components]]
kind = "skill"
name = "demo"
path = "skills/demo/demo.toml"
`,
	);
	await writeFile(
		join(root, "lifecycle", "hooks.toml"),
		`kind = "hook"
product = "capability"
slot = "hook"
autoload = true
hot_swappable = true
name = "hooks"
source = "magenta"
impl = ["lifecycle/workflow/magenta/provider.ts"]
`,
	);
	await writeFile(
		join(root, "lifecycle", "HcpServer.ts"),
		'export class HcpServer { readonly moduleName = "lifecycle"; }\n',
	);
	await writeFile(
		join(root, "lifecycle", "workflow", "magenta", "HcpMagnet.ts"),
		'export class HcpMagnet { static readonly module = "lifecycle"; static readonly kind = "hook"; static readonly source = "magenta"; static build() { return new HcpMagnet(); } }\n',
	);
	await writeFile(join(root, "lifecycle", "workflow", "magenta", "provider.ts"), "export {};\n");
	await writeFile(join(root, "tools", "HcpServer.ts"), 'export class HcpServer { readonly moduleName = "tools"; }\n');
	await writeFile(
		join(root, "tools", "magenta", "HcpMagnet.ts"),
		'export class HcpMagnet { static readonly module = "tools"; static readonly kind = "tool"; static readonly source = "magenta"; static build() { return new HcpMagnet(); } }\n',
	);
	await writeFile(
		join(root, "tools", "read", "read.toml"),
		'kind = "tool"\nproduct = "tool"\nname = "read"\nsource = "pi"\nsources = ["pi", "magenta"]\n',
	);
	await writeFile(
		join(root, "tools", "read", "HcpServer.ts"),
		'export class HcpServer { readonly moduleName = "tools/read"; }\n',
	);
	await writeFile(
		join(root, "tools", "read", "pi", "HcpMagnet.ts"),
		'export class HcpMagnet { static readonly module = "tools/read"; static readonly kind = "tool"; static readonly source = "pi"; static build() { return new HcpMagnet(); } }\n',
	);
	await writeFile(
		join(root, "tools", "read", "magenta", "HcpMagnet.ts"),
		'export class HcpMagnet { static readonly module = "tools/read"; static readonly kind = "tool"; static readonly source = "magenta"; static build() { return new HcpMagnet(); } }\n',
	);
	await writeFile(
		join(root, "skills", "demo", "demo.toml"),
		'kind = "skill"\nproduct = "resource"\nautoload = true\nname = "demo"\nsource = "pi"\n',
	);
	await writeFile(
		join(root, "skills", "demo", "HcpServer.ts"),
		'export class HcpServer { readonly moduleName = "skills/demo"; }\n',
	);
	await writeFile(
		join(root, "skills", "demo", "pi", "HcpMagnet.ts"),
		'export class HcpMagnet { static readonly module = "skills/demo"; static readonly kind = "skill"; static readonly source = "pi"; static build() { return new HcpMagnet(); } }\n',
	);
	return root;
}

async function createDependencyCycleFixture(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "hcp-sources-dependencies-"));
	temporaryDirectories.push(root);
	const components = [
		{ name: "alpha", requires: ["beta"] },
		{ name: "beta", requires: ["alpha"] },
	];
	await writeFile(
		join(root, "harness.toml"),
		components
			.map(({ name }) => `[[components]]\nkind = "${name}"\nname = "${name}"\npath = "${name}/${name}.toml"\n`)
			.join("\n"),
	);
	for (const { name, requires } of components) {
		await mkdir(join(root, name, "magenta"), { recursive: true });
		await writeFile(
			join(root, name, `${name}.toml`),
			`kind = "${name}"\nproduct = "capability"\nslot = "${name}"\nautoload = true\nrequires = ${JSON.stringify(requires)}\nname = "${name}"\nsource = "magenta"\n`,
		);
		await writeFile(
			join(root, name, "HcpServer.ts"),
			`export class HcpServer { readonly moduleName = "${name}"; }\n`,
		);
		await writeFile(
			join(root, name, "magenta", "HcpMagnet.ts"),
			`export class HcpMagnet { static readonly module = "${name}"; static readonly kind = "${name}"; static readonly source = "magenta"; static build() { return new HcpMagnet(); } }\n`,
		);
	}
	return root;
}

describe("HCP assembly source codegen", () => {
	it("keeps the checked-in generated assembly synchronized", () => {
		expect(() => HcpClientgeneratesources({ harnessRoot: HARNESS_ROOT, check: true })).not.toThrow();
	});

	it("derives module identity and nested source paths from TOML", async () => {
		const root = await createFixture();
		const collected = HcpClientcollectsources({ harnessRoot: root });

		expect(collected.servers.map(({ module }) => module)).toEqual([
			"lifecycle",
			"skills/demo",
			"tools",
			"tools/read",
		]);
		expect(collected.magnets).toHaveLength(5);
		expect(collected.entries).toHaveLength(5);
		const lifecycle = collected.magnets.find(({ module }) => module === "lifecycle");
		expect(lifecycle).toMatchObject({ module: "lifecycle", source: "magenta" });
		expect(lifecycle?.path).toBe(join(root, "lifecycle", "workflow", "magenta", "HcpMagnet.ts"));
		expect(collected.entries.find(({ module }) => module === "lifecycle")).toMatchObject({
			kind: "hook",
			name: "hooks",
			product: "capability",
			source: "magenta",
			selected: true,
			autoload: true,
			hotSwappable: true,
			descriptorPath: "lifecycle/hooks.toml",
			slot: "hook",
			requires: [],
		});
		expect(
			collected.entries
				.filter(({ module }) => module === "tools/read")
				.map(({ source, selected, autoload, hotSwappable }) => ({ source, selected, autoload, hotSwappable })),
		).toEqual([
			{ source: "magenta", selected: false, autoload: false, hotSwappable: false },
			{ source: "pi", selected: true, autoload: false, hotSwappable: false },
		]);

		const outputPath = join(root, ".HCP", "assembly", "sources.generated.ts");
		const generated = HcpClientrendersources(collected, outputPath);
		expect(generated).toContain('import * as lifecycle from "../../lifecycle/HcpServer.ts";');
		expect(generated).toContain(
			'import * as lifecycleWorkflowMagenta from "../../lifecycle/workflow/magenta/HcpMagnet.ts";',
		);
		expect(generated).toContain('["lifecycle", lifecycle.HcpServer]');
		expect(generated).toContain("HcpMagnet: lifecycleWorkflowMagenta.HcpMagnet");
		expect(generated).toContain('["tools", tools.HcpServer]');
		expect(generated).toContain("HcpMagnet: toolsMagenta.HcpMagnet");
		expect(generated).toContain('["tools/read", toolsRead.HcpServer]');
		expect(generated).toContain("HcpMagnet: toolsReadMagenta.HcpMagnet");
		expect(generated).toContain("export const HCP_MAGNETS: readonly HcpMagnetentry[]");
		expect(generated).toContain('product: "capability"');
		expect(generated).toContain('slot: "hook"');
		expect(generated).toContain("hotSwappable: true");
		expect(generated).toContain("requires: []");
		expect(generated).toContain("readonly build: (context: HcpMagnetBuildContext) => unknown | Promise<unknown>");
		expect(generated).not.toContain("readonly isDefault");
		expect(generated).not.toContain("CAPABILITY_SOURCE_MAGNETS");
		expect(generated).not.toContain("TOOL_SOURCE_MAGNETS");
		expect(generated).not.toContain("SKILL_SOURCE_MAGNETS");
		expect((generated.match(/^export const /gm) ?? []).length).toBe(2);
	});

	it("detects a stale generated file", async () => {
		const root = await createFixture();
		const outputPath = resolve(root, ".HCP", "assembly", "sources.generated.ts");
		HcpClientgeneratesources({ harnessRoot: root, outputPath });
		expect(() => HcpClientgeneratesources({ harnessRoot: root, outputPath, check: true })).not.toThrow();

		await writeFile(outputPath, "// stale\n");
		expect(() => HcpClientgeneratesources({ harnessRoot: root, outputPath, check: true })).toThrow(
			/is missing or stale/,
		);
	});

	it("rejects declared infrastructure or shared code without real HCP roles", async () => {
		const root = await createFixture();
		await mkdir(join(root, ".HCP", "transport"), { recursive: true });
		await writeFile(join(root, ".HCP", "transport", "transport.toml"), 'kind = "assembly"\nname = "transport"\n');
		await writeFile(
			join(root, "harness.toml"),
			`[[components]]
kind = "assembly"
name = "transport"
path = ".HCP/transport/transport.toml"
`,
		);

		expect(() => HcpClientcollectsources({ harnessRoot: root })).toThrow(
			/missing .*HcpServer\.ts.*must not be declared/s,
		);
	});

	it("rejects production role files that are absent from TOML declarations", async () => {
		const root = await createFixture();
		await mkdir(join(root, "tools", "read", "codex"), { recursive: true });
		await writeFile(
			join(root, "tools", "read", "codex", "HcpMagnet.ts"),
			'export class HcpMagnet { static readonly module = "tools/read"; static readonly kind = "tool"; static readonly source = "codex"; static build() { return new HcpMagnet(); } }\n',
		);

		expect(() => HcpClientcollectsources({ harnessRoot: root })).toThrow(
			/HcpMagnet\.ts role files missing from TOML declarations.*codex/,
		);
	});

	it("rejects role metadata that drifts from its TOML declaration", async () => {
		const root = await createFixture();
		await writeFile(
			join(root, "tools", "read", "magenta", "HcpMagnet.ts"),
			'export class HcpMagnet { static readonly module = "tools/read"; static readonly kind = "tool"; static readonly source = "pi"; static build() { return new HcpMagnet(); } }\n',
		);

		expect(() => HcpClientcollectsources({ harnessRoot: root })).toThrow(
			/source=pi does not match TOML declaration magenta/,
		);
	});

	it("retains one component row per declaration when a generated role class is shared", () => {
		const collected = HcpClientcollectsources({ harnessRoot: HARNESS_ROOT });
		const runtimeEntries = collected.entries.filter(({ module }) => module === "runtime");
		expect(runtimeEntries).toHaveLength(2);
		expect(new Set(runtimeEntries.map(({ path }) => path)).size).toBe(1);
		expect(runtimeEntries.map(({ slot }) => slot)).toEqual(["runtime:process", "runtime:script-runtimes"]);
		expect(runtimeEntries[1]).toMatchObject({
			product: "capability",
			selected: true,
			autoload: true,
			requires: ["runtime:process"],
		});
	});

	it("reads the selected source and autoload policy from component TOML", () => {
		const collected = HcpClientcollectsources({ harnessRoot: HARNESS_ROOT });
		const selectedTools = collected.entries
			.filter(({ product, selected }) => product === "tool" && selected)
			.map(({ name, source, autoload }) => ({ name, source, autoload }));
		expect(selectedTools).toContainEqual({ name: "read", source: "pi", autoload: false });
		expect(selectedTools).toContainEqual({ name: "lsp", source: "magenta", autoload: false });
		expect(selectedTools).toContainEqual({ name: "web-search", source: "magenta", autoload: true });
		expect(selectedTools).toContainEqual({ name: "web-fetch", source: "magenta", autoload: true });
		expect(
			collected.entries
				.filter(({ product, selected }) => product !== "tool" && selected)
				.every(({ autoload }) => autoload),
		).toBe(true);
		expect(
			collected.entries
				.filter(({ product, source }) => product === "resource" && source === "descriptor")
				.every(({ selected, autoload }) => !selected && !autoload),
		).toBe(true);
	});

	it("rejects a declared component without product metadata", async () => {
		const root = await createFixture();
		await writeFile(join(root, "skills", "demo", "demo.toml"), 'kind = "skill"\nname = "demo"\nsource = "pi"\n');

		expect(() => HcpClientcollectsources({ harnessRoot: root })).toThrow(
			/skills\/demo\/demo\.toml is missing product/,
		);
	});

	it("rejects a capability without an explicit slot", async () => {
		const root = await createFixture();
		await writeFile(
			join(root, "lifecycle", "hooks.toml"),
			'kind = "hook"\nproduct = "capability"\nname = "hooks"\nsource = "magenta"\nimpl = ["lifecycle/workflow/magenta/provider.ts"]\n',
		);

		expect(() => HcpClientcollectsources({ harnessRoot: root })).toThrow(/product=capability is missing slot/);
	});

	it("rejects a missing selected-component dependency", async () => {
		const root = await createFixture();
		await writeFile(
			join(root, "lifecycle", "hooks.toml"),
			'kind = "hook"\nproduct = "capability"\nslot = "hook"\nrequires = ["policy"]\nname = "hooks"\nsource = "magenta"\nimpl = ["lifecycle/workflow/magenta/provider.ts"]\n',
		);

		expect(() => HcpClientcollectsources({ harnessRoot: root })).toThrow(
			/requires policy.*no selected component provides/,
		);
	});

	it("does not treat a selected Tool address as a capability dependency provider", async () => {
		const root = await createFixture();
		await writeFile(
			join(root, "tools", "read", "read.toml"),
			'kind = "tool"\nproduct = "tool"\nname = "read"\nsource = "pi"\nsources = ["pi", "magenta"]\n\n[source_config.pi]\nrequires = ["tool:read"]\n',
		);

		expect(() => HcpClientcollectsources({ harnessRoot: root })).toThrow(
			/requires tool:read.*no selected component provides/,
		);
	});

	it("rejects a selected-component dependency cycle", async () => {
		const root = await createDependencyCycleFixture();

		expect(() => HcpClientcollectsources({ harnessRoot: root })).toThrow(
			/Selected component dependency cycle: alpha -> beta -> alpha/,
		);
	});

	it("ignores a dependency cycle declared only by an unselected source", async () => {
		const root = await createFixture();
		await writeFile(
			join(root, "tools", "read", "read.toml"),
			'kind = "tool"\nproduct = "tool"\nname = "read"\nsource = "magenta"\nsources = ["pi", "magenta"]\n\n[source_config.pi]\nrequires = ["tool:read"]\n',
		);

		expect(() => HcpClientcollectsources({ harnessRoot: root })).not.toThrow();
	});
});
