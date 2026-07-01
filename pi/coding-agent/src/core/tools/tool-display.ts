import { visibleWidth } from "@earendil-works/pi-tui";

export interface ToolDisplayCall {
	name: string;
	args?: unknown;
}

export function resolveDisplayToolName(name: string): string {
	switch (name) {
		case "communicate":
			return "swarm";
		case "task":
		case "task_runner":
			return "subagent";
		case "shell_exec":
			return "bash";
		case "file_read":
			return "read";
		case "file_write":
			return "write";
		case "file_edit":
			return "edit";
		case "file_glob":
			return "glob";
		case "file_grep":
			return "grep";
		case "todo_read":
		case "todo_write":
		case "todoread":
		case "todowrite":
			return "todo";
		default:
			return name;
	}
}

export function canonicalToolName(name: string): string {
	switch (name) {
		case "communicate":
			return "swarm";
		case "Write":
			return "write";
		case "Edit":
			return "edit";
		case "MultiEdit":
			return "multiedit";
		case "Patch":
			return "patch";
		case "ApplyPatch":
			return "apply_patch";
		default:
			return name;
	}
}

export function isEditToolName(name: string): boolean {
	return ["write", "edit", "multiedit", "patch", "apply_patch"].includes(
		canonicalToolName(resolveDisplayToolName(name)),
	);
}

function prefixByWidth(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	let used = 0;
	let out = "";
	for (const char of text) {
		const width = visibleWidth(char);
		if (used + width > maxWidth) break;
		out += char;
		used += width;
	}
	return out;
}

function suffixByWidth(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	let used = 0;
	let out = "";
	const chars = Array.from(text);
	for (let index = chars.length - 1; index >= 0; index--) {
		const char = chars[index]!;
		const width = visibleWidth(char);
		if (used + width > maxWidth) break;
		out = char + out;
		used += width;
	}
	return out;
}

export function truncateMiddleDisplay(text: string, maxWidth: number): string {
	if (visibleWidth(text) <= maxWidth) return text;
	if (maxWidth <= 0) return "";
	if (maxWidth === 1) return ".";
	const remaining = maxWidth - 1;
	const head = Math.ceil(remaining / 2);
	const tail = Math.floor(remaining / 2);
	return `${prefixByWidth(text, head)}.${suffixByWidth(text, tail)}`;
}

function normalizeBacktickedIdentifier(text: string): string {
	return text.replaceAll("`", "").trim();
}

function parseNonzeroExitCodeLine(line: string): number | undefined {
	const trimmed = line.trim();
	const parse = (value: string) => {
		const code = Number.parseInt(value.trim().replace(/-+$/, "").trim(), 10);
		return Number.isFinite(code) && code !== 0 ? code : undefined;
	};
	if (trimmed.startsWith("Exit code:")) {
		return parse(trimmed.slice("Exit code:".length));
	}
	if (trimmed.startsWith("--- Command finished with exit code:")) {
		return parse(trimmed.slice("--- Command finished with exit code:".length));
	}
	return undefined;
}

export function conciseToolErrorSummary(content: string): string | undefined {
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;

		const detail = ["Error:", "error:", "Failed:"]
			.map((prefix) => (line.startsWith(prefix) ? line.slice(prefix.length).trim() : undefined))
			.find((value) => value !== undefined);
		if (detail !== undefined) {
			const missingField = detail.startsWith("missing field ") ? detail.slice("missing field ".length) : undefined;
			if (missingField) return `invalid input: missing ${normalizeBacktickedIdentifier(missingField)}`;
			if (detail.startsWith("invalid type") || detail.startsWith("unknown variant")) {
				return `invalid input: ${detail}`;
			}
			if (detail.includes("source metadata") && detail.includes("was for")) {
				return "build source changed before reload";
			}
			if (detail.startsWith("Refusing to publish")) {
				return "reload refused: rebuild against current source";
			}
			return `error: ${truncateMiddleDisplay(detail, 80)}`;
		}

		if (line.includes("Compile terminated by signal")) return line;
		const exitCode = parseNonzeroExitCodeLine(line);
		if (exitCode !== undefined) return `exit ${exitCode}`;
	}
	return undefined;
}

