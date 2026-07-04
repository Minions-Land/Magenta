#!/usr/bin/env node
// One-shot codemod for Step 3: move capability/tool modules under modules/
// and rewrite every relative import across the harness to match.
//
// Strategy: purely path-based. For each relative import specifier we resolve it
// against the source file's ORIGINAL directory to an absolute path, map that
// absolute path through the old->new directory move, then recompute the
// specifier relative to the source file's NEW directory. This is direction-
// agnostic (handles module->module, core->module, module->core alike) and only
// touches specifiers whose source file or target actually moved.
//
// Usage: node scripts/reorg-modules.mjs            (apply)
//        node scripts/reorg-modules.mjs --dry-run  (print planned rewrites)

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const harnessRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const dryRun = process.argv.includes("--dry-run");

const MOVED = [
	"compaction",
	"context",
	"hooks",
	"memory",
	"policy",
	"prompt-templates",
	"runtime",
	"sandbox",
	"skills",
	"system-prompt",
	"tools",
	"tools-search",
];

// old-abs-dir -> new-abs-dir for each moved top-level module
const moveMap = new Map(MOVED.map((m) => [join(harnessRoot, m), join(harnessRoot, "modules", m)]));

// Map an absolute path (under the OLD tree) to its NEW absolute path.
function mapPath(absOld) {
	for (const [oldDir, newDir] of moveMap) {
		if (absOld === oldDir || absOld.startsWith(oldDir + "/")) {
			return newDir + absOld.slice(oldDir.length);
		}
	}
	return absOld; // unmoved
}

// Where does this source file live AFTER the move?
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

// Rewrite relative specifiers in a single file (using its ORIGINAL location).
const specifierRe = /(from\s*["']|import\(\s*["']|export\s*\*\s*from\s*["']|export\s*{[^}]*}\s*from\s*["'])(\.\.?\/[^"']*)(["'])/g;

let totalRewrites = 0;
const edits = []; // {absOldFile, absNewFile, newText}

for (const absOldFile of files) {
	const oldDir = dirname(absOldFile);
	const nDir = newFileDir(absOldFile);
	const text = readFileSync(absOldFile, "utf8");
	let fileChanged = false;

	const next = text.replace(specifierRe, (match, pre, spec, post) => {
		// resolve target against the file's OLD dir
		const absTargetOld = resolve(oldDir, spec);
		const absTargetNew = mapPath(absTargetOld);
		// nothing about this specifier's endpoints moved -> keep as-is
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
	console.log(`[dry-run] ${MOVED.length} dirs -> modules/`);
	console.log(`[dry-run] ${edits.length} files touched, ${totalRewrites} import specifiers rewritten`);
	for (const e of edits.filter((x) => x.absOldFile !== x.absNewFile).slice(0, 8)) {
		console.log(`  move: ${relative(harnessRoot, e.absOldFile)} -> ${relative(harnessRoot, e.absNewFile)}`);
	}
	process.exit(0);
}

// 1) git mv the top-level module dirs
for (const m of MOVED) {
	execFileSync("git", ["mv", m, join("modules", m)], { cwd: harnessRoot, stdio: "inherit" });
}

// 2) write rewritten content at NEW locations (git mv already moved the files)
for (const e of edits) {
	if (!e.changed) continue;
	writeFileSync(e.absNewFile, e.newText);
}

console.log(`reorg complete: ${MOVED.length} dirs moved, ${totalRewrites} import specifiers rewritten in ${edits.filter((e) => e.changed).length} files`);
