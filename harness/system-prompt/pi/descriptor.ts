import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { parseToml, type TomlTable, type TomlValue } from "../../hcp/registry/registry.ts";
import type { SystemPromptDescriptor, SystemPromptDescriptorDiagnostic } from "../contract.ts";

export type {
	SystemPromptDescriptor,
	SystemPromptDescriptorDiagnostic,
	SystemPromptDescriptorDiagnosticCode,
} from "../contract.ts";

export async function loadSystemPromptDescriptor(
	descriptorPath: string,
): Promise<{ descriptor?: SystemPromptDescriptor; diagnostics: SystemPromptDescriptorDiagnostic[] }> {
	const resolvedDescriptorPath = resolve(descriptorPath);
	const diagnostics: SystemPromptDescriptorDiagnostic[] = [];
	let raw: TomlTable;
	try {
		raw = parseToml(await readFile(resolvedDescriptorPath, "utf-8"));
	} catch (error) {
		return {
			diagnostics: [
				{
					type: "error",
					code: "system_prompt_descriptor_read_failed",
					message: `Unable to read system prompt descriptor ${resolvedDescriptorPath}: ${formatUnknownError(error)}`,
					path: resolvedDescriptorPath,
				},
			],
		};
	}

	const kind = asString(raw.kind);
	if (kind !== "system-prompt" && kind !== "append-system-prompt") {
		diagnostics.push({
			type: "error",
			code: "system_prompt_descriptor_invalid",
			message: `System prompt descriptor must declare kind = "system-prompt" or "append-system-prompt".`,
			path: resolvedDescriptorPath,
		});
	}

	const contentRef = asString(raw.content_path) ?? asString(raw.prompt_path);
	const contentPath = contentRef
		? resolveDescriptorLocalReference(contentRef, resolvedDescriptorPath, diagnostics)
		: undefined;

	return {
		descriptor:
			kind === "system-prompt" || kind === "append-system-prompt"
				? {
						kind,
						name: asString(raw.name) ?? kind,
						description: asString(raw.description),
						source: asString(raw.source),
						contentPath,
						descriptorPath: resolvedDescriptorPath,
						raw,
					}
				: undefined,
		diagnostics,
	};
}

function resolveDescriptorLocalReference(
	reference: string,
	descriptorPath: string,
	diagnostics: SystemPromptDescriptorDiagnostic[],
): string | undefined {
	if (isAbsolute(reference)) {
		diagnostics.push({
			type: "error",
			code: "system_prompt_descriptor_invalid",
			message: `System prompt content reference must be descriptor-local, not absolute: ${reference}`,
			path: descriptorPath,
		});
		return undefined;
	}
	const descriptorDir = dirname(descriptorPath);
	const resolvedPath = resolve(descriptorDir, reference);
	if (!isWithinDir(descriptorDir, resolvedPath)) {
		diagnostics.push({
			type: "error",
			code: "system_prompt_descriptor_invalid",
			message: `System prompt content reference escapes descriptor directory: ${reference}`,
			path: descriptorPath,
		});
		return undefined;
	}
	return resolvedPath;
}

function isWithinDir(parentDir: string, childPath: string): boolean {
	const rel = relative(parentDir, childPath);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function asString(value: TomlValue | undefined): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function formatUnknownError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
