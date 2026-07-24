import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	assertTestWorkspaceReady,
	createDefaultTestEnvironment,
	getTestCommands,
	PROVIDER_TEST_CREDENTIAL_ENV_KEYS,
} from "./run-tests.mjs";

test("default test environment removes provider credentials and disables local provider probes", () => {
	const ambient = Object.fromEntries(PROVIDER_TEST_CREDENTIAL_ENV_KEYS.map((key) => [key, `secret-${key}`]));
	const environment = createDefaultTestEnvironment({ ...ambient, PATH: "/test/bin", ORDINARY_SETTING: "kept" });

	for (const key of PROVIDER_TEST_CREDENTIAL_ENV_KEYS) assert.equal(environment[key], undefined, key);
	assert.equal(environment.PI_NO_LOCAL_LLM, "1");
	assert.equal(environment.PATH, "/test/bin");
	assert.equal(environment.ORDINARY_SETTING, "kept");
});

test("root scripts keep provider E2E behind an explicit command", () => {
	const rootPackage = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

	assert.equal(rootPackage.scripts.test, "node scripts/run-tests.mjs");
	assert.equal(rootPackage.scripts["test:e2e"], "node scripts/run-tests.mjs --e2e");
	assert.deepEqual(getTestCommands(), [
		["run", "test:scripts"],
		["run", "test", "--workspaces", "--if-present"],
	]);
	assert.deepEqual(getTestCommands({ e2e: true }), [
		["run", "test", "--workspace", "@earendil-works/pi-ai"],
	]);
});

test("default test preflight rejects stale compiled workspace output", () => {
	const root = mkdtempSync(join(tmpdir(), "magenta-test-preflight-"));
	const source = join(root, "pi/ai/src/index.ts");
	const output = join(root, "pi/ai/dist/index.js");
	try {
		mkdirSync(join(root, "pi/ai/src"), { recursive: true });
		mkdirSync(join(root, "pi/ai/dist"), { recursive: true });
		writeFileSync(source, "export const version = 2;\n");
		writeFileSync(output, "export const version = 1;\n");
		const old = new Date("2026-01-01T00:00:00Z");
		const current = new Date("2026-01-02T00:00:00Z");
		utimesSync(output, old, old);
		utimesSync(source, current, current);

		assert.throws(() => assertTestWorkspaceReady(root), /stale outputs.*pi\/ai\/dist\/index\.js/u);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("default test preflight explains how to create missing compiled output", () => {
	const root = mkdtempSync(join(tmpdir(), "magenta-test-preflight-missing-"));
	try {
		mkdirSync(join(root, "pi/ai/src"), { recursive: true });
		writeFileSync(join(root, "pi/ai/src/index.ts"), "export const version = 1;\n");

		assert.throws(
			() => assertTestWorkspaceReady(root),
			/missing outputs.*pi\/ai\/dist.*Run npm run clean && npm run build/u,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
