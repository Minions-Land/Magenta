import chalk from "chalk";
import { buildHarnessComponentsView, type HarnessComponentView } from "../core/harness-switches.ts";

export interface HarnessListOptions {
	json?: boolean;
}

function sourceSummary(component: HarnessComponentView): string {
	return component.sources.map((source) => `${source.source}:${source.status}`).join(", ");
}

export async function listHarnessModules(options: HarnessListOptions = {}): Promise<void> {
	const components = buildHarnessComponentsView().components;

	if (options.json) {
		console.log(
			JSON.stringify(
				{
					componentCount: components.length,
					components,
				},
				null,
				2,
			),
		);
		return;
	}

	console.log(chalk.bold(`Harness components (${components.length})`));
	for (const component of components) {
		console.log(`${component.id.padEnd(30)} ${component.status} · ${sourceSummary(component)}`);
	}
}
