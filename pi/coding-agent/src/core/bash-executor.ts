/**
 * Bash command execution with streaming support and cancellation.
 *
 * This module provides a unified bash execution implementation used by:
 * - AgentSession.executeBash() for interactive and RPC modes
 * - Direct calls from modes that need bash execution
 */

import { randomBytes } from "node:crypto";
import { createWriteStream, lstatSync, readdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BufferedBoundedLog, DEFAULT_LOG_MAX_BYTES } from "@magenta/harness";
import { stripAnsi } from "../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../utils/shell.ts";
import type { BashOperations } from "./tools/bash.ts";
import { DEFAULT_MAX_BYTES, truncateTail } from "./tools/truncate.ts";

export const BASH_FULL_OUTPUT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const BASH_FULL_OUTPUT_MAX_BYTES = DEFAULT_LOG_MAX_BYTES;
export const BASH_FULL_OUTPUT_MAX_FILES = 200;
export const BASH_FULL_OUTPUT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

const BASH_FULL_OUTPUT_PATTERN = /^pi-bash-(?:(\d+)-)?[a-f0-9]{16}\.log$/;
const ACTIVE_BASH_FULL_OUTPUTS = new Set<string>();

export interface BashFullOutputRetentionOptions {
	maxAgeMs?: number;
	maxFiles?: number;
	maxTotalBytes?: number;
	now?: number;
}

function nonNegativeLimit(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function isLiveForeignProcess(pid: number | undefined): boolean {
	if (pid === undefined || pid === process.pid || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Remove only recognized, closed full-output artifacts under finite retention budgets. */
export function cleanupBashFullOutputFiles(
	directory = tmpdir(),
	options: BashFullOutputRetentionOptions = {},
): { deletedFiles: number; deletedBytes: number } {
	const maxAgeMs = nonNegativeLimit(options.maxAgeMs, BASH_FULL_OUTPUT_MAX_AGE_MS);
	const maxFiles = nonNegativeLimit(options.maxFiles, BASH_FULL_OUTPUT_MAX_FILES);
	const maxTotalBytes = nonNegativeLimit(options.maxTotalBytes, BASH_FULL_OUTPUT_MAX_TOTAL_BYTES);
	const now = options.now ?? Date.now();
	type Candidate = { path: string; size: number; mtimeMs: number; protected: boolean };
	const candidates: Candidate[] = [];
	try {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (!entry.isFile() || entry.isSymbolicLink()) continue;
			const match = BASH_FULL_OUTPUT_PATTERN.exec(entry.name);
			if (!match) continue;
			const path = join(directory, entry.name);
			const info = lstatSync(path);
			if (!info.isFile() || info.isSymbolicLink()) continue;
			const ownerPid = match[1] === undefined ? undefined : Number(match[1]);
			candidates.push({
				path,
				size: info.size,
				mtimeMs: info.mtimeMs,
				protected: ACTIVE_BASH_FULL_OUTPUTS.has(path) || isLiveForeignProcess(ownerPid),
			});
		}
	} catch {
		return { deletedFiles: 0, deletedBytes: 0 };
	}

	candidates.sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path));
	let remainingFiles = candidates.length;
	let remainingBytes = candidates.reduce((total, candidate) => total + candidate.size, 0);
	let deletedFiles = 0;
	let deletedBytes = 0;
	for (const candidate of candidates) {
		const expired = now - candidate.mtimeMs >= maxAgeMs;
		const overBudget = remainingFiles > maxFiles || remainingBytes > maxTotalBytes;
		if (!expired && !overBudget) break;
		if (candidate.protected) continue;
		try {
			unlinkSync(candidate.path);
			remainingFiles--;
			remainingBytes -= candidate.size;
			deletedFiles++;
			deletedBytes += candidate.size;
		} catch {
			// Another process may have reclaimed the same closed artifact.
		}
	}
	return { deletedFiles, deletedBytes };
}

// ============================================================================
// Types
// ============================================================================

export interface BashExecutorOptions {
	/** Callback for streaming output chunks (already sanitized) */
	onChunk?: (chunk: string) => void;
	/** AbortSignal for cancellation */
	signal?: AbortSignal;
}

