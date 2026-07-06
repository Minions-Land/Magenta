import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { posix, relative, resolve } from "node:path";
import type { BashOperations } from "../../bash/pi/bash.ts";
import type { EditOperations } from "../../edit/pi/edit.ts";
import type { ReadOperations } from "../../read/pi/read.ts";
import type { WriteOperations } from "../../write/pi/write.ts";

const cjsRequire = createRequire(import.meta.url);
const SSH_PTY_COLUMNS = 120;
const SSH_PTY_ROWS = 40;

export type SshBashTerminalMode = "pipe" | "pty";

export interface SshPtyDisposable {
	dispose(): void;
}

export interface SshPtyProcess {
	onData(listener: (data: string) => void): SshPtyDisposable;
	onExit(listener: (event: { exitCode: number; signal?: number }) => void): SshPtyDisposable;
	kill(signal?: string): void;
}

export interface SshPtySpawnOptions {
	name: string;
	cols: number;
	rows: number;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export interface SshPtyFactory {
	spawn(file: string, args: string[], options: SshPtySpawnOptions): SshPtyProcess;
}

export interface SshTarget {
	remote: string;
	remoteCwd: string;
}

export interface SshCommandOptions {
	onData?: (data: Buffer) => void;
	signal?: AbortSignal;
	timeout?: number;
	env?: NodeJS.ProcessEnv;
}

export interface SshCommandResult {
	stdout: Buffer;
	stderr: Buffer;
	exitCode: number | null;
	timedOut: boolean;
	aborted: boolean;
}

export type SshCommandRunner = (
	remote: string,
	command: string,
	options?: SshCommandOptions,
) => Promise<SshCommandResult>;

export interface SshToolOperations {
	read: ReadOperations;
	write: WriteOperations;
	edit: EditOperations;
	bash: BashOperations;
}

export interface SshToolOperationsOptions {
	/**
	 * Runner for non-interactive SSH operations. Also used for bash when an
	 * explicit runner is provided and no bash-specific override is configured.
	 */
	runner?: SshCommandRunner;
	/** Runner used only by the SSH-backed bash tool. */
	bashRunner?: SshCommandRunner;
	/** Select the default SSH bash backend when no bashRunner is provided. */
	bashTerminal?: SshBashTerminalMode;
}

export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function createSshPathMapper(localCwd: string, remoteCwd: string): (path: string) => string {
	const localRoot = resolve(localCwd);
	const normalizedRemoteCwd = remoteCwd.replace(/\/+$/, "") || "/";
	return (path: string) => {
		const absolute = resolve(localRoot, path);
		const rel = relative(localRoot, absolute);
		if (rel === "") return normalizedRemoteCwd;
		if (rel.startsWith("..") || rel === ".." || posix.isAbsolute(rel)) {
			throw new Error(`SSH path is outside the mapped working directory: ${path}`);
		}
		return posix.join(normalizedRemoteCwd, ...rel.split(/[\\/]+/));
	};
}

export function runSshCommand(
	remote: string,
	command: string,
	options: SshCommandOptions = {},
): Promise<SshCommandResult> {
	return new Promise((resolveCommand, reject) => {
		const child = spawn("ssh", [remote, command], {
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let timedOut = false;
		let aborted = false;
		let settled = false;
		let timeoutHandle: NodeJS.Timeout | undefined;

		const cleanup = () => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			options.signal?.removeEventListener("abort", onAbort);
		};

		const settle = (result: SshCommandResult) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolveCommand(result);
		};

		const onAbort = () => {
			aborted = true;
			child.kill();
		};

		if (options.timeout !== undefined && options.timeout > 0) {
			timeoutHandle = setTimeout(() => {
				timedOut = true;
				child.kill();
			}, options.timeout * 1000);
		}

		if (options.signal?.aborted) {
			onAbort();
		} else {
			options.signal?.addEventListener("abort", onAbort, { once: true });
		}

		child.stdout.on("data", (data: Buffer) => {
			stdoutChunks.push(data);
			options.onData?.(data);
		});
		child.stderr.on("data", (data: Buffer) => {
			stderrChunks.push(data);
			options.onData?.(data);
		});
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		});
		child.on("close", (code) => {
			settle({
				stdout: Buffer.concat(stdoutChunks),
				stderr: Buffer.concat(stderrChunks),
				exitCode: code,
				timedOut,
				aborted,
			});
		});
	});
}

let cachedNodePty: SshPtyFactory | undefined;

function loadNodePty(): SshPtyFactory {
	if (cachedNodePty) return cachedNodePty;
	try {
		cachedNodePty = cjsRequire("node-pty") as SshPtyFactory;
		return cachedNodePty;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`SSH PTY execution requires node-pty to be installed: ${reason}`);
	}
}

