import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const COMPILED_WORKSPACES = [
	{ root: "HarnessComponentProtocol", source: ".", kind: "harness" },
	{ root: "HarnessComponentProtocol/memory", source: ".", kind: "memory" },
	{ root: "pi/ai", source: "src", kind: "standard" },
	{ root: "pi/agent", source: "src", kind: "standard" },
	{ root: "pi/tui", source: "src", kind: "standard" },
	{ root: "pi/coding-agent", source: "src", kind: "coding-agent" },
];
const RESOURCE_TOP_LEVEL_DIRECTORIES = new Set([
	"_magenta",
	"assets",
	"docs",
	"examples",
	"export-html",
	"policy",
	"release",
	"runtime",
	"sandbox",
	"skills",
	"theme",
	"tools",
]);
const GENERATED_SUFFIXES = [".d.ts.map", ".d.ts", ".js.map", ".js"];

function listFiles(root, shouldPrune = () => false) {
	if (!existsSync(root)) return [];
	const files = [];
	const visit = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			const relativePath = relative(root, path).replaceAll("\\", "/");
			if (entry.isDirectory()) {
				if (!shouldPrune(relativePath)) visit(path);
			} else if (entry.isFile()) {
				files.push(relativePath);
			} else {
				throw new Error(`Compiled dist contains an unsupported filesystem entry: ${relativePath}`);
			}
		}
	};
	visit(root);
	return files.sort();
}

function sourcePathForGeneratedOutput(relativePath) {
	for (const suffix of GENERATED_SUFFIXES) {
		if (!relativePath.endsWith(suffix)) continue;
		return `${relativePath.slice(0, -suffix.length)}.ts`;
	}
	return undefined;
}

export function inspectCompiledDist(root = resolve(import.meta.dirname, "..")) {
	const missing = [];
	const stale = [];
	const unexpected = [];

	for (const workspace of COMPILED_WORKSPACES) {
		const workspaceRoot = resolve(root, workspace.root);
		if (!existsSync(workspaceRoot)) continue;
		const sourceRoot = resolve(workspaceRoot, workspace.source);
		const distRoot = join(workspaceRoot, "dist");
		if (!existsSync(distRoot)) throw new Error(`Compiled dist is missing: ${distRoot}`);

		const sourceFiles = listFiles(sourceRoot, (path) => {
			if (workspace.kind === "standard" || workspace.kind === "coding-agent") {
				return path === "extensions-disabled";
			}
			const parts = path.split("/");
			return (
				parts.includes("dist") ||
				parts.includes("node_modules") ||
				parts.includes("test") ||
				(workspace.kind === "harness" && parts[0] === "mcp")
			);
		}).filter((path) => {
			if (!path.endsWith(".ts") || path.endsWith(".d.ts") || path.endsWith(".test.ts")) return false;
			if (path.endsWith("vitest.config.ts")) return false;
			return workspace.kind !== "memory" || path.startsWith("pi/");
		});

		for (const sourceFile of sourceFiles) {
			const outputFile = `${sourceFile.slice(0, -3)}.js`;
			const sourcePath = join(sourceRoot, sourceFile);
			const outputPath = join(distRoot, outputFile);
			const displayPath = `${workspace.root}/dist/${outputFile}`;
			if (!existsSync(outputPath)) {
				missing.push(displayPath);
				continue;
			}
			if (statSync(outputPath).mtimeMs < statSync(sourcePath).mtimeMs) stale.push(displayPath);
		}

		const distFiles = listFiles(distRoot, (path) => {
			if (workspace.kind !== "coding-agent") return false;
			const topLevel = path.split("/", 1)[0];
			return RESOURCE_TOP_LEVEL_DIRECTORIES.has(topLevel) && !existsSync(join(sourceRoot, topLevel));
		});
		for (const distFile of distFiles) {
			const sourceFile = sourcePathForGeneratedOutput(distFile);
			if (!sourceFile) continue;
			if (existsSync(join(sourceRoot, sourceFile))) continue;
			if (distFile.endsWith(".js") && existsSync(join(sourceRoot, distFile))) continue;
			unexpected.push(`${workspace.root}/dist/${distFile}`);
		}
	}

	return { missing, stale, unexpected };
}

function summarize(label, paths) {
	if (paths.length === 0) return undefined;
	const shown = paths.slice(0, 12).join(", ");
	return `${label}: ${shown}${paths.length > 12 ? ` (+${paths.length - 12} more)` : ""}`;
}

export function assertCleanCompiledDist(root) {
	const result = inspectCompiledDist(root);
	const problems = [
		summarize("unexpected outputs", result.unexpected),
		summarize("missing outputs", result.missing),
		summarize("stale outputs", result.stale),
	].filter(Boolean);
	if (problems.length > 0) {
		throw new Error(`Compiled dist is not a clean current build (${problems.join("; ")}). Run npm run clean && npm run build.`);
	}
	return result;
}
