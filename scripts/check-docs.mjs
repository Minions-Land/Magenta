#!/usr/bin/env node

import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_ENTRIES = [
	"README.md",
	"AGENTS.md",
	"CLAUDE.md",
	"docs",
	"brands/README.md",
	"packages",
	"scripts/README.md",
	"HarnessComponentProtocol/README.md",
	"HarnessComponentProtocol/.HCP/README.md",
	"HarnessComponentProtocol/docs",
	"HarnessComponentProtocol/_magenta/packages/README.md",
	"HarnessComponentProtocol/tools/todo/README.md",
];

const PRODUCT_DOC = /^(?:README\.md|docs\/)/u;
const DELETED_DOCUMENTS = [
	".magenta-renderkind-migration.md",
	"COMPLETE_SUMMARY.md",
	"FINAL_ANSWER.md",
	"IMPLEMENTATION_SUMMARY.md",
	"SUCCESS_REPORT.md",
	"docs/BRANDING.md",
	"HarnessComponentProtocol/README-harness.md",
	"HarnessComponentProtocol/.HCP/HCP-OVERVIEW.md",
	"HarnessComponentProtocol/docs/governance/hcp-rollout-progress.md",
	"HarnessComponentProtocol/docs/governance/log.md",
	".tmp/HCP重构规范-冻结.md",
	"scripts/INSTALL_README.md",
	"scripts/quick-install.sh",
	"scripts/remote-install.sh",
	"scripts/publish-to-cli-repo.sh",
	"scripts/download-page.html",
	"scripts/user-install.sh",
	"scripts/create-dist-package.sh",
	"scripts/package-for-distribution.sh",
];
const PLACEHOLDERS = [
	{ label: "placeholder repository owner", pattern: /\byourusername\b/iu },
	{ label: "placeholder organization", pattern: /\byour[-_ ]?org\b/iu },
	{ label: "placeholder repository", pattern: /\byour[-_ ]?repo\b/iu },
	{ label: "placeholder documentation host", pattern: /\bdocs\.magenta\.dev\b/iu },
];
const LEGACY_ASSETS = [
	{ label: "old resources archive", pattern: /\bmagenta-resources\.tar\.gz\b/iu },
	{ label: "old macOS asset", pattern: /\bmagenta-macos(?!-(?:arm64|x64)\b)/iu },
	{ label: "old Linux asset", pattern: /\bmagenta-linux(?!-x64\b)/iu },
	{ label: "old Windows asset", pattern: /\bmagenta-windows(?!-x64\.exe\b)/iu },
	{ label: "old Darwin asset", pattern: /\bmagenta-darwin(?:-[a-z0-9]+)?\b/iu },
	{ label: "old win32 asset", pattern: /\bmagenta-win32(?:-[a-z0-9]+)?\b/iu },
];
const FORBIDDEN_REPOSITORIES = [
	{ label: "obsolete source repository", pattern: /github\.com\/Earendil-Works\/Magenta3/iu },
	{ label: "obsolete source repository", pattern: /github\.com\/Minions-Land\/Magenta3/iu },
];
const PACKAGE_MANIFESTS = [
	"package.json",
	"HarnessComponentProtocol/package.json",
	"HarnessComponentProtocol/memory/package.json",
	"pi/ai/package.json",
	"pi/agent/package.json",
	"pi/tui/package.json",
	"pi/coding-agent/package.json",
];

function pathInside(root, candidate) {
	const pathFromRoot = relative(root, candidate);
	return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot));
}

async function collectMarkdown(path, files) {
	if (!existsSync(path)) return;
	const info = await stat(path);
	if (info.isFile()) {
		if (path.endsWith(".md")) files.push(path);
		return;
	}
	if (!info.isDirectory()) return;
	for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.name === "node_modules" || entry.name === "dist") continue;
		await collectMarkdown(join(path, entry.name), files);
	}
}

export async function collectDocs(root, entries = DEFAULT_ENTRIES) {
	const files = [];
	for (const entry of entries) await collectMarkdown(resolve(root, entry), files);
	return [...new Set(files)].sort();
}

function lineNumberAt(content, index) {
	let line = 1;
	for (let cursor = 0; cursor < index; cursor++) if (content.charCodeAt(cursor) === 10) line++;
	return line;
}

