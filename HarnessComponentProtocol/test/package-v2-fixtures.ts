/**
 * Test fixture builder for v2 isomorphic packages.
 *
 * Generates on-disk packages that match the real MagentaPackages v2 structure:
 *   <packagesRoot>/<PackageId>/
 *     package.toml                          (manifest with [[components]])
 *     <module>/<item>/<source>/HcpMagnet.ts (tool/skill: item-type)
 *     <module>/<source>/HcpMagnet.ts        (brand/system-prompt: direct-type)
 *     ...plus descriptor tomls / content files beside each magnet
 *
 * The generated HcpMagnet.ts files are real bare classes (spec §2) matching the
 * canonical shapes from MagentaPackages: tools emit descriptor(), resources emit
 * toResource() with import.meta.url-relative content paths.
 */

import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

async function writeText(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content, "utf-8");
}

/** A component to include in a fixture package. */
export type FixtureComponent =
	| FixtureToolComponent
	| FixtureSkillComponent
	| FixtureBrandComponent
	| FixtureSystemPromptComponent;

export type FixtureToolComponent = {
	kind: "tool";
	/** Item directory name, e.g. "bio-api". */
	item: string;
	/** Tool run-name used in the toml + component name, e.g. "bio_api". */
	name: string;
	source: string;
	profiles?: string[];
	/** Descriptor toml body (runtime/command/etc). */
	descriptorToml: string;
	/** Optional extra files to write beside the magnet (relative name -> content, with optional mode). */
	extraFiles?: { name: string; content: string; mode?: number }[];
};

export type FixtureSkillComponent = {
	kind: "skill";
	item: string;
	name: string;
	source: string;
	profiles?: string[];
	includeInContext?: boolean;
	skillMarkdown?: string;
};

export type FixtureBrandComponent = {
	kind: "brand";
	name: string;
	source: string;
	brandToml?: string;
};

export type FixtureSystemPromptComponent = {
	kind: "system-prompt";
	name: string;
	source: string;
	mergeMode?: "append" | "replace";
	systemPromptToml?: string;
};

export type FixturePackage = {
	id: string;
	version?: string;
	source: string;
	domain?: string;
	profiles?: { name: string; description?: string }[];
	components: FixtureComponent[];
};

/** Generate a tool magnet matching the canonical descriptor-provider shape. */
function toolMagnetSource(item: string, name: string, source: string): string {
	return `import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export class HcpMagnet {
	static readonly module = "tools/${item}";
	static readonly kind = "tool";
	static readonly source = "${source}";
	static build(context: unknown) {
		return new HcpMagnet(context);
	}

	readonly kind = "tool";
	readonly source = "${source}";
	readonly descriptorPath = join(dirname(fileURLToPath(import.meta.url)), "${item}.toml");
	private readonly context: unknown;

	constructor(context: unknown) {
		this.context = context;
	}

	descriptor() {
		return {
			kind: "tool" as const,
			name: "${name}",
			source: "${source}",
			descriptorPath: this.descriptorPath,
		};
	}
}
`;
}

/** Generate a skill magnet matching the canonical resource shape. */
function skillMagnetSource(item: string, name: string, source: string): string {
	return `import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export class HcpMagnet {
	static readonly module = "skills/${item}";
	static readonly kind = "skill";
	static readonly source = "${source}";
	static build(_context: unknown) {
		return new HcpMagnet();
	}

	readonly kind = "resource:skill";
	readonly source = "${source}";

	toResource() {
		return {
			kind: "skill",
			name: "${name}",
			source: "${source}",
			mergeMode: "replace" as const,
			contentPath: join(dirname(fileURLToPath(import.meta.url)), "SKILL.md"),
		};
	}
}
`;
}

function brandMagnetSource(name: string, source: string): string {
	return `import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export class HcpMagnet {
	static readonly module = "brand";
	static readonly kind = "brand";
	static readonly source = "${source}";
	static build(_context: unknown) {
		return new HcpMagnet();
	}

	readonly kind = "resource:brand";
	readonly source = "${source}";

	toResource() {
		return {
			kind: "brand",
			name: "${name}",
			source: "${source}",
			mergeMode: "replace" as const,
			descriptorPath: join(dirname(fileURLToPath(import.meta.url)), "brand.toml"),
		};
	}
}
`;
}