export interface BashResult {
	/** Combined stdout + stderr output (sanitized, possibly truncated) */
	output: string;
	/** Process exit code (undefined if killed/cancelled) */
	exitCode: number | undefined;
	/** Whether the command was cancelled via signal */
	cancelled: boolean;
	/** Whether the output was truncated */
	truncated: boolean;
	/** Path to temp file containing full output (if output exceeded truncation threshold) */
	fullOutputPath?: string;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Execute a bash command using custom BashOperations.
 * Used for remote execution (SSH, containers, etc.).
 */
export async function executeBashWithOperations(
	command: string,
	cwd: string,
	operations: BashOperations,
	options?: BashExecutorOptions,
): Promise<BashResult> {
	const outputChunks: string[] = [];
	let outputBytes = 0;
	const maxOutputBytes = DEFAULT_MAX_BYTES * 2;

	let tempFilePath: string | undefined;
	let tempFileStream: BufferedBoundedLog | undefined;
	let totalBytes = 0;

	const ensureTempFile = () => {
		if (tempFilePath) {
			return;
		}
		try {
			cleanupBashFullOutputFiles();
		} catch {
			// Full-output retention is best-effort and must not fail a command.
		}
		const id = randomBytes(8).toString("hex");
		tempFilePath = join(tmpdir(), `pi-bash-${process.pid}-${id}.log`);
		ACTIVE_BASH_FULL_OUTPUTS.add(tempFilePath);
		const stream = createWriteStream(tempFilePath, { flags: "wx", mode: 0o600 });
		tempFileStream = new BufferedBoundedLog(stream, { maxBytes: BASH_FULL_OUTPUT_MAX_BYTES });
		stream.on("error", () => {});
		const release = () => {
			if (tempFilePath) ACTIVE_BASH_FULL_OUTPUTS.delete(tempFilePath);
		};
		stream.once("close", release);
		stream.once("error", release);
		for (const chunk of outputChunks) {
			tempFileStream.write(chunk);
		}
	};

	const decoder = new TextDecoder();

	const onData = (data: Buffer) => {
		totalBytes += data.length;

		// Sanitize: strip ANSI, replace binary garbage, normalize newlines
		const text = sanitizeBinaryOutput(stripAnsi(decoder.decode(data, { stream: true }))).replace(/\r/g, "");

		// Start writing to temp file if exceeds threshold
		if (totalBytes > DEFAULT_MAX_BYTES) {
			ensureTempFile();
		}

		if (tempFileStream) {
			tempFileStream.write(text);
		}

		// Keep rolling buffer
		outputChunks.push(text);
		outputBytes += text.length;
		while (outputBytes > maxOutputBytes && outputChunks.length > 1) {
			const removed = outputChunks.shift()!;
			outputBytes -= removed.length;
		}

		// Stream to callback
		if (options?.onChunk) {
			options.onChunk(text);
		}
	};

	try {
		const result = await operations.exec(command, cwd, {
			onData,
			signal: options?.signal,
		});

		const fullOutput = outputChunks.join("");
		const truncationResult = truncateTail(fullOutput);
		if (truncationResult.truncated) {
			ensureTempFile();
		}
		if (tempFileStream) {
			tempFileStream.end();
		}
		const cancelled = options?.signal?.aborted ?? false;

		return {
			output: truncationResult.truncated ? truncationResult.content : fullOutput,
			exitCode: cancelled ? undefined : (result.exitCode ?? undefined),
			cancelled,
			truncated: truncationResult.truncated,
			fullOutputPath: tempFilePath,
		};
	} catch (err) {
		// Check if it was an abort
		if (options?.signal?.aborted) {
			const fullOutput = outputChunks.join("");
			const truncationResult = truncateTail(fullOutput);
			if (truncationResult.truncated) {
				ensureTempFile();
			}
			if (tempFileStream) {
				tempFileStream.end();
			}
			return {
				output: truncationResult.truncated ? truncationResult.content : fullOutput,
				exitCode: undefined,
				cancelled: true,
				truncated: truncationResult.truncated,
				fullOutputPath: tempFilePath,
			};
		}

		if (tempFileStream) {
			tempFileStream.end();
		}

		throw err;
	}
}