export function createSshPtyCommandRunner(ptyFactory: SshPtyFactory): SshCommandRunner {
	return (remote, command, options: SshCommandOptions = {}) =>
		new Promise((resolveCommand, reject) => {
			const outputChunks: Buffer[] = [];
			let timedOut = false;
			let aborted = false;
			let settled = false;
			let timeoutHandle: NodeJS.Timeout | undefined;
			let dataDisposable: SshPtyDisposable | undefined;
			let exitDisposable: SshPtyDisposable | undefined;
			let ptyProcess: SshPtyProcess | undefined;

			const cleanup = () => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				dataDisposable?.dispose();
				exitDisposable?.dispose();
				options.signal?.removeEventListener("abort", onAbort);
			};

			const settle = (result: SshCommandResult) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolveCommand(result);
			};

			const killPty = () => {
				try {
					ptyProcess?.kill();
				} catch {
					// The PTY may already be exiting after a signal or timeout.
				}
			};

			const onAbort = () => {
				aborted = true;
				killPty();
			};

			try {
				ptyProcess = ptyFactory.spawn("ssh", ["-tt", remote, command], {
					name: "xterm-256color",
					cols: SSH_PTY_COLUMNS,
					rows: SSH_PTY_ROWS,
					cwd: process.cwd(),
					env: options.env ?? process.env,
				});
			} catch (error) {
				reject(error);
				return;
			}

			dataDisposable = ptyProcess.onData((data) => {
				const chunk = Buffer.from(data, "utf8");
				outputChunks.push(chunk);
				options.onData?.(chunk);
			});
			exitDisposable = ptyProcess.onExit(({ exitCode }) => {
				settle({
					stdout: Buffer.concat(outputChunks),
					stderr: Buffer.alloc(0),
					exitCode,
					timedOut,
					aborted,
				});
			});

			if (options.timeout !== undefined && options.timeout > 0) {
				timeoutHandle = setTimeout(() => {
					timedOut = true;
					killPty();
				}, options.timeout * 1000);
			}

			if (options.signal?.aborted) {
				onAbort();
			} else {
				options.signal?.addEventListener("abort", onAbort, { once: true });
			}
		});
}

export const runSshPtyCommand: SshCommandRunner = (remote, command, options) =>
	createSshPtyCommandRunner(loadNodePty())(remote, command, options);

export async function sshExec(
	remote: string,
	command: string,
	runner: SshCommandRunner = runSshCommand,
): Promise<Buffer> {
	const result = await runner(remote, command);
	if (result.exitCode !== 0) {
		throw new Error(`SSH failed (${result.exitCode}): ${result.stderr.toString()}`);
	}
	return result.stdout;
}

export async function resolveSshTarget(sshArg: string, runner: SshCommandRunner = runSshCommand): Promise<SshTarget> {
	const pathSeparator = sshArg.indexOf(":");
	if (pathSeparator >= 0) {
		const remote = sshArg.slice(0, pathSeparator);
		const remoteCwd = sshArg.slice(pathSeparator + 1) || "/";
		return { remote, remoteCwd };
	}

	const remote = sshArg;
	const remoteCwd = (await sshExec(remote, "pwd", runner)).toString().trim();
	return { remote, remoteCwd };
}

function createRemoteReadOps(target: SshTarget, localCwd: string, runner: SshCommandRunner): ReadOperations {
	const toRemote = createSshPathMapper(localCwd, target.remoteCwd);
	return {
		readFile: (path) => sshExec(target.remote, `cat ${shellQuote(toRemote(path))}`, runner),
		access: (path) => sshExec(target.remote, `test -r ${shellQuote(toRemote(path))}`, runner).then(() => {}),
		detectImageMimeType: async (path) => {
			try {
				const result = await sshExec(target.remote, `file --mime-type -b ${shellQuote(toRemote(path))}`, runner);
				const mimeType = result.toString().trim();
				return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mimeType) ? mimeType : null;
			} catch {
				return null;
			}
		},
	};
}

function createRemoteWriteOps(target: SshTarget, localCwd: string, runner: SshCommandRunner): WriteOperations {
	const toRemote = createSshPathMapper(localCwd, target.remoteCwd);
	return {
		writeFile: async (path, content) => {
			const encoded = Buffer.from(content).toString("base64");
			await sshExec(
				target.remote,
				`printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(toRemote(path))}`,
				runner,
			);
		},
		mkdir: (dir) => sshExec(target.remote, `mkdir -p ${shellQuote(toRemote(dir))}`, runner).then(() => {}),
	};
}

function createRemoteEditOps(target: SshTarget, localCwd: string, runner: SshCommandRunner): EditOperations {
	const read = createRemoteReadOps(target, localCwd, runner);
	const write = createRemoteWriteOps(target, localCwd, runner);
	return { readFile: read.readFile, access: read.access, writeFile: write.writeFile };
}

function createRemoteBashOps(target: SshTarget, localCwd: string, runner: SshCommandRunner): BashOperations {
	const toRemote = createSshPathMapper(localCwd, target.remoteCwd);
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			const remoteCommand = `cd ${shellQuote(toRemote(cwd))} && ${command}`;
			const result = await runner(target.remote, remoteCommand, { onData, signal, timeout, env });
			if (result.aborted) throw new Error("aborted");
			if (result.timedOut) throw new Error(`timeout:${timeout}`);
			return { exitCode: result.exitCode };
		},
	};
}

function resolveSshBashRunner(options: SshToolOperationsOptions, fallbackRunner: SshCommandRunner): SshCommandRunner {
	if (options.bashRunner) return options.bashRunner;
	if (options.bashTerminal === "pipe") return fallbackRunner;
	if (options.bashTerminal === "pty") return runSshPtyCommand;
	if (options.runner) return options.runner;
	return runSshPtyCommand;
}

export function createSshToolOperations(
	target: SshTarget,
	localCwd: string,
	options: SshToolOperationsOptions = {},
): SshToolOperations {
	const runner = options.runner ?? runSshCommand;
	const bashRunner = resolveSshBashRunner(options, runner);
	return {
		read: createRemoteReadOps(target, localCwd, runner),
		write: createRemoteWriteOps(target, localCwd, runner),
		edit: createRemoteEditOps(target, localCwd, runner),
		bash: createRemoteBashOps(target, localCwd, bashRunner),
	};
}
