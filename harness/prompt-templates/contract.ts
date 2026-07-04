import type { ExecutionEnv, PromptTemplate } from "../types/types.ts";

export type PromptTemplateDiagnosticCode = "file_info_failed" | "list_failed" | "read_failed" | "parse_failed";

/** Warning produced while loading prompt templates. */
export interface PromptTemplateDiagnostic {
	/** Diagnostic severity. Currently only warnings are emitted. */
	type: "warning";
	/** Stable diagnostic code. */
	code: PromptTemplateDiagnosticCode;
	/** Human-readable diagnostic message. */
	message: string;
	/** Path associated with the diagnostic. */
	path: string;
}

export interface PromptTemplateProviderContract {
	load(
		env: ExecutionEnv,
		paths: string | string[],
	): Promise<{ promptTemplates: PromptTemplate[]; diagnostics: PromptTemplateDiagnostic[] }>;
	loadSourced<TSource, TPromptTemplate extends PromptTemplate = PromptTemplate>(
		env: ExecutionEnv,
		inputs: Array<{ path: string; source: TSource }>,
		mapPromptTemplate?: (promptTemplate: PromptTemplate, source: TSource) => TPromptTemplate,
	): Promise<{
		promptTemplates: Array<{ promptTemplate: TPromptTemplate; source: TSource }>;
		diagnostics: Array<PromptTemplateDiagnostic & { source: TSource }>;
	}>;
	parseCommandArgs(argsString: string): string[];
	substituteArgs(content: string, args: string[]): string;
	formatPromptTemplateInvocation(template: PromptTemplate, args?: string[]): string;
	expandPromptTemplate(text: string, templates: PromptTemplate[]): string;
}

/** Parse an argument string using simple shell-style single and double quotes. */
export function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	let inQuote: string | null = null;

	for (let i = 0; i < argsString.length; i++) {
		const char = argsString[i]!;
		if (inQuote) {
			if (char === inQuote) inQuote = null;
			else current += char;
		} else if (char === '"' || char === "'") {
			inQuote = char;
		} else if (/\s/.test(char)) {
			if (current) {
				args.push(current);
				current = "";
			}
		} else {
			current += char;
		}
	}
	if (current) args.push(current);
	return args;
}

/**
 * Substitute argument placeholders in template content. Supports:
 * - `$1`, `$2`, ... positional args
 * - `$@` and `$ARGUMENTS` for all args
 * - `${N:-default}` positional arg N with default when missing/empty
 * - `${@:N}` args from Nth onwards (bash-style slicing)
 * - `${@:N:L}` L args starting from Nth
 *
 * Replacement happens on the template string only; argument/default values are not recursively substituted.
 */
export function substituteArgs(content: string, args: string[]): string {
	const allArgs = args.join(" ");
	return content.replace(
		/\$\{(\d+):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
		(_match, defaultNum, defaultValue, sliceStart, sliceLength, simple) => {
			if (defaultNum) {
				const value = args[parseInt(defaultNum, 10) - 1];
				return value ? value : defaultValue;
			}
			if (sliceStart) {
				let start = parseInt(sliceStart, 10) - 1;
				if (start < 0) start = 0;
				if (sliceLength) return args.slice(start, start + parseInt(sliceLength, 10)).join(" ");
				return args.slice(start).join(" ");
			}
			if (simple === "ARGUMENTS" || simple === "@") return allArgs;
			return args[parseInt(simple, 10) - 1] ?? "";
		},
	);
}

/** Format a prompt template invocation with positional arguments. */
export function formatPromptTemplateInvocation(template: PromptTemplate, args: string[] = []): string {
	return substituteArgs(template.content, args);
}

/**
 * Expand a `/name args...` invocation against a set of templates.
 * Returns the substituted template content, or the original text when it is not a template invocation.
 */
export function expandPromptTemplate(text: string, templates: PromptTemplate[]): string {
	if (!text.startsWith("/")) return text;
	const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
	if (!match) return text;
	const templateName = match[1];
	const argsString = match[2] ?? "";
	const template = templates.find((t) => t.name === templateName);
	if (template) return substituteArgs(template.content, parseCommandArgs(argsString));
	return text;
}
