import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, lstat, open, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
	cleanupLogTree,
	createBoundedLogState,
	DEFAULT_LOG_MAX_AGE_MS,
	DEFAULT_LOG_MAX_BYTES,
	DEFAULT_LOG_MAX_FILES,
	DEFAULT_LOG_MAX_TOTAL_BYTES,
	writeBoundedLog,
} from "../../_magenta/log-retention.ts";

export const EVAL_STREAM_MAX_BYTES = DEFAULT_LOG_MAX_BYTES;
export const EVAL_STRUCTURED_ARTIFACT_MAX_BYTES = DEFAULT_LOG_MAX_BYTES;
export const EVAL_RESULTS_MAX_AGE_MS = DEFAULT_LOG_MAX_AGE_MS;
export const EVAL_RESULTS_MAX_FILES = DEFAULT_LOG_MAX_FILES;
export const EVAL_RESULTS_MAX_TOTAL_BYTES = DEFAULT_LOG_MAX_TOTAL_BYTES;

const SAFE_NAME = "[A-Za-z0-9][A-Za-z0-9._-]*";
const RUN_DIRECTORY_PATTERN = new RegExp(
	`^${SAFE_NAME}-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z(?:-\\d+-[a-f0-9]+)?$`,
);
const RESULT_ARTIFACT_PATTERN = new RegExp(
	`^(?:plan|summary)\\.json$|^${SAFE_NAME}\\.(?:stdout\\.jsonl|stderr\\.log|summary\\.json)$|^\\.active-\\d+-[a-f0-9]+$`,
);
const ACTIVE_MARKER_PATTERN = /^\.active-(\d+)-[a-f0-9]+$/;

function isDirectChild(root, path) {
	const child = relative(root, path);
	return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !child.includes(sep);
}

function isEvalRunDirectory(root, path) {
	return isDirectChild(root, path) && RUN_DIRECTORY_PATTERN.test(basename(path));
}

function isEvalArtifact(root, path) {
	const directory = dirname(path);
	return isEvalRunDirectory(root, directory) && RESULT_ARTIFACT_PATTERN.test(basename(path));
}

function processIsAlive(pid) {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	if (pid === process.pid) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}

async function ensureResultsRoot(root) {
	try {
		const info = await lstat(root);
		if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`eval results root is not a directory: ${root}`);
		return;
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
	await mkdir(root, { recursive: true, mode: 0o700 });
	const info = await lstat(root);
	if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`eval results root is not a directory: ${root}`);
}

function runToken(value) {
	const token = value ?? randomBytes(6).toString("hex");
	if (typeof token !== "string" || !/^[a-f0-9]+$/.test(token)) throw new Error("eval run id must be lowercase hex");
	return token;
}

/** Create one exclusive private run directory and mark it active before cleanup can inspect it. */
export async function createEvalRunDirectory(rootPath, scenarioName, options = {}) {
	if (typeof scenarioName !== "string" || !new RegExp(`^${SAFE_NAME}$`).test(scenarioName)) {
		throw new Error("scenario name must be filesystem-safe");
	}
	const root = resolve(rootPath);
	await ensureResultsRoot(root);
	const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
	if (!Number.isFinite(now.getTime())) throw new Error("eval run timestamp must be valid");
	const pid = options.pid ?? process.pid;
	if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("eval run pid must be a positive integer");
	const stamp = now.toISOString().replace(/[:.]/g, "-");

	for (let attempt = 0; attempt < 8; attempt++) {
		const token = runToken(attempt === 0 ? options.id : undefined);
		const path = resolve(root, `${scenarioName}-${stamp}-${pid}-${token}`);
		try {
			await mkdir(path, { mode: 0o700 });
		} catch (error) {
			if (error?.code === "EEXIST") continue;
			throw error;
		}
		const markerPath = resolve(path, `.active-${pid}-${token}`);
		try {
			await writeFile(markerPath, `${JSON.stringify({ schemaVersion: 1, pid, startedAt: now.toISOString() })}\n`, {
				flag: "wx",
				mode: 0o600,
			});
		} catch (error) {
			await rmdir(path).catch(() => undefined);
			throw error;
		}
		let released = false;
		return {
			path,
			markerPath,
			async release() {
				if (released) return;
				released = true;
				await unlink(markerPath).catch((error) => {
					if (error?.code !== "ENOENT") throw error;
				});
			},
		};
	}
	throw new Error("could not allocate a unique eval results directory");
}

