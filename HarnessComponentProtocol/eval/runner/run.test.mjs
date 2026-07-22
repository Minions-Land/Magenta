import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { harnessRoot } from "./plan.mjs";

const runnerPath = fileURLToPath(new URL("./run.mjs", import.meta.url));

test("dry-run exposes unresolved isolation while real run creates no result directory", async (t) => {
	const temporaryDirectory = await mkdtemp(join(tmpdir(), "magenta-eval-gate-"));
	t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
	const scenarioName = `isolation-gate-${process.pid}`;
	const scenarioPath = join(temporaryDirectory, "scenario.toml");
	await writeFile(
		scenarioPath,
		`name = "${scenarioName}"\ndescription = "gate test"\ntargets_component = "compaction"\n\n[[variants]]\nname = "off"\ncomponents = { compaction = false }\nmanual_note = "documentation only"\n`,
	);

	const dryRun = spawnSync(process.execPath, [runnerPath, scenarioPath, "--dry-run", "--json"], {
		encoding: "utf8",
	});
	assert.equal(dryRun.status, 0, dryRun.stderr);
	const plan = JSON.parse(dryRun.stdout);
	assert.equal(plan.executionGate.realRunAllowed, false);
	assert.equal(plan.executionGate.unresolvedManualIsolation[0].component, "compaction");
	const humanDryRun = spawnSync(process.execPath, [runnerPath, scenarioPath, "--dry-run"], { encoding: "utf8" });
	assert.equal(humanDryRun.status, 0, humanDryRun.stderr);
	assert.match(humanDryRun.stdout, /real run: BLOCKED \(unresolved manual isolation\)/);
	assert.match(humanDryRun.stdout, /dry-run complete \(no model calls made; real run remains blocked\)/);

	const resultsRoot = join(harnessRoot, "eval/results");
	const before = (await readdir(resultsRoot)).filter((name) => name.startsWith(`${scenarioName}-`));
	const realRun = spawnSync(process.execPath, [runnerPath, scenarioPath, "--json"], { encoding: "utf8" });
	const after = (await readdir(resultsRoot)).filter((name) => name.startsWith(`${scenarioName}-`));

	assert.equal(realRun.status, 1);
	assert.match(realRun.stderr, /real eval run refused: unresolved execution isolation for off:compaction/);
	assert.deepEqual(after, before);
});
