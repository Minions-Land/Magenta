import { describe, expect, it } from "vitest";
import {
	createSshPathMapper,
	createSshToolOperations,
	resolveSshTarget,
	type SshCommandRunner,
} from "../../../modules/tools/ssh/magenta/ssh.ts";

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
		await expect(ops.read.detectImageMimeType("/local/project/image.png")).resolves.toBe("image/png");
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
});