/** Create, rather than replace, one size-bounded private result artifact. */
export async function writePrivateArtifact(path, data, options = {}) {
	const maxBytes = boundedByteLimit(options.maxBytes ?? EVAL_STRUCTURED_ARTIFACT_MAX_BYTES);
	const bytes = Buffer.byteLength(data);
	if (bytes > maxBytes) {
		const error = new Error(`eval artifact is ${bytes} bytes, exceeding the ${maxBytes}-byte limit`);
		error.code = "ERR_EVAL_ARTIFACT_TOO_LARGE";
		throw error;
	}
	await writeFile(path, data, { flag: "wx", mode: 0o600 });
}

async function activeRunDirectories(root) {
	let entries;
	try {
		const rootInfo = await lstat(root);
		if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return [];
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const active = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
		const directory = resolve(root, entry.name);
		if (!isEvalRunDirectory(root, directory)) continue;
		let children;
		try {
			children = await readdir(directory, { withFileTypes: true });
		} catch {
			continue;
		}
		let live = false;
		for (const child of children) {
			if (!child.isFile() || child.isSymbolicLink()) continue;
			const match = ACTIVE_MARKER_PATTERN.exec(child.name);
			if (!match) continue;
			const markerPath = resolve(directory, child.name);
			if (processIsAlive(Number(match[1]))) live = true;
			else await unlink(markerPath).catch(() => undefined);
		}
		if (live) active.push(directory);
	}
	return active;
}

/** Apply finite retention only to recognized, closed eval artifacts. */
export async function cleanupEvalResults(rootPath, options = {}) {
	const root = resolve(rootPath);
	const active = await activeRunDirectories(root);
	const protectedPrefixes = [...active, ...(options.protectedPrefixes ?? [])];
	return cleanupLogTree({
		root,
		fileFilter: (path) => isEvalArtifact(root, path),
		protectedPrefixes,
		emptyDirectoryFilter: (path) => isEvalRunDirectory(root, path),
		maxAgeMs: options.maxAgeMs ?? EVAL_RESULTS_MAX_AGE_MS,
		maxFiles: options.maxFiles ?? EVAL_RESULTS_MAX_FILES,
		maxTotalBytes: options.maxTotalBytes ?? EVAL_RESULTS_MAX_TOTAL_BYTES,
		now: options.now,
	});
}

function boundedByteLimit(value) {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error("eval stream maxBytes must be a non-negative integer");
	return value;
}

class BoundedCaptureTransform extends Transform {
	constructor(maxBytes) {
		super();
		this.maxBytes = boundedByteLimit(maxBytes);
		this.state = createBoundedLogState();
		this.observedBytes = 0;
		this.memory = Buffer.allocUnsafe(this.maxBytes);
		this.memoryBytes = 0;
		this.sink = {
			writableEnded: false,
			destroyed: false,
			write: (data) => {
				const chunk = Buffer.from(data);
				chunk.copy(this.memory, this.memoryBytes);
				this.memoryBytes += chunk.length;
				this.push(chunk);
				return true;
			},
		};
	}

	_transform(chunk, _encoding, callback) {
		try {
			this.observedBytes += chunk.length;
			writeBoundedLog(this.sink, this.state, chunk, this.maxBytes);
			callback();
		} catch (error) {
			callback(error);
		}
	}

