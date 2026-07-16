import { describe, expect, it, vi } from "vitest";
import {
	createSshPathMapper,
	createSshPtyCommandRunner,
	createSshToolOperations,
	resolveSshTarget,
	type SshCommandRunner,
	type SshPtyProcess,
	type SshPtySpawnOptions,
} from "../../../_magenta/env/ssh.ts";

function createRunner(
	handler: (
		remote: string,
		command: string,
		options?: Parameters<SshCommandRunner>[2],
	) => Partial<Awaited<ReturnType<SshCommandRunner>>>,
): SshCommandRunner {
	return async (remote, command, options) => ({
		stdout: Buffer.alloc(0),
		stderr: Buffer.alloc(0),
		exitCode: 0,
		timedOut: false,
		aborted: false,
		...handler(remote, command, options),
	});
}

class FakeSshPtyProcess implements SshPtyProcess {
	private dataListeners: Array<(data: string) => void> = [];
	private exitListeners: Array<(event: { exitCode: number; signal?: number }) => void> = [];
	killed = false;

	onData(listener: (data: string) => void) {
		this.dataListeners.push(listener);
		return { dispose: () => this.removeListener(this.dataListeners, listener) };
	}

	onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
		this.exitListeners.push(listener);
		return { dispose: () => this.removeListener(this.exitListeners, listener) };
	}

	kill() {
		this.killed = true;
		this.emitExit(1);
	}

	emitData(data: string) {
		for (const listener of [...this.dataListeners]) listener(data);
	}

	emitExit(exitCode: number) {
		for (const listener of [...this.exitListeners]) listener({ exitCode });
	}

	private removeListener<T>(listeners: T[], listener: T) {
		const index = listeners.indexOf(listener);
		if (index >= 0) listeners.splice(index, 1);
	}
}

describe("SSH path mapping", () => {
	it("maps local cwd paths into the remote cwd", () => {
		const map = createSshPathMapper("/local/project", "/remote/project");

		expect(map("/local/project")).toBe("/remote/project");
		expect(map("/local/project/src/index.ts")).toBe("/remote/project/src/index.ts");
		expect(map("src/index.ts")).toBe("/remote/project/src/index.ts");
	});

	it("rejects paths outside the mapped local cwd", () => {
		const map = createSshPathMapper("/local/project", "/remote/project");

		expect(() => map("/local/other/file.ts")).toThrow(/outside the mapped working directory/);
		expect(() => map("../other/file.ts")).toThrow(/outside the mapped working directory/);
	});
});

describe("SSH target resolution", () => {
	it("uses the explicit remote path when present", async () => {
		const target = await resolveSshTarget(
			"user@example:/workspace",
			createRunner(() => ({})),
		);

		expect(target).toEqual({ remote: "user@example", remoteCwd: "/workspace" });
	});

	it("uses remote pwd when no path is present", async () => {
		const commands: string[] = [];
		const target = await resolveSshTarget(
			"user@example",
			createRunner((_remote, command) => {
				commands.push(command);
				return { stdout: Buffer.from("/home/user\n") };
			}),
		);

		expect(commands).toEqual(["pwd"]);
		expect(target).toEqual({ remote: "user@example", remoteCwd: "/home/user" });
	});

	it("preserves a custom SSH port for explicit and resolved paths", async () => {
		const ports: Array<number | undefined> = [];
		const runner = createRunner((_remote, _command, options) => {
			ports.push(options?.port);
			return { stdout: Buffer.from("/home/user\n") };
		});

		await expect(resolveSshTarget("user@example:/workspace", runner, 23915)).resolves.toEqual({
			remote: "user@example",
			remoteCwd: "/workspace",
			port: 23915,
		});
		await expect(resolveSshTarget("user@example", runner, 23915)).resolves.toEqual({
			remote: "user@example",
			remoteCwd: "/home/user",
			port: 23915,
		});
		expect(ports).toEqual([23915]);
	});
});