function stripHeadingMarkup(text) {
	return text
		.replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
		.replace(/<[^>]+>/gu, "")
		.replace(/&(?:amp|lt|gt|quot|#39);/gu, "")
		.replace(/[*_~`]/gu, "");
}

export function githubSlug(text) {
	return stripHeadingMarkup(text)
		.trim()
		.toLowerCase()
		.replace(/[\u2000-\u206f\u2e00-\u2e7f\\'"!#$%&()*+,./:;<=>?@[\]^`{|}~]/gu, "")
		.replace(/\s/gu, "-");
}

export function scanMarkdown(content) {
	const lines = content.split(/\r?\n/u);
	const visible = Array(lines.length).fill("");
	const errors = [];
	let fence;

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
		if (!fence && match) {
			fence = {
				character: match[1][0],
				length: match[1].length,
				line: index + 1,
				mermaid: match[2].trim().split(/\s+/u)[0]?.toLowerCase() === "mermaid",
			};
			continue;
		}
		if (fence) {
			if (
				match &&
				match[1][0] === fence.character &&
				match[1].length >= fence.length &&
				match[2].trim() === ""
			) {
				fence = undefined;
			}
			continue;
		}
		visible[index] = line;
	}

	if (fence) {
		errors.push({
			line: fence.line,
			code: fence.mermaid ? "mermaid-fence" : "code-fence",
			message: `unterminated ${fence.mermaid ? "Mermaid " : ""}code fence`,
		});
	}

	const anchors = new Set();
	const slugCounts = new Map();
	for (let index = 0; index < visible.length; index++) {
		const line = visible[index];
		const explicit = line.matchAll(/<a\s+[^>]*(?:id|name)=["']([^"']+)["'][^>]*>/giu);
		for (const match of explicit) anchors.add(match[1]);

		let heading;
		const atx = line.match(/^ {0,3}#{1,6}\s+(.+?)(?:\s+#+\s*)?$/u);
		if (atx) heading = atx[1];
		else if (line.trim() && index + 1 < visible.length && /^ {0,3}(?:=+|-+)\s*$/u.test(visible[index + 1])) {
			heading = line.trim();
		}
		if (!heading) continue;
		const base = githubSlug(heading);
		if (!base) continue;
		const count = slugCounts.get(base) ?? 0;
		slugCounts.set(base, count + 1);
		anchors.add(count === 0 ? base : `${base}-${count}`);
	}

	return { visible: visible.join("\n"), anchors, errors };
}

function extractLinks(visible) {
	const links = [];
	const inline = /!?\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+["'][^"']*["'])?\s*\)/gu;
	for (const match of visible.matchAll(inline)) {
		links.push({ target: match[1].replace(/^<|>$/gu, ""), line: lineNumberAt(visible, match.index) });
	}
	const definitions = /^ {0,3}\[[^\]]+\]:\s*(<[^>]+>|\S+)/gmu;
	for (const match of visible.matchAll(definitions)) {
		links.push({ target: match[1].replace(/^<|>$/gu, ""), line: lineNumberAt(visible, match.index) });
	}
	return links;
}

function contentChecks(relativePath, content) {
	const errors = [];
	const addMatches = (checks, code) => {
		for (const check of checks) {
			const match = content.match(check.pattern);
			if (match) errors.push({ line: lineNumberAt(content, match.index), code, message: check.label });
		}
	};
	for (const deleted of DELETED_DOCUMENTS) {
		const index = content.indexOf(deleted);
		if (index >= 0) errors.push({ line: lineNumberAt(content, index), code: "deleted-doc", message: `references deleted document ${deleted}` });
	}
	addMatches(PLACEHOLDERS, "placeholder");
	addMatches(LEGACY_ASSETS, "legacy-asset");
	addMatches(FORBIDDEN_REPOSITORIES, "obsolete-repository");

	if (PRODUCT_DOC.test(relativePath)) {
		const version = content.match(/\bv?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/u);
		if (version) {
			errors.push({
				line: lineNumberAt(content, version.index),
				code: "hardcoded-version",
				message: `hardcoded product-style version ${version[0]}`,
			});
		}
		const size = content.match(/\b\d+(?:\.\d+)?\s*(?:KB|KiB|MB|MiB|GB|GiB)\b/iu);
		if (size) {
			errors.push({ line: lineNumberAt(content, size.index), code: "binary-size", message: `hardcoded size ${size[0]}` });
		}
	}
	return errors;
}

