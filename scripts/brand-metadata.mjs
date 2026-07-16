import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parse as parseToml } from "smol-toml";

function pathInside(root, candidate) {
	const pathFromRoot = relative(root, candidate);
	return (
		pathFromRoot === "" ||
		(!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))
	);
}

export function readActiveBrandMetadata(root) {
	const brandsRoot = resolve(root, "brands");
	const registryPath = resolve(brandsRoot, "registry.toml");
	let registry;
	try {
		registry = parseToml(readFileSync(registryPath, "utf8"));
	} catch (error) {
		throw new Error(`Could not parse ${registryPath}: ${error instanceof Error ? error.message : String(error)}`);
	}

	const activeBrand = registry.active;
	if (typeof activeBrand !== "string" || !activeBrand) {
		throw new Error(`Could not find the active brand in ${registryPath}.`);
	}
	const brands = Array.isArray(registry.brands) ? registry.brands : [];
	const entry = brands.find((candidate) => candidate?.name === activeBrand);
	if (!entry || typeof entry.path !== "string" || !entry.path) {
		throw new Error(`Active brand ${activeBrand} has no registered configuration path.`);
	}

	const configPath = resolve(brandsRoot, entry.path);
	if (!pathInside(brandsRoot, configPath)) {
		throw new Error(`Active brand configuration escapes the brands directory: ${entry.path}`);
	}
	const configSource = readFileSync(configPath, "utf8");
	const displayName = configSource.match(/^\s*name:\s*"([^"]+)"/mu)?.[1];
	const version = configSource.match(/^\s*version:\s*"([^"]+)"\s*,?\s*$/mu)?.[1];
	if (!displayName) throw new Error(`Could not read the product name from ${configPath}.`);
	if (!version) throw new Error(`Could not read the product version from ${configPath}.`);

	return {
		activeBrand,
		configPath,
		configRelativePath: relative(root, configPath).replaceAll("\\", "/"),
		configSource,
		displayName,
		version,
	};
}
