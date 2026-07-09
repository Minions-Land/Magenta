import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { HcpRequest, HcpServer, HcpServerDescription } from "../../../hcp-client/contract/hcp-server.ts";
import type { ContextProvider as IContextProvider } from "../contract.ts";

const CONTEXT_TARGETS = ["context://workspace", "context://project"] as const;
const MAX_IMPORT_DEPTH = 5;

export interface ContextFile {
	path: string;
	provider: string;
	sticky: boolean;
	priority: number;
	content: string;
}

export interface ContextProviderOptions {
	workspaceRoot?: string;
}

function targetName(target: string): string {
	if (target.startsWith("context://")) return target.slice("context://".length);
	const index = target.indexOf(":");
	return index === -1 ? target : target.slice(index + 1).replace(/^\/\//, "");
}

async function fileExists(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

function isWithinOrEqual(path: string, root: string): boolean {
	return path === root || path.startsWith(`${root}/`);
}

function modelSafeText(raw: string): string {
	const replacements: Array<[RegExp, string]> = [
		[/\bHCP-backed\b/g, "available"],
		[/\bHCP\b/g, "system"],
		[/\bHarness\b/g, "system"],
		[/\bharness\b/g, "system"],
		[/\bprovider\b/g, "system"],
		[/\bProvider\b/g, "system"],
		[/\bruntime\b/g, "system"],
		[/\bRuntime\b/g, "system"],
		[/\btarget\b/g, "destination"],
		[/\bTarget\b/g, "Destination"],
		[/\boptional\b/g, "extra"],
		[/\bOptional\b/g, "Extra"],
		[/\bscoped\b/g, "bounded"],
		[/\bScoped\b/g, "Bounded"],
		[/\bscope\b/g, "boundary"],
		[/\bScope\b/g, "Boundary"],
		[/\borchestration loop\b/g, "workflow"],
		[/\borchestration\b/g, "coordination"],
		[/\bOrchestration\b/g, "coordination"],
		[/\bLoop\b/g, "workflow"],
		[/\bloop\b/g, "workflow"],
	];
	let result = raw;
	for (const [pattern, replacement] of replacements) {
		result = result.replace(pattern, replacement);
	}
	return result
		.replaceAll("recipe://", "recipe ")
		.replaceAll("tool://", "tool ")
		.replaceAll("api://", "API ")
		.replaceAll("mcp://", "tool ")
		.replaceAll("loop://", "workflow ")
		.replaceAll("event://", "event ")
		.replaceAll("scaffold://", "scaffold ")
		.replaceAll("://", " ")
		.split(/\s+/)
		.filter(Boolean)
		.join(" ");
}

async function normalizeRoot(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch {
		return resolve(path);
	}
}

async function normalizeImportPath(base: string, raw: string, workspaceRoot: string): Promise<string> {
	const path = raw.startsWith("~/")
		? join(process.env.HOME ?? workspaceRoot, raw.slice(2))
		: isAbsolute(raw)
			? raw
			: join(base, raw);
	return realpath(path);
}

async function expandImports(
	source: string,
	content: string,
	workspaceRoot: string,
	depth: number,
	seen: Set<string>,
): Promise<string> {
	if (depth >= MAX_IMPORT_DEPTH || seen.has(source)) return content;
	seen.add(source);
	const base = dirname(source);
	const expanded: string[] = [];
	let inFence = false;
	for (const line of content.split(/\r?\n/)) {
		if (line.trimStart().startsWith("```")) {
			inFence = !inFence;
			expanded.push(line);
			continue;
		}
		if (inFence) {
			expanded.push(line);
			continue;
		}
		expanded.push(await expandImportsInLine(line, base, workspaceRoot, depth + 1, seen));
	}
	seen.delete(source);
	return expanded.join("\n");
}

async function expandImportsInLine(
	line: string,
	base: string,
	workspaceRoot: string,
	depth: number,
	seen: Set<string>,
): Promise<string> {
	const out: string[] = [];
	for (const token of line.split(/\s+/)) {
		const raw = token.startsWith("@") ? token.slice(1) : undefined;
		if (!raw || raw.includes("@")) {
			out.push(token);
			continue;
		}
		const trimmed = raw.replace(/[.,;:!?)\]}'"]+$/g, "");
		try {
			const path = await normalizeImportPath(base, trimmed, workspaceRoot);
			if (!isWithinOrEqual(path, workspaceRoot) || !(await fileExists(path)) || seen.has(path)) {
				out.push(token);
				continue;
			}
			const nested = await readFile(path, "utf-8");
			out.push(await expandImports(path, nested, workspaceRoot, depth, seen));
		} catch {
			out.push(token);
		}
	}
	return out.join(" ");
}

async function readContextCandidate(
	candidate: { path: string; provider: string; sticky: boolean; priority: number },
	workspaceRoot: string,
): Promise<ContextFile> {
	const path = await realpath(candidate.path);
	if (!isWithinOrEqual(path, workspaceRoot)) {
		throw new Error("context file must stay inside workspace");
	}
	const content = await expandImports(path, await readFile(path, "utf-8"), workspaceRoot, 0, new Set());
	return {
		path,
		provider: candidate.provider,
		sticky: candidate.sticky,
		priority: candidate.priority,
		content: content.trim(),
	};
}

export async function discoverContextFiles(workspaceRoot: string): Promise<ContextFile[]> {
	const root = await normalizeRoot(workspaceRoot);
	const candidates = [
		{ path: join(root, "AGENTS.md"), provider: "agents-md", sticky: false, priority: 10 },
		{ path: join(root, ".magenta", "AGENTS.md"), provider: "magenta", sticky: false, priority: 100 },
		{ path: join(root, ".magenta", "RULES.md"), provider: "magenta", sticky: true, priority: 100 },
		{ path: join(root, ".claude", "CLAUDE.md"), provider: "claude", sticky: false, priority: 80 },
		{ path: join(root, ".gemini", "GEMINI.md"), provider: "gemini", sticky: false, priority: 60 },
		{ path: join(root, ".github", "copilot-instructions.md"), provider: "github", sticky: false, priority: 30 },
	];
	let selected: (typeof candidates)[number] | undefined;
	let sticky: (typeof candidates)[number] | undefined;
	for (const candidate of candidates) {
		if (!(await fileExists(candidate.path))) continue;
		if (candidate.sticky) {
			sticky = candidate;
			continue;
		}
		if (!selected || candidate.priority > selected.priority) selected = candidate;
	}
	const files: ContextFile[] = [];
	if (selected) files.push(await readContextCandidate(selected, root));
	if (sticky) files.push(await readContextCandidate(sticky, root));
	return files;
}

export class ContextProvider implements IContextProvider {
	private readonly workspaceRoot: string;

	constructor(options: ContextProviderOptions = {}) {
		this.workspaceRoot = options.workspaceRoot ?? process.cwd();
	}

	async discoverContextFiles(workspaceRoot: string): Promise<ContextFile[]> {
		return discoverContextFiles(workspaceRoot);
	}

	describe(): HcpServerDescription {
		return {
			target: "context://{workspace,project}",
			kind: "context",
			ops: ["discover", "describe", "read", "call", "status"],
			description: "Discover project instruction files and return model-safe context content.",
			metadata: {
				implementation: "native-ts",
				source: "magenta",
				origin: "magenta1-general-harness",
			},
		};
	}

	async discover(): Promise<Record<string, unknown>> {
		return {
			provider: "context-files",
			targets: [...CONTEXT_TARGETS],
			operations: ["read", "status"],
		};
	}

	async read(): Promise<Record<string, unknown>> {
		const root = await normalizeRoot(this.workspaceRoot);
		const files = await discoverContextFiles(root);
		const content = files.map((file) => `<file path="${file.path}">\n${file.content}\n</file>`).join("\n");
		return {
			name: "project-context",
			description: "Project context files discovered from this workspace.",
			content: modelSafeText(content),
			files,
			count: files.length,
		};
	}

	async status(): Promise<Record<string, unknown>> {
		const root = await normalizeRoot(this.workspaceRoot);
		const files = await discoverContextFiles(root);
		return {
			target: "context://project",
			workspace_root: root,
			count: files.length,
			files: files.map((file) => ({
				path: file.path,
				provider: file.provider,
				sticky: file.sticky,
			})),
			contract: {
				audience: "operator",
				execution: "read-only context discovery",
				model_surface: false,
			},
		};
	}

	toHcpServer(): HcpServer {
		return {
			describe: () => this.describe(),
			call: async (call: HcpRequest): Promise<unknown> => {
				const name = targetName(call.target);
				if (name !== "workspace" && name !== "project") {
					throw new Error(`unknown context target: ${call.target}`);
				}
				switch (call.op || "read") {
					case "discover":
					case "list":
						return this.discover();
					case "describe":
						return {
							name: "project-context",
							target: "context://project",
							aliases: ["context://workspace"],
							description: this.describe().description,
							operations: ["read", "status"],
						};
					case "read":
					case "call":
						return this.read();
					case "status":
						return this.status();
					default:
						throw new Error(`unsupported context operation ${call.op}`);
				}
			},
		};
	}
}