describe("SSH tool operations", () => {
	it("creates read, write, edit, and bash operations using quoted remote paths", async () => {
		const calls: Array<{ remote: string; command: string }> = [];
		const runner = createRunner((remote, command, options) => {
			calls.push({ remote, command });
			options?.onData?.(Buffer.from("streamed"));
			if (command.startsWith("file --mime-type")) return { stdout: Buffer.from("image/png\n") };
			return { stdout: Buffer.from("ok"), exitCode: command.includes("exit 7") ? 7 : 0 };
		});
		const ops = createSshToolOperations({ remote: "user@example", remoteCwd: "/remote/project" }, "/local/project", {
			runner,
		});
		const chunks: string[] = [];

		await ops.read.access("/local/project/src/a file.ts");
		await expect(ops.read.detectImageMimeType!("/local/project/image.png")).resolves.toBe("image/png");
		await ops.write.mkdir("/local/project/src");
		await ops.write.writeFile("/local/project/src/a file.ts", "hello");
		await ops.edit.readFile("/local/project/src/a file.ts");
		const bashResult = await ops.bash.exec("echo hi; exit 7", "/local/project", {
			onData: (data) => chunks.push(data.toString()),
		});

		expect(bashResult.exitCode).toBe(7);
		expect(chunks).toContain("streamed");
		expect(calls).toEqual([
			{ remote: "user@example", command: "test -r '/remote/project/src/a file.ts'" },
			{ remote: "user@example", command: "file --mime-type -b '/remote/project/image.png'" },
			{ remote: "user@example", command: "mkdir -p '/remote/project/src'" },
			{
				remote: "user@example",
				command: "printf %s 'aGVsbG8=' | base64 -d > '/remote/project/src/a file.ts'",
			},
			{ remote: "user@example", command: "cat '/remote/project/src/a file.ts'" },
			{ remote: "user@example", command: "cd '/remote/project' && echo hi; exit 7" },
		]);
	});

	it("passes a custom port through all SSH-backed tool operations", async () => {
		const ports: Array<number | undefined> = [];
		const runner = createRunner((_remote, command, options) => {
			ports.push(options?.port);
			return { stdout: Buffer.from(command.startsWith("file --mime-type") ? "text/plain\n" : "ok") };
		});
		const ops = createSshToolOperations(
			{ remote: "user@example", remoteCwd: "/remote/project", port: 23915 },
			"/local/project",
			{ runner },
		);

		await ops.read.access("/local/project/file.txt");
		await ops.write.mkdir("/local/project/tmp");
		await ops.bash.exec("true", "/local/project", { onData: () => {} });
		expect(ports).toEqual([23915, 23915, 23915]);
	});

	it("can route bash through a separate runner without changing file operations", async () => {
		const fileCalls: string[] = [];
		const bashCalls: string[] = [];
		const fileRunner = createRunner((_remote, command) => {
			fileCalls.push(command);
			return { stdout: Buffer.from("ok") };
		});
		const bashRunner = createRunner((_remote, command) => {
			bashCalls.push(command);
			return { stdout: Buffer.from("bash"), exitCode: 9 };
		});
		const ops = createSshToolOperations({ remote: "user@example", remoteCwd: "/remote/project" }, "/local/project", {
			bashRunner,
			runner: fileRunner,
		});

		await ops.read.access("/local/project/src/file.ts");
		const result = await ops.bash.exec("exit 9", "/local/project", { onData: () => {} });

		expect(result.exitCode).toBe(9);
		expect(fileCalls).toEqual(["test -r '/remote/project/src/file.ts'"]);
		expect(bashCalls).toEqual(["cd '/remote/project' && exit 9"]);
	});
});

describe("SSH PTY runner", () => {
	it("spawns ssh with forced TTY allocation and streams PTY output", async () => {
		const fakeProcess = new FakeSshPtyProcess();
		const spawnCalls: Array<{ file: string; args: string[]; options: SshPtySpawnOptions }> = [];
		const runner = createSshPtyCommandRunner({
			spawn: (file, args, options) => {
				spawnCalls.push({ file, args, options });
				return fakeProcess;
			},
		});
		const chunks: string[] = [];
		const resultPromise = runner("user@example", "echo hi", {
			env: { TERM: "xterm-256color" },
			port: 23915,
			onData: (data) => chunks.push(data.toString()),
		});

		fakeProcess.emitData("hello\r\n");
		fakeProcess.emitExit(7);
		const result = await resultPromise;

		expect(spawnCalls).toEqual([
			{
				file: "ssh",
				args: ["-tt", "-p", "23915", "user@example", "echo hi"],
				options: {
					name: "xterm-256color",
					cols: 120,
					rows: 40,
					cwd: process.cwd(),
					env: { TERM: "xterm-256color" },
				},
			},
		]);
		expect(chunks).toEqual(["hello\r\n"]);
		expect(result).toEqual({
			stdout: Buffer.from("hello\r\n"),
			stderr: Buffer.alloc(0),
			exitCode: 7,
			timedOut: false,
			aborted: false,
		});
	});

	it("kills the PTY on timeout and reports the timeout", async () => {
		vi.useFakeTimers();
		try {
			const fakeProcess = new FakeSshPtyProcess();
			const runner = createSshPtyCommandRunner({
				spawn: () => fakeProcess,
			});
			const resultPromise = runner("user@example", "sleep 10", { timeout: 1 });

			await vi.advanceTimersByTimeAsync(1000);
			const result = await resultPromise;

			expect(fakeProcess.killed).toBe(true);
			expect(result.timedOut).toBe(true);
			expect(result.exitCode).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});
});