async function availableNpmScripts(root) {
	const scripts = new Set();
	for (const manifest of PACKAGE_MANIFESTS) {
		const path = resolve(root, manifest);
		if (!existsSync(path)) continue;
		const parsed = JSON.parse(await readFile(path, "utf8"));
		for (const name of Object.keys(parsed.scripts ?? {})) scripts.add(name);
	}
	return scripts;
}

function npmScriptChecks(visible, scripts) {
	const errors = [];
	for (const match of visible.matchAll(/\bnpm\s+run\s+([a-z0-9:_-]+)/giu)) {
		if (!scripts.has(match[1])) {
			errors.push({
				line: lineNumberAt(visible, match.index),
				code: "npm-script",
				message: `unknown npm script ${match[1]}`,
			});
		}
	}
	return errors;
}

async function resolveLink(root, sourcePath, target) {
	const decoded = decodeURIComponent(target);
	const hashIndex = decoded.indexOf("#");
	const rawPath = hashIndex >= 0 ? decoded.slice(0, hashIndex) : decoded;
	const fragment = hashIndex >= 0 ? decoded.slice(hashIndex + 1) : "";
	const withoutQuery = rawPath.split("?")[0];
	const targetPath = resolve(dirname(sourcePath), withoutQuery || ".");
	if (!pathInside(root, targetPath)) return { error: "target escapes the repository" };
	if (!existsSync(targetPath)) return { error: `target does not exist: ${withoutQuery || relative(root, sourcePath)}` };
	let anchorPath = targetPath;
	const info = await stat(targetPath);
	if (info.isDirectory()) anchorPath = join(targetPath, "README.md");
	if (!fragment || !existsSync(anchorPath) || !anchorPath.endsWith(".md")) return {};
	const targetContent = await readFile(anchorPath, "utf8");
	const { anchors } = scanMarkdown(targetContent);
	if (!anchors.has(fragment)) return { error: `anchor #${fragment} does not exist in ${relative(root, anchorPath)}` };
	return {};
}

export async function checkDocs(root, options = {}) {
	const resolvedRoot = resolve(root);
	const files = await collectDocs(resolvedRoot, options.entries ?? DEFAULT_ENTRIES);
	const scripts = await availableNpmScripts(resolvedRoot);
	const errors = [];

	for (const file of files) {
		const content = await readFile(file, "utf8");
		const relativePath = relative(resolvedRoot, file).replaceAll(sep, "/");
		const scanned = scanMarkdown(content);
		const fileErrors = [
			...scanned.errors,
			...contentChecks(relativePath, content),
			...npmScriptChecks(content, scripts),
		];
		for (const link of extractLinks(scanned.visible)) {
			if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(link.target)) continue;
			try {
				const result = await resolveLink(resolvedRoot, file, link.target);
				if (result.error) fileErrors.push({ line: link.line, code: "link", message: result.error });
			} catch (error) {
				fileErrors.push({
					line: link.line,
					code: "link",
					message: `invalid link ${link.target}: ${error instanceof Error ? error.message : String(error)}`,
				});
			}
		}
		for (const error of fileErrors) errors.push({ file: relativePath, ...error });
	}
	return { errors, files: files.map((file) => relative(resolvedRoot, file).replaceAll(sep, "/")) };
}

function parseRoot(args) {
	const index = args.indexOf("--root");
	if (index < 0) return resolve(dirname(fileURLToPath(import.meta.url)), "..");
	if (!args[index + 1]) throw new Error("--root requires a directory");
	return resolve(args[index + 1]);
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
	try {
		const root = parseRoot(process.argv.slice(2));
		const result = await checkDocs(root);
		if (result.errors.length === 0) {
			console.log(`Documentation check passed (${result.files.length} files).`);
		} else {
			for (const error of result.errors) console.error(`${error.file}:${error.line}: [${error.code}] ${error.message}`);
			console.error(`Documentation check failed with ${result.errors.length} error(s).`);
			process.exitCode = 1;
		}
	} catch (error) {
		console.error(error instanceof Error ? error.stack : String(error));
		process.exitCode = 1;
	}
}
