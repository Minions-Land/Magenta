#!/usr/bin/env node
// One-shot codemod for Step 4: move core runtime dirs under core/ and rewrite
// every relative import across the harness to match.
//
// Same path-based strategy as reorg-modules.mjs (Step 3): resolve each relative
// specifier against the source file's ORIGINAL dir, map through the old->new
// move, recompute relative to the file's NEW dir. Direction-agnostic; only
// touches specifiers whose source file or target actually moved.
//
// Usage: node scripts/reorg-core.mjs            (apply)
//        node scripts/reorg-core.mjs --dry-run  (print planned rewrites)

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const harnessRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const dryRun = process.argv.includes("--dry-run");

const MOVED = ["loop", "session", "messages", "types", "env", "utils"];

// old-abs-dir -> new-abs-dir for each moved top-level dir
const moveMap = new Map(MOVED.map((m) => [join(harnessRoot, m), join(harnessRoot, "core", m)]));

function mapPath(absOld) {
	for (const [oldDir, newDir] of moveMap) {
		if (absOld === oldDir || absOld.startsWith(oldDir + "/")) {
			return newDir + absOld.slice(oldDir.length);
		}
	}
	return absOld; // unmoved
}

function newFileDir(absOldFile) {
	return dirname(mapPath(absOldFile));
}

const skipDirs = new Set(["dist", "node_modules", "target", ".git"]);
const tsFiles = [];
function collect(dir) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!skipDirs.has(entry.name)) collect(join(dir, entry.name));
			continue;
		}
		if (entry.name.endsWith(".ts")) tsFiles.push(join(dir, entry.name));
	}
}
collect(harnessRoot);
// mcp is a standalone subpackage; leave it untouched
const files = tsFiles.filter((f) => !f.startsWith(join(harnessRoot, "mcp") + "/") && !f.startsWith(join(harnessRoot, "dist") + "/"));

const specifierRe = /(from\s*["']|import\(\s*["']|export\s*\*\s*from\s*["']|export\s*{[^}]*}\s*from\s*["'])(\.\.?\/[^"']*)(["'])/g;

let totalRewrites = 0;
const edits = [];

for (const absOldFile of files) {
	const oldDir = dirname(absOldFile);
	const nDir = newFileDir(absOldFile);
	const text = readFileSync(absOldFile, "utf8");
	let fileChanged = false;

	const next = text.replace(specifierRe, (match, pre, spec, post) => {
		const absTargetOld = resolve(oldDir, spec);
		const absTargetNew = mapPath(absTargetOld);
		if (absTargetNew === absTargetOld && nDir === oldDir) return match;
		let rel = relative(nDir, absTargetNew);
		if (!rel.startsWith(".")) rel = "./" + rel;
		if (rel !== spec) {
			fileChanged = true;
			totalRewrites++;
		}
		return `${pre}${rel}${post}`;
	});

	const absNewFile = mapPath(absOldFile);
	if (fileChanged || absNewFile !== absOldFile) {
		edits.push({ absOldFile, absNewFile, newText: next, changed: fileChanged });
	}
}

if (dryRun) {
	console.log(`[dry-run] ${MOVED.length} dirs -> core/`);
	console.log(`[dry-run] ${edits.length} files touched, ${totalRewrites} import specifiers rewritten`);
	for (const e of edits.filter((x) => x.absOldFile !== x.absNewFile).slice(0, 8)) {
		console.log(`  move: ${relative(harnessRoot, e.absOldFile)} -> ${relative(harnessRoot, e.absNewFile)}`);
	}
	process.exit(0);
}

for (const m of MOVED) {
	execFileSync("git", ["mv", m, join("core", m)], { cwd: harnessRoot, stdio: "inherit" });
}

for (const e of edits) {
	if (!e.changed) continue;
	writeFileSync(e.absNewFile, e.newText);
}

console.log(`reorg complete: ${MOVED.length} dirs moved, ${totalRewrites} import specifiers rewritten in ${edits.filter((e) => e.changed).length} files`);
