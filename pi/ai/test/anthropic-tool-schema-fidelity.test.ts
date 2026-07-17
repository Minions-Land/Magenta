import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import type { Context, Model, Tool } from "../src/types.ts";

interface AnthropicPayload {
	tools?: Array<{ name: string; input_schema: Record<string, unknown> }>;
}

const model: Model<"anthropic-messages"> = {
	id: "claude-test",
	name: "Claude Test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://example.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 4096,
};

async function captureToolSchema(tool: Tool): Promise<Record<string, unknown>> {
	let payload: AnthropicPayload | undefined;
	const context: Context = {
		messages: [{ role: "user", content: "Use the tool", timestamp: Date.now() }],
		tools: [tool],
	};
	await streamAnthropic(model, context, {
		apiKey: "test-key",
		onPayload: (value) => {
			payload = value as AnthropicPayload;
			throw new Error("payload captured");
		},
	}).result();
	const schema = payload?.tools?.[0]?.input_schema;
	if (!schema) throw new Error("Expected an Anthropic tool schema");
	return schema;
}

describe("Anthropic tool schema fidelity", () => {
	it("preserves canonical root and nested JSON Schema keywords", async () => {
		const parameters = {
			anyOf: [
				{
					type: "object",
					properties: {
						request: {
							type: "object",
							additionalProperties: false,
							minProperties: 1,
							properties: {
								mode: { anyOf: [{ const: "fast" }, { const: "safe" }] },
								items: { type: "array", items: { $ref: "#/$defs/item" }, minItems: 1 },
							},
						},
					},
					required: ["request"],
				},
				{ $ref: "#/$defs/fallback" },
			],
			additionalProperties: false,
			minProperties: 1,
			$defs: {
				item: { type: "string", minLength: 1 },
				fallback: { type: "object", properties: { raw: { type: "string" } }, required: ["raw"] },
			},
		};

		const schema = await captureToolSchema({
			name: "schema_probe",
			description: "Probe schema projection",
			parameters: parameters as Tool["parameters"],
		});

		expect(schema).toEqual(parameters);
	});

	it("removes TypeBox symbol metadata without flattening nested structure", async () => {
		const parameters = Type.Object(
			{
				nested: Type.Object({ value: Type.String({ minLength: 2 }) }, { additionalProperties: false }),
			},
			{ additionalProperties: false, minProperties: 1 },
		);

		const schema = await captureToolSchema({
			name: "typebox_probe",
			description: "Probe TypeBox projection",
			parameters,
		});

		expect(schema).toEqual({
			type: "object",
			properties: {
				nested: {
					type: "object",
					properties: { value: { type: "string", minLength: 2 } },
					required: ["value"],
					additionalProperties: false,
				},
			},
			required: ["nested"],
			additionalProperties: false,
			minProperties: 1,
		});
		expect(Object.getOwnPropertySymbols(schema)).toHaveLength(0);
	});
});
