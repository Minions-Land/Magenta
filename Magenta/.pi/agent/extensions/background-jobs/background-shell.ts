/**
 * Background shell tools.
 *
 * Starts long-running shell commands as session-scoped jobs, then lets the agent
 * poll, wait for completion, or cancel them without blocking a tool call forever.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendTail as appendTailText, formatDuration, RESULT_LIMIT_BYTES, shellQuote, timestampForFile, truncateTail } from "../shared/shell.ts";
import type { createJobsMonitor } from "./job-monitor.ts";

const LOG_DIR = join(homedir(), ".pi", "agent", "tmp", "background-shell");
const TERM_GRACE_MS = 3000;

type JobStatus = "running" | "exited" | "failed" | "timed_out" | "cancelled";
type ReturnDelivery = "steer" | "followUp" | "nextTurn";

type BackgroundShellConfig = {
	defaultTimeoutSeconds?: number;
	defaultWaitTimeoutSeconds?: number;
	defaultReturnToMain: boolean;
	defaultReturnDelivery: ReturnDelivery;
};

const shellConfig: BackgroundShellConfig = {
	defaultReturnToMain: false,
	defaultReturnDelivery: "followUp",
};

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function formatConfig(config: BackgroundShellConfig): string {
	return [
		"Background shell configuration:",
		`defaultTimeoutSeconds: ${config.defaultTimeoutSeconds ?? "none"}`,
		`defaultWaitTimeoutSeconds: ${config.defaultWaitTimeoutSeconds ?? "none"}`,
		`defaultReturnToMain: ${config.defaultReturnToMain}`,
		`defaultReturnDelivery: ${config.defaultReturnDelivery}`,
	].join("\n");
}

type BackgroundJob = {
	id: string;
	command: string;
	cwd: string;
	label?: string;
	logPath: string;
	child: ChildProcessWithoutNullStreams;
	log: WriteStream;
	startedAt: number;
	endedAt?: number;
	status: JobStatus;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	error?: string;
	tail: string;
	timeout?: NodeJS.Timeout;
	waiters: Array<() => void>;
};

function appendTail(job: BackgroundJob, data: Buffer): void {
	job.tail = appendTailText(job.tail, data);
}

function killProcessGroup(job: BackgroundJob, signal: NodeJS.Signals): void {
	const pid = job.child.pid;
	if (!pid) return;

	try {
		process.kill(-pid, signal);
	} catch {
		try {
			job.child.kill(signal);
		} catch {
			// Process already exited.
		}
	}
}

function finishJob(job: BackgroundJob, status: JobStatus, exitCode: number | null, signal: NodeJS.Signals | null, error?: string): void {
	if (job.status !== "running") return;

	job.status = status;
	job.exitCode = exitCode;
	job.signal = signal;
	job.error = error;
	job.endedAt = Date.now();
	if (job.timeout) clearTimeout(job.timeout);
	if (!job.log.writableEnded && !job.log.destroyed) job.log.end();

	const waiters = job.waiters.splice(0);
	for (const resolveWaiter of waiters) resolveWaiter();
}

function summarizeJob(job: BackgroundJob, includeOutput = true): string {
	const elapsedUntil = job.endedAt ?? Date.now();
	const output = truncateTail(job.tail.trimEnd());
	const lines = [
		`Job: ${job.id}${job.label ? ` (${job.label})` : ""}`,
		`Status: ${job.status}`,
		`Command: ${job.command}`,
		`CWD: ${job.cwd}`,
		`Elapsed: ${formatDuration(elapsedUntil - job.startedAt)}`,
		`Exit code: ${job.exitCode ?? "n/a"}`,
		`Signal: ${job.signal ?? "n/a"}`,
		`Log: ${job.logPath}`,
	];
	if (job.error) lines.push(`Error: ${job.error}`);
	if (includeOutput) {
		lines.push("", output.truncated ? `[Output truncated to last ${RESULT_LIMIT_BYTES} bytes]` : "Output:", output.text || "(no output yet)");
	}
	return lines.join("\n");
}

function waitForJob(job: BackgroundJob, timeoutSeconds: number | undefined, signal: AbortSignal | undefined): Promise<"done" | "timeout" | "aborted"> {
	if (job.status !== "running") return Promise.resolve("done");
	if (signal?.aborted) return Promise.resolve("aborted");

	return new Promise((resolveWait) => {
		let settled = false;
		let timer: NodeJS.Timeout | undefined;
		let waiter: () => void;

		const done = (result: "done" | "timeout" | "aborted") => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			const index = job.waiters.indexOf(waiter);
			if (index >= 0) job.waiters.splice(index, 1);
			resolveWait(result);
		};

		const onAbort = () => done("aborted");
		waiter = () => done("done");
		job.waiters.push(waiter);
		signal?.addEventListener("abort", onAbort, { once: true });

		if (timeoutSeconds && timeoutSeconds > 0) {
			timer = setTimeout(() => done("timeout"), timeoutSeconds * 1000);
		}
	});
}

type JobsMonitor = ReturnType<typeof createJobsMonitor>;

export function installBackgroundShell(pi: ExtensionAPI, jobsMonitor: JobsMonitor) {
	let nextJobNumber = 1;
	let shuttingDown = false;
	const jobs = new Map<string, BackgroundJob>();
	function cancelJob(id: string, ctx?: ExtensionContext): boolean {
		const job = jobs.get(id);
		if (!job || job.status !== "running") return false;
		finishJob(job, "cancelled", null, "SIGTERM", "Cancelled by background jobs UI");
		monitor.update(ctx);
		killProcessGroup(job, "SIGTERM");
		setTimeout(() => killProcessGroup(job, "SIGKILL"), TERM_GRACE_MS);
		return true;
	}

	const monitor = jobsMonitor.registerSource({
		id: "shell",
		title: "shell",
		getJobs: () => [...jobs.values()].map((job) => ({
			id: job.id,
			status: job.status,
			startedAt: job.startedAt,
			endedAt: job.endedAt,
			label: job.label ?? job.command,
			cwd: job.cwd,
			logPath: job.logPath,
			tail: job.tail,
			canCancel: job.status === "running",
		})),
		getJobDetails: (id) => {
			const job = jobs.get(id);
			if (!job) return [`unknown shell job: ${id}`];
			return [
				`command: ${job.command}`,
				`cwd: ${job.cwd}`,
				`log: ${job.logPath}`,
				`exit: ${job.exitCode ?? "n/a"}`,
				`signal: ${job.signal ?? "n/a"}`,
				...(job.error ? [`error: ${job.error}`] : []),
			];
		},
		cancelJob,
	});

	function returnShellResultToMain(job: BackgroundJob, delivery: ReturnDelivery, instruction?: string): void {
		if (shuttingDown) return;
		const defaultInstruction =
			"Background shell job has completed. Read this returned result, use it to continue the original task, and do not ask the user to manually inspect the job id unless more information is needed.";
		pi.sendMessage(
			{
				customType: "bg-shell-return",
				content: `${instruction?.trim() || defaultInstruction}\n\n${summarizeJob(job)}`,
				display: true,
				details: { id: job.id, status: job.status, exitCode: job.exitCode, logPath: job.logPath },
			},
			{ deliverAs: delivery, triggerTurn: delivery !== "nextTurn" },
		);
	}

	function scheduleReturnToMain(job: BackgroundJob, delivery: ReturnDelivery, instruction?: string): void {
		void waitForJob(job, undefined, undefined)
			.then(() => returnShellResultToMain(job, delivery, instruction))
			.catch(() => undefined);
	}

	pi.registerTool({
		name: "bg_shell",
		label: "Background Shell",
		description: "Manage non-interactive shell commands as background jobs. Use action=start for long-running commands; set returnToMain=true to automatically send the completed result back to the main agent. Use action=status to inspect jobs, action=wait to wait, action=cancel to terminate a running job, and action=config to inspect or update session defaults.",
		promptSnippet: "Start, inspect, wait for, or cancel long-running shell commands as background jobs",
		promptGuidelines: [
			"Use bg_shell action=start for long-running commands such as builds, tests, dev servers, migrations, downloads, or commands expected to take more than about 10 seconds.",
			"Use the regular bash tool for short one-off shell commands.",
			"After bg_shell action=start, either call bg_shell action=status/action=wait before relying on the command result, or set returnToMain=true so the result is automatically returned as a follow-up to the main agent.",
			"Do not use bg_shell action=start for commands that require interactive stdin.",
		],
		parameters: Type.Object({
			action: StringEnum(["start", "status", "wait", "cancel", "config"] as const),
			command: Type.Optional(Type.String({ description: "Shell command to run for action=start." })),
			cwd: Type.Optional(Type.String({ description: "Working directory for action=start. Relative paths are resolved against the current cwd." })),
			timeoutSeconds: Type.Optional(Type.Number({ description: "Optional maximum runtime for action=start. If exceeded, the job is terminated and marked timed_out." })),
			label: Type.Optional(Type.String({ description: "Optional human-readable label for action=start." })),
			returnToMain: Type.Optional(Type.Boolean({ description: "For action=start, automatically send the completed job result back to the main agent and trigger continuation. Default: false." })),
			returnDelivery: Type.Optional(StringEnum(["steer", "followUp", "nextTurn"] as const, { description: "Delivery mode when returnToMain=true. Default: followUp." })),
			returnInstruction: Type.Optional(Type.String({ description: "Optional instruction prepended to the automatic return message for the parent agent." })),
			jobId: Type.Optional(Type.String({ description: "Job id for action=status/wait/cancel. Omit for action=status to list all jobs." })),
			waitTimeoutSeconds: Type.Optional(Type.Number({ description: "Maximum time to wait for action=wait. If omitted, uses configured default or waits until completion/tool cancellation." })),
			defaultTimeoutSeconds: Type.Optional(Type.Number({ description: "For action=config: set default maximum runtime for future start calls. Use <=0 to clear." })),
			defaultWaitTimeoutSeconds: Type.Optional(Type.Number({ description: "For action=config: set default maximum wait time for future wait calls. Use <=0 to clear." })),
			defaultReturnToMain: Type.Optional(Type.Boolean({ description: "For action=config: default returnToMain for future start calls." })),
			defaultReturnDelivery: Type.Optional(StringEnum(["steer", "followUp", "nextTurn"] as const, { description: "For action=config: default delivery mode when automatic return is enabled." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const action = params.action;
			const returnToMain = params.returnToMain ?? shellConfig.defaultReturnToMain;
			const returnDelivery = (params.returnDelivery ?? shellConfig.defaultReturnDelivery) as ReturnDelivery;
			const returnInstruction = params.returnInstruction as string | undefined;

			if (action === "config") {
				if ("defaultTimeoutSeconds" in params) shellConfig.defaultTimeoutSeconds = positiveNumber(params.defaultTimeoutSeconds);
				if ("defaultWaitTimeoutSeconds" in params) shellConfig.defaultWaitTimeoutSeconds = positiveNumber(params.defaultWaitTimeoutSeconds);
				if (typeof params.defaultReturnToMain === "boolean") shellConfig.defaultReturnToMain = params.defaultReturnToMain;
				if (params.defaultReturnDelivery) shellConfig.defaultReturnDelivery = params.defaultReturnDelivery as ReturnDelivery;
				return { content: [{ type: "text", text: formatConfig(shellConfig) }], details: { ...shellConfig } };
			}

			if (action === "start") {
				if (!params.command) throw new Error("bg_shell action=start requires command");
				if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled before start" }], details: {} };

				await mkdir(LOG_DIR, { recursive: true });

				const id = `bg_${String(nextJobNumber++).padStart(3, "0")}`;
				const cwd = resolve(ctx.cwd, params.cwd ?? ".");
				const logPath = join(LOG_DIR, `${id}-${timestampForFile()}.log`);
				const log = createWriteStream(logPath, { flags: "a" });
				const shell = process.env.SHELL || "/bin/bash";
				const child = spawn(shell, ["-lc", params.command], {
					cwd,
					detached: true,
					stdio: ["ignore", "pipe", "pipe"],
					env: process.env,
				});

				const job: BackgroundJob = {
					id,
					command: params.command,
					cwd,
					label: params.label,
					logPath,
					child,
					log,
					startedAt: Date.now(),
					status: "running",
					exitCode: null,
					signal: null,
					tail: "",
					waiters: [],
				};
				jobs.set(id, job);
				monitor.update(ctx);

				log.write(`$ cd ${shellQuote(cwd)} && ${params.command}\n\n`);
				child.stdout.on("data", (data: Buffer) => {
					if (!log.writableEnded && !log.destroyed) log.write(data);
					appendTail(job, data);
				});
				child.stderr.on("data", (data: Buffer) => {
					if (!log.writableEnded && !log.destroyed) log.write(data);
					appendTail(job, data);
				});
				child.on("error", (error) => {
					finishJob(job, "failed", null, null, error.message);
					monitor.update(ctx);
				});
				child.on("close", (code, closeSignal) => {
					const timedOut = job.status === "timed_out";
					const cancelled = job.status === "cancelled";
					if (timedOut || cancelled) return;
					finishJob(job, code === 0 ? "exited" : "failed", code, closeSignal);
					monitor.update(ctx);
					try {
						ctx.ui.notify(`Background job ${id} finished: ${job.status}${code === null ? "" : ` (${code})`}`, code === 0 ? "info" : "warning");
					} catch {
						// UI may no longer be available.
					}
				});

				const timeoutSeconds = positiveNumber(params.timeoutSeconds) ?? shellConfig.defaultTimeoutSeconds;
				if (timeoutSeconds) {
					job.timeout = setTimeout(() => {
						finishJob(job, "timed_out", null, "SIGTERM", `Timed out after ${timeoutSeconds}s`);
						monitor.update(ctx);
						killProcessGroup(job, "SIGTERM");
						setTimeout(() => killProcessGroup(job, "SIGKILL"), TERM_GRACE_MS);
					}, timeoutSeconds * 1000);
				}

				if (returnToMain) scheduleReturnToMain(job, returnDelivery, returnInstruction);

				return {
					content: [{ type: "text", text: `Started background job ${id}${returnToMain ? " with automatic return to main agent" : ""}\nCommand: ${params.command}\nCWD: ${cwd}\nLog: ${logPath}${timeoutSeconds ? `\nTimeout: ${timeoutSeconds}s` : ""}` }],
					details: { id, command: params.command, cwd, logPath, status: "running", returnsToMain: returnToMain, timeoutSeconds },
				};
			}

			if (action === "status") {
				if (!params.jobId) {
					const lines = [...jobs.values()].map((job) => {
						const elapsedUntil = job.endedAt ?? Date.now();
						return `${job.id}\t${job.status}\t${formatDuration(elapsedUntil - job.startedAt)}\t${job.label ?? job.command}`;
					});
					return { content: [{ type: "text", text: lines.length ? lines.join("\n") : "No background jobs." }], details: { jobs: lines.length } };
				}

				const job = jobs.get(params.jobId);
				if (!job) throw new Error(`Unknown background job: ${params.jobId}`);
				return { content: [{ type: "text", text: summarizeJob(job) }], details: { id: job.id, status: job.status, exitCode: job.exitCode, logPath: job.logPath } };
			}

			if (action === "wait") {
				if (!params.jobId) throw new Error("bg_shell action=wait requires jobId");
				const job = jobs.get(params.jobId);
				if (!job) throw new Error(`Unknown background job: ${params.jobId}`);

				const waitTimeoutSeconds = positiveNumber(params.waitTimeoutSeconds) ?? shellConfig.defaultWaitTimeoutSeconds;
				const result = await waitForJob(job, waitTimeoutSeconds, signal);
				if (result === "aborted") return { content: [{ type: "text", text: `Wait cancelled. Job ${job.id} is still ${job.status}.\nLog: ${job.logPath}` }], details: { id: job.id, status: job.status } };
				if (result === "timeout") return { content: [{ type: "text", text: `Wait timed out. Job ${job.id} is still running.\n\n${summarizeJob(job)}` }], details: { id: job.id, status: job.status, logPath: job.logPath } };

				return { content: [{ type: "text", text: summarizeJob(job) }], details: { id: job.id, status: job.status, exitCode: job.exitCode, logPath: job.logPath } };
			}

			if (action === "cancel") {
				if (!params.jobId) throw new Error("bg_shell action=cancel requires jobId");
				const job = jobs.get(params.jobId);
				if (!job) throw new Error(`Unknown background job: ${params.jobId}`);
				if (job.status !== "running") return { content: [{ type: "text", text: `Job ${job.id} is already ${job.status}.` }], details: { id: job.id, status: job.status } };

				cancelJob(job.id, ctx);
				return { content: [{ type: "text", text: `Cancelled background job ${job.id}.\nLog: ${job.logPath}` }], details: { id: job.id, status: job.status, logPath: job.logPath } };
			}

			throw new Error(`Unsupported bg_shell action: ${action}`);
		},
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		for (const job of jobs.values()) {
			if (job.status !== "running") continue;
			finishJob(job, "cancelled", null, "SIGTERM", "Cancelled by session shutdown");
			killProcessGroup(job, "SIGTERM");
			setTimeout(() => killProcessGroup(job, "SIGKILL"), TERM_GRACE_MS);
		}
	});
}