export function toolOutputLooksFailed(content: string): boolean {
	const trimmed = content.trim();
	if (!trimmed) return false;
	const lower = trimmed.toLowerCase();
	if (conciseToolErrorSummary(trimmed) || lower.startsWith("error:") || lower.startsWith("failed:")) {
		return true;
	}
	return trimmed.split(/\r?\n/).some((rawLine) => {
		const line = rawLine.trim();
		return (
			parseNonzeroExitCodeLine(line) !== undefined ||
			line.toLowerCase() === "status: failed" ||
			line.toLowerCase() === "failed to start" ||
			line.toLowerCase() === "terminated"
		);
	});
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function stringField(args: Record<string, unknown>, ...names: string[]): string | undefined {
	for (const name of names) {
		const value = args[name];
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
}

function arrayField(args: Record<string, unknown>, name: string): unknown[] | undefined {
	const value = args[name];
	return Array.isArray(value) ? value : undefined;
}

function summarizePatchText(patchText: string): string {
	const files: string[] = [];
	for (const rawLine of patchText.split(/\r?\n/)) {
		const line = rawLine.trim();
		const path = line.startsWith("*** Add File: ")
			? line.slice("*** Add File: ".length).trim()
			: line.startsWith("*** Update File: ")
				? line.slice("*** Update File: ".length).trim()
				: line.startsWith("*** Delete File: ")
					? line.slice("*** Delete File: ".length).trim()
					: undefined;
		if (path && !files.includes(path)) files.push(path);
	}
	const lineCount = patchText.split(/\r?\n/).length;
	if (files.length === 1) return `${files[0]} (${lineCount} lines)`;
	if (files.length > 1) return `${files.length} files (${lineCount} lines)`;
	return `(${lineCount} lines)`;
}

function truncateEnd(text: string, maxWidth: number): string {
	if (visibleWidth(text) <= maxWidth) return text;
	if (maxWidth <= 0) return "";
	if (maxWidth <= 1) return ".";
	return `${prefixByWidth(text, maxWidth - 1)}.`;
}

function summarizeCommand(command: string, maxWidth: number): string {
	if (visibleWidth(command) <= maxWidth) return command;
	const tokens = command.split(/\s+/).filter(Boolean);
	if (tokens.length >= 3) {
		const candidates = [
			`${tokens[0]} ${tokens[1]} ... ${tokens[tokens.length - 2]} ${tokens[tokens.length - 1]}`,
			`${tokens[0]} ${tokens[1]} ... ${tokens[tokens.length - 1]}`,
			`${tokens[0]} ... ${tokens[tokens.length - 1]}`,
		];
		const candidate = candidates.find((value) => visibleWidth(value) <= maxWidth);
		if (candidate) return candidate;
	}
	return truncateMiddleDisplay(command, maxWidth);
}

function summarizePath(path: string, maxWidth: number): string {
	if (visibleWidth(path) <= maxWidth) return path;
	const normalized = path.replaceAll("\\", "/");
	const parts = normalized.split("/").filter(Boolean);
	if (parts.length === 0) return truncateMiddleDisplay(path, maxWidth);
	const marker = normalized.startsWith("~/")
		? "~/.../"
		: normalized.startsWith("./")
			? "./.../"
			: normalized.startsWith("/")
				? "/.../"
				: ".../";
	let joined = "";
	for (let index = parts.length - 1; index >= 0; index--) {
		const candidate = joined ? `${parts[index]}/${joined}` : parts[index]!;
		if (visibleWidth(marker) + visibleWidth(candidate) > maxWidth) break;
		joined = candidate;
	}
	if (joined) return `${marker}${joined}`;
	const last = parts[parts.length - 1]!;
	const suffixBudget = maxWidth - visibleWidth(".../");
	return suffixBudget > 0 ? `.../${truncateMiddleDisplay(last, suffixBudget)}` : truncateMiddleDisplay(path, maxWidth);
}

export function summarizeToolCall(call: ToolDisplayCall, maxWidth = 50): string {
	const args = asRecord(call.args);
	switch (canonicalToolName(resolveDisplayToolName(call.name))) {
		case "bash": {
			const command = stringField(args, "command");
			return command ? `$ ${summarizeCommand(command, Math.max(1, maxWidth - 2))}` : "";
		}
		case "read": {
			const path = stringField(args, "file_path", "path");
			if (!path) return "";
			const startLine = typeof args.start_line === "number" ? args.start_line : undefined;
			const endLine = typeof args.end_line === "number" ? args.end_line : undefined;
			const suffix =
				startLine !== undefined && endLine !== undefined
					? `:${startLine}-${endLine}`
					: startLine !== undefined
						? `:${startLine}-`
						: "";
			return summarizePath(`${path}${suffix}`, maxWidth);
		}
		case "write":
		case "edit": {
			const path = stringField(args, "file_path", "path");
			return path ? summarizePath(path, maxWidth) : "";
		}
		case "multiedit": {
			const path = stringField(args, "file_path", "path") ?? "";
			const count = arrayField(args, "edits")?.length ?? 0;
			return truncateEnd(`${path} (${count} edits)`, maxWidth);
		}
		case "glob": {
			const pattern = stringField(args, "pattern");
			return pattern ? `'${truncateMiddleDisplay(pattern, Math.max(1, maxWidth - 2))}'` : "";
		}
		case "grep": {
			const pattern = stringField(args, "pattern", "query") ?? "";
			const path = stringField(args, "path");
			const summary = path ? `'${pattern}' in ${path}` : `'${pattern}'`;
			return truncateEnd(summary, maxWidth);
		}
		case "apply_patch":
		case "patch": {
			const patch = stringField(args, "patch_text", "patch");
			return patch ? truncateEnd(summarizePatchText(patch), maxWidth) : "";
		}
		case "todo": {
			const todos = arrayField(args, "todos");
			return todos ? `${todos.length} items` : "todos";
		}
		case "memory": {
			const action = stringField(args, "action") ?? "memory";
			const content = stringField(args, "content", "query", "id");
			return content ? truncateEnd(`${action} ${content}`, maxWidth) : action;
		}
		case "subagent": {
			const description = stringField(args, "description") ?? "task";
			const agentType = stringField(args, "subagent_type") ?? "agent";
			return truncateEnd(`${description} (${agentType})`, maxWidth);
		}
		default: {
			const firstString = Object.values(args).find(
				(value): value is string => typeof value === "string" && value.trim() !== "",
			);
			return firstString ? truncateEnd(firstString, maxWidth) : "";
		}
	}
}