function systemPromptMagnetSource(name: string, source: string, mergeMode: "append" | "replace"): string {
	return `import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export class HcpMagnet {
	static readonly module = "system-prompt";
	static readonly kind = "system-prompt";
	static readonly source = "${source}";
	static build(_context: unknown) {
		return new HcpMagnet();
	}

	readonly kind = "resource:system-prompt";
	readonly source = "${source}";

	toResource() {
		return {
			kind: "system-prompt",
			name: "${name}",
			source: "${source}",
			mergeMode: "${mergeMode}" as const,
			descriptorPath: join(dirname(fileURLToPath(import.meta.url)), "system-prompt.toml"),
		};
	}
}
`;
}

/**
 * Write a complete v2 fixture package into <packagesRoot>/<id>/.
 * Returns the package directory.
 */
export async function writeFixturePackage(packagesRoot: string, pkg: FixturePackage): Promise<string> {
	const packageDir = join(packagesRoot, pkg.id);
	const componentDecls: string[] = [];

	for (const component of pkg.components) {
		if (component.kind === "tool") {
			const dir = join(packageDir, "tools", component.item, component.source);
			await writeText(join(dir, "HcpMagnet.ts"), toolMagnetSource(component.item, component.name, component.source));
			await writeText(join(dir, `${component.item}.toml`), component.descriptorToml);
			for (const extra of component.extraFiles ?? []) {
				const extraPath = join(dir, extra.name);
				await writeText(extraPath, extra.content);
				if (extra.mode !== undefined) await chmod(extraPath, extra.mode);
			}
			componentDecls.push(
				`[[components]]\nkind = "tool"\nname = "${component.name}"\nsource = "${component.source}"\npath = "tools/${component.item}/${component.source}"${
					component.profiles ? `\nprofiles = [${component.profiles.map((p) => `"${p}"`).join(", ")}]` : ""
				}\n`,
			);
		} else if (component.kind === "skill") {
			const dir = join(packageDir, "skills", component.item, component.source);
			await writeText(
				join(dir, "HcpMagnet.ts"),
				skillMagnetSource(component.item, component.name, component.source),
			);
			await writeText(
				join(dir, "SKILL.md"),
				component.skillMarkdown ?? `# ${component.name}\n\nFixture skill content.\n`,
			);
			componentDecls.push(
				`[[components]]\nkind = "skill"\nname = "${component.name}"\nsource = "${component.source}"\npath = "skills/${component.item}/${component.source}"${
					component.includeInContext ? `\ninclude_in_context = true` : ""
				}${component.profiles ? `\nprofiles = [${component.profiles.map((p) => `"${p}"`).join(", ")}]` : ""}\n`,
			);
		} else if (component.kind === "brand") {
			const dir = join(packageDir, "brand", component.source);
			await writeText(join(dir, "HcpMagnet.ts"), brandMagnetSource(component.name, component.source));
			await writeText(
				join(dir, "brand.toml"),
				component.brandToml ?? `name = "${component.name}"\ndisplay_name = "${component.name}"\n`,
			);
			componentDecls.push(
				`[[components]]\nkind = "brand"\nname = "${component.name}"\nsource = "${component.source}"\npath = "brand/${component.source}"\n`,
			);
		} else if (component.kind === "system-prompt") {
			const mergeMode = component.mergeMode ?? "append";
			const dir = join(packageDir, "system-prompt", component.source);
			await writeText(
				join(dir, "HcpMagnet.ts"),
				systemPromptMagnetSource(component.name, component.source, mergeMode),
			);
			await writeText(
				join(dir, "system-prompt.toml"),
				component.systemPromptToml ??
					`kind = "system-prompt"\nname = "${component.name}"\ncontent_path = "SYSTEM.md"\n`,
			);
			await writeText(join(dir, "SYSTEM.md"), `Fixture system prompt for ${component.name}.\n`);
			componentDecls.push(
				`[[components]]\nkind = "system-prompt"\nname = "${component.name}"\nsource = "${component.source}"\npath = "system-prompt/${component.source}"\n`,
			);
		}
	}

	const profilesToml = (pkg.profiles ?? [])
		.map(
			(p) =>
				`[[profiles]]\nname = "${p.name}"${p.description ? `\ndescription = "${p.description}"` : ""}\nextends = []\n`,
		)
		.join("\n");

	const manifest = `schema_version = "magenta.package.v2"
id = "${pkg.id}"
name = "${pkg.id}"
version = "${pkg.version ?? "1.0.0"}"
kind = "domain"
domain = "${pkg.domain ?? "test"}"
source = "${pkg.source}"
default_profiles = []

${profilesToml}
${componentDecls.join("\n")}`;

	await writeText(join(packageDir, "package.toml"), manifest);
	return packageDir;
}
