import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
	captureBoundedStream,
	cleanupEvalResults,
	createEvalRunDirectory,
	runBoundedProcess,
	writePrivateArtifact,
} from "./artifacts.mjs";

async function temporaryRoot(t) {
	const root = await mkdtemp(join(tmpdir(), "magenta-eval-artifacts-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

async function waitForSize(path, minimum) {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		try {
			if ((await stat(path)).size >= minimum) return;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for ${path} to reach ${minimum} bytes`);
}

test("creates private run directories and artifacts", async (t) => {
	const root = join(await temporaryRoot(t), "results");
	const run = await createEvalRunDirectory(root, "private", {
		now: new Date("2026-07-21T12:00:00.000Z"),
		id: "abcdef12",
	});
	const artifact = join(run.path, "plan.json");
	await writePrivateArtifact(artifact, "{}\n");

	assert.equal((await stat(root)).mode & 0o777, 0o700);
	assert.equal((await stat(run.path)).mode & 0o777, 0o700);
	assert.equal((await stat(run.markerPath)).mode & 0o777, 0o600);
	assert.equal((await stat(artifact)).mode & 0o777, 0o600);
	await run.release();
});

test("rejects oversized structured artifacts before creating a partial file", async (t) => {
	const root = await temporaryRoot(t);
	const artifact = join(root, "summary.json");

	await assert.rejects(writePrivateArtifact(artifact, "12345", { maxBytes: 4 }), {
		code: "ERR_EVAL_ARTIFACT_TOO_LARGE",
		message: "eval artifact is 5 bytes, exceeding the 4-byte limit",
	});
	await assert.rejects(stat(artifact), { code: "ENOENT" });

	await writePrivateArtifact(artifact, "1234", { maxBytes: 4 });
	assert.equal(await readFile(artifact, "utf8"), "1234");
});

test("streams output before EOF while bounding both memory and the artifact file", async (t) => {
	const root = await temporaryRoot(t);
	const path = join(root, "stream.log");
	const source = new PassThrough();
	const capture = await captureBoundedStream(source, path, { maxBytes: 64 });

	source.write("first chunk\n");
	await waitForSize(path, 1);
	assert.equal(source.writableEnded, false);
	source.write("x".repeat(512));
	source.end();
	const result = await capture.completion;
	const output = await readFile(path);

	assert.equal(result.truncated, true);
	assert.equal(result.bytes, 64);
	assert.equal(Buffer.byteLength(result.text), 64);
	assert.equal(output.byteLength, 64);
	assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("bounds stdout and stderr independently during a child process", async (t) => {
	const root = await temporaryRoot(t);
	const stdoutPath = join(root, "stdout.jsonl");
	const stderrPath = join(root, "stderr.log");
	const result = await runBoundedProcess({
		executable: process.execPath,
		args: ["-e", "process.stdout.write('o'.repeat(512)); process.stderr.write('e'.repeat(768));"],
		cwd: root,
		wallTimeoutMs: 10_000,
		stdoutPath,
		stderrPath,
		maxBytes: 96,
	});

	assert.equal(result.code, 0);
	assert.equal(result.stdoutTruncated, true);
	assert.equal(result.stderrTruncated, true);
	assert.equal(result.stdoutBytes, 96);
	assert.equal(result.stderrBytes, 96);
	assert.equal((await stat(stdoutPath)).size, 96);
	assert.equal((await stat(stderrPath)).size, 96);
	assert.equal((await stat(stdoutPath)).mode & 0o777, 0o600);
	assert.equal((await stat(stderrPath)).mode & 0o777, 0o600);
});

test("age cleanup preserves active runs and never follows result symlinks", async (t) => {
	const root = join(await temporaryRoot(t), "results");
	const active = await createEvalRunDirectory(root, "active", {
		now: new Date("2026-07-21T12:00:00.000Z"),
		id: "abcdef12",
	});
	const activeArtifact = join(active.path, "one.stderr.log");
	await writePrivateArtifact(activeArtifact, "active");

	const closed = join(root, "closed-2026-07-20T12-00-00-000Z");
	await mkdir(closed, { mode: 0o700 });
	const closedArtifact = join(closed, "one.stderr.log");
	await writeFile(closedArtifact, "closed", { mode: 0o600 });
	const old = new Date(0);
	await utimes(activeArtifact, old, old);
	await utimes(closedArtifact, old, old);

	const outside = join(await temporaryRoot(t), "outside.stderr.log");
	await writeFile(outside, "outside");
	await symlink(join(outside, ".."), join(root, "linked-2026-07-20T12-00-00-000Z"), "dir");

	const result = await cleanupEvalResults(root, { maxAgeMs: 1, maxFiles: 0, maxTotalBytes: 0, now: Date.now() });

	assert.ok(result.deletedFiles >= 1);
	assert.equal(await readFile(activeArtifact, "utf8"), "active");
	await assert.rejects(readFile(closedArtifact), { code: "ENOENT" });
	assert.equal(await readFile(outside, "utf8"), "outside");
	await active.release();
});

test("cleanup enforces file-count and total-byte budgets oldest first", async (t) => {
	const root = join(await temporaryRoot(t), "results");
	await mkdir(root, { recursive: true, mode: 0o700 });
	for (const [index, name] of ["a", "b", "c"].entries()) {
		const directory = join(root, `${name}-2026-07-21T12-00-0${index}-000Z`);
		await mkdir(directory, { mode: 0o700 });
		const artifact = join(directory, "one.stderr.log");
		await writeFile(artifact, String(index).repeat(10), { mode: 0o600 });
		const timestamp = new Date(index * 1_000);
		await utimes(artifact, timestamp, timestamp);
	}

	const result = await cleanupEvalResults(root, {
		maxAgeMs: Number.MAX_SAFE_INTEGER,
		maxFiles: 1,
		maxTotalBytes: 10,
		now: 10_000,
	});

	assert.equal(result.deletedFiles, 2);
	await assert.rejects(readFile(join(root, "a-2026-07-21T12-00-00-000Z", "one.stderr.log")), { code: "ENOENT" });
	await assert.rejects(readFile(join(root, "b-2026-07-21T12-00-01-000Z", "one.stderr.log")), { code: "ENOENT" });
	assert.equal(await readFile(join(root, "c-2026-07-21T12-00-02-000Z", "one.stderr.log"), "utf8"), "2222222222");
});
