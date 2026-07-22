import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertCleanCompiledDist, inspectCompiledDist } from "./verify-clean-dist.mjs";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "magenta-clean-dist-"));
	const sourceRoot = join(root, "pi/coding-agent/src");
	const distRoot = join(root, "pi/coding-agent/dist");
	mkdirSync(join(sourceRoot, "core/export-html"), { recursive: true });
	mkdirSync(join(distRoot, "core/export-html"), { recursive: true });
	mkdirSync(join(distRoot, "runtime"), { recursive: true });
	writeFileSync(join(sourceRoot, "core/current.ts"), "export const current = true;\n");
	writeFileSync(join(distRoot, "core/current.js"), "export const current = true;\n");
	writeFileSync(join(distRoot, "core/current.d.ts"), "export declare const current = true;\n");
	writeFileSync(join(sourceRoot, "core/export-html/template.js"), "export {};\n");
	writeFileSync(join(distRoot, "core/export-html/template.js"), "export {};\n");
	writeFileSync(join(distRoot, "runtime/index.js"), "module.exports = {};\n");
	return { distRoot, root, sourceRoot };
}

test("accepts current compiler outputs and ignores copied runtime assets", () => {
	const paths = fixture();
	try {
		assert.deepEqual(assertCleanCompiledDist(paths.root), { missing: [], stale: [], unexpected: [] });
	} finally {
		rmSync(paths.root, { recursive: true, force: true });
	}
});

test("reports deleted-source ghosts, missing outputs, and newer sources", () => {
	const paths = fixture();
	try {
		writeFileSync(join(paths.distRoot, "core/peer-link-session.js"), "export {};\n");
		writeFileSync(join(paths.sourceRoot, "core/missing.ts"), "export const missing = true;\n");
		const old = new Date("2026-01-01T00:00:00Z");
		const recent = new Date("2026-01-02T00:00:00Z");
		utimesSync(join(paths.distRoot, "core/current.js"), old, old);
		utimesSync(join(paths.sourceRoot, "core/current.ts"), recent, recent);

		const result = inspectCompiledDist(paths.root);
		assert.deepEqual(result.unexpected, ["pi/coding-agent/dist/core/peer-link-session.js"]);
		assert.deepEqual(result.missing, ["pi/coding-agent/dist/core/missing.js"]);
		assert.deepEqual(result.stale, ["pi/coding-agent/dist/core/current.js"]);
		assert.throws(
			() => assertCleanCompiledDist(paths.root),
			/unexpected outputs.*peer-link-session.*missing outputs.*missing\.js.*stale outputs.*current\.js/u,
		);
	} finally {
		rmSync(paths.root, { recursive: true, force: true });
	}
});

test("checks dependency workspace output used through package symlinks", () => {
	const paths = fixture();
	const source = join(paths.root, "pi/ai/src/providers/openai.ts");
	const output = join(paths.root, "pi/ai/dist/providers/openai.js");
	mkdirSync(join(paths.root, "pi/ai/src/providers"), { recursive: true });
	mkdirSync(join(paths.root, "pi/ai/dist/providers"), { recursive: true });
	writeFileSync(source, "export const current = true;\n");
	writeFileSync(output, "export const current = false;\n");
	const old = new Date("2026-01-01T00:00:00Z");
	const recent = new Date("2026-01-02T00:00:00Z");
	utimesSync(output, old, old);
	utimesSync(source, recent, recent);
	try {
		const result = inspectCompiledDist(paths.root);
		assert.deepEqual(result.stale, ["pi/ai/dist/providers/openai.js"]);
		assert.throws(() => assertCleanCompiledDist(paths.root), /pi\/ai\/dist\/providers\/openai\.js/u);
	} finally {
		rmSync(paths.root, { recursive: true, force: true });
	}
});
