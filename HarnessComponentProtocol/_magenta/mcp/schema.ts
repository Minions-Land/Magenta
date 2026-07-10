import { type TSchema, Type } from "typebox";
import type { TomlTable, TomlValue } from "../utils/pi/toml.ts";

export type JsonSchema = TSchema & Record<string, unknown>;

export function parametersFromToml(value: TomlValue | undefined): JsonSchema {
	if (!isTable(value)) return Type.Object({}) as unknown as JsonSchema;
	return normalizeSchema(value) as JsonSchema;
}

function normalizeSchema(value: TomlValue): unknown {
	if (Array.isArray(value)) return value.map((item) => normalizeSchema(item));
	if (!isTable(value)) return value;

	const schema: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		if (key === "properties" && isTable(child)) {
			schema.properties = normalizeProperties(child);
			continue;
		}
		if ((key === "items" || key === "additionalProperties") && isTable(child)) {
			schema[key] = normalizeSchema(child);
			continue;
		}
		schema[key] = normalizeSchema(child);
	}

	return schema;
}

function normalizeProperties(properties: TomlTable): Record<string, unknown> {
	const normalized: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(properties)) {
		normalized[name] = normalizeSchema(value);
	}
	return normalized;
}

function isTable(value: TomlValue | undefined): value is TomlTable {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
