import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	isAtomicallyMaterializedExecutable,
	materializeContentAddressedExecutable,
	materializeExecutableAtomically,
} from "../_magenta/utils/pi/atomic-executable.ts";

describe("atomic executable materialization", () => {
	let root: string | undefined;

	afterEach(() => {
		if (root) rmSync(root, { force: true, recursive: true });
		root = undefined;
	});

	function fixture(): { destination: string; root: string } {
		root = mkdtempSync(join(tmpdir(), "magenta-atomic-executable-"));
		return { destination: join(root, ".magenta", "cache", "fd", "fd"), root };
	}

	it("installs once and leaves a matching executable untouched", () => {
		const target = fixture();
		const content = Buffer.from("verified helper bytes\n");
		materializeExecutableAtomically({ content, destinationPath: target.destination, trustedRoot: target.root });
		const before = statSync(target.destination, { bigint: true });

		materializeExecutableAtomically({ content, destinationPath: target.destination, trustedRoot: target.root });
		const after = statSync(target.destination, { bigint: true });

		expect(readFileSync(target.destination)).toEqual(content);
		expect(after.ino).toBe(before.ino);
		expect(after.mtimeNs).toBe(before.mtimeNs);
		expect(Number(after.mode & 0o111n)).not.toBe(0);
		expect(isAtomicallyMaterializedExecutable(target.destination, content)).toBe(true);
	});

	it("refuses destination and parent symlinks without touching their targets", () => {
		const target = fixture();
		const externalFile = join(target.root, "external-file");
		mkdirSync(join(target.root, ".magenta", "cache", "fd"), { recursive: true });
		writeFileSync(externalFile, "preserve me");
		symlinkSync(externalFile, target.destination);
		expect(() =>
			materializeExecutableAtomically({
				content: Buffer.from("replacement"),
				destinationPath: target.destination,
				trustedRoot: target.root,
			}),
		).toThrow(/not a regular file/u);
		expect(readFileSync(externalFile, "utf8")).toBe("preserve me");
		expect(lstatSync(target.destination).isSymbolicLink()).toBe(true);

		rmSync(target.destination);
		rmSync(join(target.root, ".magenta", "cache"), { recursive: true });
		const externalDirectory = join(target.root, "external-directory");
		mkdirSync(externalDirectory);
		symlinkSync(externalDirectory, join(target.root, ".magenta", "cache"), "dir");
		expect(() =>
			materializeExecutableAtomically({
				content: Buffer.from("replacement"),
				destinationPath: target.destination,
				trustedRoot: target.root,
			}),
		).toThrow(/not a real directory/u);
		expect(readdirSync(externalDirectory)).toEqual([]);
	});

	it("coalesces a same-content winner during the pre-rename race", () => {
		const target = fixture();
		const content = Buffer.from("one immutable helper\n");
		materializeExecutableAtomically({
			content,
			destinationPath: target.destination,
			testBeforeRename: () => {
				materializeExecutableAtomically({ content, destinationPath: target.destination, trustedRoot: target.root });
			},
			trustedRoot: target.root,
		});
		expect(readFileSync(target.destination)).toEqual(content);
		expect(readdirSync(join(target.root, ".magenta", "cache", "fd"))).toEqual(["fd"]);
	});

	it("never exposes partial bytes and removes failed or stale staging files", () => {
		const target = fixture();
		mkdirSync(join(target.root, ".magenta", "cache", "fd"), { recursive: true });
		writeFileSync(target.destination, "old complete helper");
		const next = Buffer.from("new complete helper payload\n");
		materializeExecutableAtomically({
			content: next,
			destinationPath: target.destination,
			testBeforeRename: () => {
				expect(readFileSync(target.destination, "utf8")).toBe("old complete helper");
			},
			trustedRoot: target.root,
		});
		expect(readFileSync(target.destination)).toEqual(next);

		const directory = join(target.root, ".magenta", "cache", "fd");
		expect(() =>
			materializeExecutableAtomically({
				content: Buffer.from("third helper"),
				destinationPath: target.destination,
				testBeforeRename: () => {
					throw new Error("simulated crash boundary");
				},
				trustedRoot: target.root,
			}),
		).toThrow(/simulated crash boundary/u);
		expect(readdirSync(directory).some((name) => name.includes(".magenta-tmp-"))).toBe(false);

		const stale = join(directory, ".fd.magenta-tmp-123-deadbeefdeadbeefdeadbeef");
		writeFileSync(stale, "crash residue", { mode: 0o700 });
		utimesSync(stale, new Date(0), new Date(0));
		materializeExecutableAtomically({
			content: next,
			destinationPath: target.destination,
			testNowMs: 2 * 24 * 60 * 60 * 1000,
			trustedRoot: target.root,
		});
		expect(existsSync(stale)).toBe(false);
	});

	it("coalesces concurrent same-content cache publication onto one immutable path", () => {
		const target = fixture();
		const cacheDirectory = join(target.root, ".magenta", "cache", "fd");
		const content = Buffer.from("same helper generation\n");
		let competingPath: string | undefined;
		const path = materializeContentAddressedExecutable({
			content,
			cacheDirectory,
			executableName: "fd",
			trustedRoot: target.root,
			testBeforeRename: () => {
				competingPath = materializeContentAddressedExecutable({
					content,
					cacheDirectory,
					executableName: "fd",
					trustedRoot: target.root,
				});
			},
		});

		expect(competingPath).toBe(path);
		expect(readFileSync(path)).toEqual(content);
		expect(readdirSync(cacheDirectory)).toHaveLength(1);
		expect(readdirSync(join(cacheDirectory, createHash("sha256").update(content).digest("hex")))).toEqual(["fd"]);
	});

	it("publishes concurrent different content to independent SHA-256 paths", () => {
		const target = fixture();
		const cacheDirectory = join(target.root, ".magenta", "cache", "rg");
		const first = Buffer.from("first helper generation\n");
		const second = Buffer.from("second helper generation\n");
		let secondPath: string | undefined;
		const firstPath = materializeContentAddressedExecutable({
			content: first,
			cacheDirectory,
			executableName: "rg",
			trustedRoot: target.root,
			testBeforeRename: () => {
				secondPath = materializeContentAddressedExecutable({
					content: second,
					cacheDirectory,
					executableName: "rg",
					trustedRoot: target.root,
				});
			},
		});

		expect(secondPath).toBeDefined();
		expect(secondPath).not.toBe(firstPath);
		expect(readFileSync(firstPath)).toEqual(first);
		expect(readFileSync(secondPath!)).toEqual(second);
		expect(readdirSync(cacheDirectory).sort()).toEqual(
			[first, second].map((content) => createHash("sha256").update(content).digest("hex")).sort(),
		);
	});

	it("refuses symlinked or group/world-writable cache parents", () => {
		const target = fixture();
		const content = Buffer.from("cache security boundary\n");
		const external = join(target.root, "external-cache");
		mkdirSync(join(target.root, ".magenta"));
		mkdirSync(external);
		symlinkSync(external, join(target.root, ".magenta", "cache"), "dir");
		expect(() =>
			materializeContentAddressedExecutable({
				content,
				cacheDirectory: join(target.root, ".magenta", "cache", "fd"),
				executableName: "fd",
				trustedRoot: target.root,
			}),
		).toThrow(/not a real directory/u);
		expect(readdirSync(external)).toEqual([]);

		if (process.platform === "win32") return;
		rmSync(join(target.root, ".magenta", "cache"));
		mkdirSync(join(target.root, ".magenta", "cache"));
		chmodSync(join(target.root, ".magenta", "cache"), 0o777);
		expect(() =>
			materializeContentAddressedExecutable({
				content,
				cacheDirectory: join(target.root, ".magenta", "cache", "fd"),
				executableName: "fd",
				trustedRoot: target.root,
			}),
		).toThrow(/group\/world-writable/u);
	});

	it("never replaces unexpected bytes at an existing content address", () => {
		const target = fixture();
		const content = Buffer.from("expected immutable helper\n");
		const digest = createHash("sha256").update(content).digest("hex");
		const cacheDirectory = join(target.root, ".magenta", "cache", "process-tools");
		const destination = join(cacheDirectory, digest, "magenta-process-tools");
		mkdirSync(join(cacheDirectory, digest), { mode: 0o700, recursive: true });
		writeFileSync(destination, "unexpected bytes", { mode: 0o755 });

		expect(() =>
			materializeContentAddressedExecutable({
				content,
				cacheDirectory,
				executableName: "magenta-process-tools",
				trustedRoot: target.root,
			}),
		).toThrow(/Immutable executable destination contains unexpected bytes/u);
		expect(readFileSync(destination, "utf8")).toBe("unexpected bytes");
	});
});