	result() {
		return {
			text: this.memory.subarray(0, this.memoryBytes).toString("utf8"),
			bytes: this.memoryBytes,
			observedBytes: this.observedBytes,
			limitBytes: this.maxBytes,
			truncated: this.state.truncated,
		};
	}
}

async function openPrivateArtifact(path) {
	return open(path, "wx", 0o600);
}

function connectCapture(readable, handle, maxBytes) {
	const limiter = new BoundedCaptureTransform(maxBytes);
	const completion = pipeline(readable, limiter, handle.createWriteStream()).then(() => limiter.result());
	return { limiter, completion };
}

/** Start a backpressured, bounded stream capture and return before the source ends. */
export async function captureBoundedStream(readable, path, options = {}) {
	const handle = await openPrivateArtifact(path);
	const { limiter, completion } = connectCapture(readable, handle, options.maxBytes ?? EVAL_STREAM_MAX_BYTES);
	return { completion, snapshot: () => limiter.result() };
}

/** Run one child while streaming both raw streams into bounded private artifacts. */
export async function runBoundedProcess(options) {
	const maxBytes = boundedByteLimit(options.maxBytes ?? EVAL_STREAM_MAX_BYTES);
	const stdoutHandle = await openPrivateArtifact(options.stdoutPath);
	let stderrHandle;
	try {
		stderrHandle = await openPrivateArtifact(options.stderrPath);
	} catch (error) {
		await stdoutHandle.close().catch(() => undefined);
		throw error;
	}

	let child;
	try {
		child = spawn(options.executable, options.args, {
			cwd: options.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (error) {
		await Promise.allSettled([stdoutHandle.close(), stderrHandle.close()]);
		throw error;
	}

	let spawnError;
	let timedOut = false;
	let killTimer;
	let captureTerminationRequested = false;
	const requestTermination = () => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		child.kill("SIGTERM");
		if (!killTimer) {
			killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
			killTimer.unref();
		}
	};
	child.once("error", (error) => {
		spawnError = error.message;
	});

	const stdoutCapture = connectCapture(child.stdout, stdoutHandle, maxBytes);
	const stderrCapture = connectCapture(child.stderr, stderrHandle, maxBytes);
	let stdoutCaptureError;
	let stderrCaptureError;
	const captureFailure = (stream) => (error) => {
		if (stream === "stdout") stdoutCaptureError = error.message;
		else stderrCaptureError = error.message;
		if (!captureTerminationRequested) {
			captureTerminationRequested = true;
			requestTermination();
		}
		return stream === "stdout" ? stdoutCapture.limiter.result() : stderrCapture.limiter.result();
	};
	const stdoutCompletion = stdoutCapture.completion.catch(captureFailure("stdout"));
	const stderrCompletion = stderrCapture.completion.catch(captureFailure("stderr"));

	const wallTimer = setTimeout(() => {
		timedOut = true;
		requestTermination();
	}, options.wallTimeoutMs);
	wallTimer.unref();
	const closed = new Promise((resolveClosed) => {
		child.once("close", (code, signal) => resolveClosed({ code, signal }));
	});
	const [{ code, signal }, stdout, stderr] = await Promise.all([closed, stdoutCompletion, stderrCompletion]);
	clearTimeout(wallTimer);
	if (killTimer) clearTimeout(killTimer);

	return {
		code,
		signal,
		timedOut,
		spawnError,
		stdout: stdout.text,
		stderr: stderr.text,
		stdoutBytes: stdout.bytes,
		stderrBytes: stderr.bytes,
		stdoutObservedBytes: stdout.observedBytes,
		stderrObservedBytes: stderr.observedBytes,
		outputLimitBytes: maxBytes,
		stdoutTruncated: stdout.truncated,
		stderrTruncated: stderr.truncated,
		captureErrors: {
			stdout: stdoutCaptureError,
			stderr: stderrCaptureError,
		},
	};
}
