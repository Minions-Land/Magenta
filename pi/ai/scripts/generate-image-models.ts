#!/usr/bin/env node

import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import type { ImagesModel } from "../src/types.ts";
import {
	assertMinimumCatalogSize,
	fetchRequiredJson,
	writeGeneratedFilesAtomically,
} from "./generation-io.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = process.env.PI_AI_GENERATION_ROOT ? resolve(process.env.PI_AI_GENERATION_ROOT) : join(__dirname, "..");
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_IMAGE_MODELS_URL =
	process.env.PI_OPENROUTER_IMAGE_MODELS_URL ?? `${OPENROUTER_BASE_URL}/models?output_modalities=image`;
const MIN_OPENROUTER_IMAGE_MODELS = 5;

interface OpenRouterModelRecord {
	id: string;
	name: string;
	context_length?: number;
	architecture?: {
		input_modalities?: string[];
		output_modalities?: string[];
	};
	pricing?: {
		prompt?: string;
		completion?: string;
		input_cache_read?: string;
		input_cache_write?: string;
	};
}

function assertImageModelIntegrity(model: ImagesModel<"openrouter-images">, index: number): void {
	if (typeof model.id !== "string" || model.id.length === 0) throw new Error(`Image model[${index}] has invalid id`);
	if (typeof model.name !== "string" || model.name.length === 0) {
		throw new Error(`Image model ${model.id} has invalid name`);
	}
	for (const [field, value] of Object.entries(model.cost)) {
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
			throw new Error(`Image model ${model.id} has invalid cost.${field}`);
		}
	}
	if (!model.output.includes("image") || model.input.length === 0) {
		throw new Error(`Image model ${model.id} has invalid modalities`);
	}
}

async function fetchOpenRouterImageModels(): Promise<ImagesModel<"openrouter-images">[]> {
	console.log("Fetching image models from OpenRouter API...");
	const data = await fetchRequiredJson<{ data?: OpenRouterModelRecord[] }>({
		label: "OpenRouter image model",
		url: OPENROUTER_IMAGE_MODELS_URL,
	});
	if (!Array.isArray(data.data)) throw new Error("Required OpenRouter image catalog has no data array");
	const models: ImagesModel<"openrouter-images">[] = [];

	for (const model of data.data) {
			const input = Array.from(
				new Set(
					(model.architecture?.input_modalities ?? [])
						.filter((modality): modality is "text" | "image" => modality === "text" || modality === "image"),
				),
			);
			const output = Array.from(
				new Set(
					(model.architecture?.output_modalities ?? []).filter(
						(modality): modality is "text" | "image" => modality === "text" || modality === "image",
					),
				),
			);

		if (!output.includes("image")) continue;
		if (input.length === 0) input.push("text");
		const inputCost = parseFloat(model.pricing?.prompt || "0") * 1_000_000;
		const outputCost = parseFloat(model.pricing?.completion || "0") * 1_000_000;
		// OpenRouter's auto router reports -1 for variable downstream pricing.
		// Normalize only that documented sentinel; every other negative or invalid
		// price remains an integrity error for the required image catalog.
		const isAutoRouter = model.id === "openrouter/auto" || model.id.startsWith("openrouter/auto-");
		const variableRouterCost = isAutoRouter && inputCost === -1_000_000 && outputCost === -1_000_000;

		models.push({
			id: model.id,
			name: model.name,
			api: "openrouter-images",
			provider: "openrouter",
			baseUrl: OPENROUTER_BASE_URL,
			input,
			output,
			cost: {
				input: variableRouterCost ? 0 : inputCost,
				output: variableRouterCost ? 0 : outputCost,
				cacheRead: parseFloat(model.pricing?.input_cache_read || "0") * 1_000_000,
				cacheWrite: parseFloat(model.pricing?.input_cache_write || "0") * 1_000_000,
			},
			...(variableRouterCost ? { variablePricing: true } : {}),
		});
	}

	for (const [index, model] of models.entries()) assertImageModelIntegrity(model, index);
	assertMinimumCatalogSize(
		"OpenRouter unique image model",
		new Set(models.map((model) => model.id)).size,
		MIN_OPENROUTER_IMAGE_MODELS,
	);
	console.log(`Fetched ${models.length} image models from OpenRouter`);
	return models;
}

function generateImageModelsFile(models: ImagesModel<"openrouter-images">[]): string {
	const imageModelsByProvider = {
		openrouter: Object.fromEntries(
			models
				.sort((a, b) => a.id.localeCompare(b.id))
				.map((model) => [
					model.id,
					`{
			id: ${JSON.stringify(model.id)},
			name: ${JSON.stringify(model.name)},
			api: ${JSON.stringify(model.api)},
			provider: ${JSON.stringify(model.provider)},
			baseUrl: ${JSON.stringify(model.baseUrl)},
			input: ${JSON.stringify(model.input)},
			output: ${JSON.stringify(model.output)},
			${model.variablePricing ? "variablePricing: true,\n\t\t\t" : ""}cost: ${JSON.stringify(model.cost, null, 2).replace(/^/gm, "\t")}
		} satisfies ImagesModel<${JSON.stringify(model.api)}>`,
				]),
		),
	};

	const providerEntries = Object.entries(imageModelsByProvider)
		.map(([provider, providerModels]) => {
			const modelEntries = Object.entries(providerModels)
				.map(([id, serialized]) => `\t\t${JSON.stringify(id)}: ${serialized},`)
				.join("\n");
			return `\t${JSON.stringify(provider)}: {\n${modelEntries}\n\t},`;
		})
		.join("\n");

	return `// This file is auto-generated by scripts/generate-image-models.ts
// Do not edit manually - run 'npm run generate-image-models' to update

import type { ImagesApi, ImagesModel } from "./types.ts";

export const IMAGE_MODELS = {
${providerEntries}
} as const satisfies Record<string, Record<string, ImagesModel<ImagesApi>>>;
`;
}

async function main(): Promise<void> {
	const models = await fetchOpenRouterImageModels();
	const output = generateImageModelsFile(models);
	const outputPath = join(packageRoot, "src", "image-models.generated.ts");
	writeGeneratedFilesAtomically([{ path: outputPath, content: output }]);
	console.log(`Generated ${outputPath}`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
