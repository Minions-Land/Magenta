import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function listen(handler: RequestListener): Promise<{ server: Server; baseUrl: string }> {
	const server = createServer(handler);
	servers.push(server);
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("fixture server did not bind a TCP port");
	return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

function runGenerator(
	script: string,
	env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((done, reject) => {
		const child = spawn(process.execPath, [script], {
			cwd: resolve(import.meta.dirname, ".."),
			env: { ...process.env, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("exit", (code) => done({ code, stdout, stderr }));
	});
}

function makeGenerationRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "magenta-model-generation-"));
	roots.push(root);
	mkdirSync(join(root, "src", "providers"), { recursive: true });
	return root;
}

function json(response: import("node:http").ServerResponse, value: unknown, status = 200): void {
	response.statusCode = status;
	response.setHeader("content-type", "application/json");
	response.end(JSON.stringify(value));
}

describe("model generation scripts", () => {
	it("exits non-zero and leaves old catalogs untouched when a required source fails", async () => {
		const root = makeGenerationRoot();
		const aggregate = join(root, "src", "models.generated.ts");
		const catalog = join(root, "src", "providers", "sentinel.models.ts");
		writeFileSync(aggregate, "stable aggregate\n");
		writeFileSync(catalog, "stable catalog\n");
		const { baseUrl } = await listen((_request, response) => json(response, { error: "down" }, 503));

		const result = await runGenerator(resolve(import.meta.dirname, "../scripts/generate-models.ts"), {
			PI_AI_GENERATION_ROOT: root,
			PI_MODELS_DEV_CATALOG_URL: `${baseUrl}/models-dev`,
		});

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("HTTP 503");
		expect(readFileSync(aggregate, "utf8")).toBe("stable aggregate\n");
		expect(readFileSync(catalog, "utf8")).toBe("stable catalog\n");
	});

	it.each([
		["OpenRouter", "/openrouter"],
		["Vercel AI Gateway", "/gateway/models"],
	])("leaves old catalogs untouched when required %s fails", async (_label, failedPath) => {
		const root = makeGenerationRoot();
		const aggregate = join(root, "src", "models.generated.ts");
		const nvidiaCatalog = join(root, "src", "providers", "nvidia.models.ts");
		writeFileSync(aggregate, "stable aggregate\n");
		writeFileSync(nvidiaCatalog, 'export const NVIDIA_MODELS = { "stable": {} } as const;\n');
		const modelRecord = {
			tool_call: true,
			reasoning: false,
			modalities: { input: ["text"], output: ["text"] },
			limit: { context: 8192, output: 1024 },
			cost: { input: 1, output: 2, cache_read: 0, cache_write: 0 },
		};
		const openAiModels = Object.fromEntries(
			Array.from({ length: 300 }, (_, index) => [`fixture-${index}`, { ...modelRecord, name: `Fixture ${index}` }]),
		);
		const openRouterModels = Array.from({ length: 100 }, (_, index) => ({
			id: `fixture/openrouter-${index}`,
			name: `OpenRouter ${index}`,
			supported_parameters: ["tools"],
			architecture: { modality: "text" },
			pricing: { prompt: "0.000001", completion: "0.000002" },
			context_length: 8192,
			top_provider: { max_completion_tokens: 1024 },
		}));
		const gatewayModels = Array.from({ length: 50 }, (_, index) => ({
			id: `gateway-${index}`,
			name: `Gateway ${index}`,
			tags: ["tool-use"],
			context_window: 8192,
			max_tokens: 1024,
			pricing: { input: 0.000001, output: 0.000002 },
		}));
		const { baseUrl } = await listen((request, response) => {
			if (request.url === failedPath) {
				json(response, { error: "required endpoint down" }, 503);
				return;
			}
			switch (request.url) {
				case "/models-dev":
					json(response, {
						openai: { models: openAiModels },
						nvidia: { models: { "fixture/nvidia": modelRecord } },
					});
					break;
				case "/nvidia":
					json(response, { error: "optional endpoint down" }, 503);
					break;
				case "/openrouter":
					json(response, { data: openRouterModels });
					break;
				case "/gateway/models":
					json(response, { data: gatewayModels });
					break;
				default:
					json(response, { error: "not found" }, 404);
			}
		});

		const result = await runGenerator(resolve(import.meta.dirname, "../scripts/generate-models.ts"), {
			PI_AI_GENERATION_ROOT: root,
			PI_MODELS_DEV_CATALOG_URL: `${baseUrl}/models-dev`,
			PI_NVIDIA_MODELS_CATALOG_URL: `${baseUrl}/nvidia`,
			PI_OPENROUTER_MODELS_CATALOG_URL: `${baseUrl}/openrouter`,
			PI_AI_GATEWAY_MODELS_URL: `${baseUrl}/gateway`,
		});

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("HTTP 503");
		expect(readFileSync(aggregate, "utf8")).toBe("stable aggregate\n");
		expect(readFileSync(nvidiaCatalog, "utf8")).toBe('export const NVIDIA_MODELS = { "stable": {} } as const;\n');
	});

	it("preserves the checked-in NVIDIA catalog when optional live validation is unavailable", async () => {
		const root = makeGenerationRoot();
		const nvidiaCatalog = join(root, "src", "providers", "nvidia.models.ts");
		writeFileSync(nvidiaCatalog, 'export const NVIDIA_MODELS = { "preserved/model": {} } as const;\n');
		const modelRecord = {
			tool_call: true,
			reasoning: false,
			modalities: { input: ["text"], output: ["text"] },
			limit: { context: 8192, output: 1024 },
			cost: { input: 1, output: 2, cache_read: 0, cache_write: 0 },
		};
		const openAiModels = Object.fromEntries(
			Array.from({ length: 300 }, (_, index) => [`fixture-${index}`, { ...modelRecord, name: `Fixture ${index}` }]),
		);
		const openRouterModels = Array.from({ length: 100 }, (_, index) => ({
			id: `fixture/openrouter-${index}`,
			name: `OpenRouter ${index}`,
			supported_parameters: ["tools"],
			architecture: { modality: "text" },
			pricing: { prompt: "0.000001", completion: "0.000002" },
			context_length: 8192,
			top_provider: { max_completion_tokens: 1024 },
		}));
		openRouterModels[0] = {
			...openRouterModels[0],
			id: "openrouter/auto",
			name: "Auto Router",
			pricing: { prompt: "-1", completion: "-1" },
		};
		openRouterModels[1] = {
			...openRouterModels[1],
			id: "openrouter/auto-beta",
			name: "Auto Router (Beta)",
			pricing: { prompt: "-1", completion: "-1" },
		};
		const gatewayModels = Array.from({ length: 50 }, (_, index) => ({
			id: `gateway-${index}`,
			name: `Gateway ${index}`,
			tags: ["tool-use"],
			context_window: 8192,
			max_tokens: 1024,
			pricing: { input: 0.000001, output: 0.000002 },
		}));
		const { baseUrl } = await listen((request, response) => {
			switch (request.url) {
				case "/models-dev":
					json(response, {
						openai: { models: openAiModels },
						nvidia: { models: { "fixture/nvidia": modelRecord } },
					});
					break;
				case "/nvidia":
					json(response, { error: "optional endpoint down" }, 503);
					break;
				case "/openrouter":
					json(response, { data: openRouterModels });
					break;
				case "/gateway/models":
					json(response, { data: gatewayModels });
					break;
				default:
					json(response, { error: "not found" }, 404);
			}
		});
		const before = readFileSync(nvidiaCatalog, "utf8");

		const result = await runGenerator(resolve(import.meta.dirname, "../scripts/generate-models.ts"), {
			PI_AI_GENERATION_ROOT: root,
			PI_MODELS_DEV_CATALOG_URL: `${baseUrl}/models-dev`,
			PI_NVIDIA_MODELS_CATALOG_URL: `${baseUrl}/nvidia`,
			PI_OPENROUTER_MODELS_CATALOG_URL: `${baseUrl}/openrouter`,
			PI_AI_GATEWAY_MODELS_URL: `${baseUrl}/gateway`,
		});

		expect(result.code, result.stderr).toBe(0);
		expect(result.stderr).toContain("preserving the existing generated NVIDIA catalog");
		expect(readFileSync(nvidiaCatalog, "utf8")).toBe(before);
		expect(readFileSync(join(root, "src", "models.generated.ts"), "utf8")).toContain("NVIDIA_MODELS");
		const openRouterCatalog = readFileSync(join(root, "src", "providers", "openrouter.models.ts"), "utf8");
		expect(openRouterCatalog).toContain('"openrouter/auto"');
		expect(openRouterCatalog).toContain('"openrouter/auto-beta"');
		expect(openRouterCatalog).toContain("input: 0,");
		expect(openRouterCatalog).toContain("variablePricing: true,");
		expect(openRouterCatalog).toMatch(
			/"openrouter\/auto-beta": \{[\s\S]*?variablePricing: true,[\s\S]*?\n\t+input: 0,/,
		);
		expect(openRouterCatalog).toMatch(/"auto": \{[\s\S]*?variablePricing: true,[\s\S]*?\n\t\tinput:/);
		expect(openRouterCatalog).toMatch(/"openrouter\/fusion": \{[\s\S]*?variablePricing: true,[\s\S]*?\n\t\tinput:/);
		expect(openRouterCatalog).not.toContain("input: -1000000,");
	});

	it("rejects invalid image pricing without replacing the existing image catalog", async () => {
		const root = makeGenerationRoot();
		const imageCatalog = join(root, "src", "image-models.generated.ts");
		writeFileSync(imageCatalog, "stable image catalog\n");
		const models = Array.from({ length: 5 }, (_, index) => ({
			id: index === 0 ? "openrouter/auto-beta" : `image-${index}`,
			name: `Image ${index}`,
			architecture: { input_modalities: ["text"], output_modalities: ["image"] },
			pricing: {
				prompt: index === 0 ? "-1" : index === 4 ? "not-a-number" : "0.000001",
				completion: index === 0 ? "-1" : "0.000002",
			},
		}));
		const { baseUrl } = await listen((_request, response) => json(response, { data: models }));

		const result = await runGenerator(resolve(import.meta.dirname, "../scripts/generate-image-models.ts"), {
			PI_AI_GENERATION_ROOT: root,
			PI_OPENROUTER_IMAGE_MODELS_URL: `${baseUrl}/images`,
		});

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("Image model image-4 has invalid cost.input");
		expect(readFileSync(imageCatalog, "utf8")).toBe("stable image catalog\n");
	});
});
