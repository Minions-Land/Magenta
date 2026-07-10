import { getHarnessRegistryPath, type HarnessModuleDescriptor, loadRegistry } from "@magenta/harness";
import chalk from "chalk";

export interface HarnessListOptions {
	json?: boolean;
}

function moduleImplementationSummary(module: HarnessModuleDescriptor): string {
	return module.implementations
		.map((implementation) => `${implementation.source}:${implementation.status}`)
		.join(", ");
}

function moduleDescription(module: HarnessModuleDescriptor): string {
	const implementations = moduleImplementationSummary(module);
	return `${module.status}${implementations ? ` · ${implementations}` : ""}`;
}

export async function listHarnessModules(options: HarnessListOptions = {}): Promise<void> {
	const registry = await loadRegistry(getHarnessRegistryPath());
	const modules = registry.modules.slice().sort((left, right) => left.id.localeCompare(right.id));

	if (options.json) {
		console.log(
			JSON.stringify(
				{
					name: registry.name,
					description: registry.description,
					moduleCount: modules.length,
					modules: modules.map((module) => ({
						id: module.id,
						kind: module.kind,
						name: module.name,
						description: module.description,
						status: module.status,
						capability: module.capability,
						path: module.path,
						implementations: module.implementations,
					})),
				},
				null,
				2,
			),
		);
		return;
	}

	console.log(chalk.bold(`Harness modules (${modules.length})`));
	for (const module of modules) {
		console.log(`${module.id.padEnd(30)} ${moduleDescription(module)}`);
	}
}
