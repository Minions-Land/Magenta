import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	exportPublicSnapshot,
	interoperabilityLineSha256,
	PublicSnapshotError,
	sha256Bytes,
} from "./export-public-snapshot.mjs";

function git(root, args) {
	const result = spawnSync("git", ["-C", root, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

function fixture(extraFiles = {}) {
	const parent = mkdtempSync(join(tmpdir(), "magenta-public-snapshot-test-"));
	const root = join(parent, "private");
	mkdirSync(root);
	const files = {
		LICENSE: "Reviewed license text\n",
		NOTICE: "Reviewed notice text\n",
		"README.md": "# Demo\nCodex is supported only as an interoperability contract.\n",
		"src/index.js": "export const answer = 42;\n",
		...extraFiles,
	};
	for (const [relativePath, content] of Object.entries(files)) {
		const path = join(root, relativePath);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}
	git(root, ["init", "--initial-branch=main"]);
	git(root, ["config", "user.name", "Private Source"]);
	git(root, ["config", "user.email", "private@example.test"]);
	git(root, ["add", "--all"]);
	git(root, ["commit", "-m", "private snapshot"]);
	const commit = git(root, ["rev-parse", "HEAD"]);
	const policyPath = join(parent, "reviewed-policy.json");
	const policy = {
		schemaVersion: 1,
		approval: {
			reviewed: true,
			reviewedBy: ["release-owner"],
			reviewedSourceCommit: commit,
			reviewTicket: "SEC-100",
		},
		target: {
			owner: "PublicOwner",
			repository: "MagentaPublic",
			rootCommitOwner: { name: "Public Release", email: "release@example.test" },
		},
		approvedRepositoryOwners: ["PublicOwner"],
		approvedCommitOwners: [{ name: "Public Release", email: "release@example.test" }],
		include: ["LICENSE", "NOTICE", "README.md", "src"],
		exclude: [],
		requiredLegalFiles: [
			{ path: "LICENSE", sha256: sha256Bytes(Buffer.from(files.LICENSE)) },
			{ path: "NOTICE", sha256: sha256Bytes(Buffer.from(files.NOTICE)) },
		],
		packageRootPrefixes: ["packages"],
		approvedPackageRoots: [],
		allowedBinaryFiles: [],
		interoperabilityAllowlist: [
			{
				path: "README.md",
				line: 2,
				term: "Codex",
				lineSha256: interoperabilityLineSha256("Codex is supported only as an interoperability contract."),
				justification: "Documented read-only provider interoperability contract.",
			},
		],
		maxFileBytes: 1024 * 1024,
	};
	const writePolicy = (overrides = {}) => {
		const next = structuredClone(policy);
		for (const [key, value] of Object.entries(overrides)) next[key] = value;
		writeFileSync(policyPath, `${JSON.stringify(next, null, 2)}\n`);
		return policyPath;
	};
	writePolicy();
	return {
		commit,
		files,
		parent,
		policy,
		policyPath,
		root,
		writePolicy,
		cleanup() {
			rmSync(parent, { recursive: true, force: true });
		},
	};
}

const passGitleaks = ({ root }) => {
	assert.equal(readFileSync(join(root, "PUBLIC_SNAPSHOT_MANIFEST.json"), "utf8").includes("historyCopied"), true);
	return { ok: true, version: "test-gitleaks" };
};

function withEnvironment(overrides, fn) {
	const previous = new Map(Object.keys(overrides).map((name) => [name, process.env[name]]));
	try {
		for (const [name, value] of Object.entries(overrides)) process.env[name] = value;
		return fn();
	} finally {
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

test("dry-run audits a reviewed current root snapshot without creating output", () => {
	const env = fixture();
	try {
		const report = exportPublicSnapshot({
			sourceRoot: env.root,
			policyPath: env.policyPath,
			gitleaksRunner: passGitleaks,
		});
		assert.equal(report.dryRun, true);
		assert.equal(report.sourceCommit, env.commit);
		assert.equal(report.selectedFiles, 4);
		assert.equal(report.issues.length, 0);
		assert.equal(report.gitleaksVersion, "test-gitleaks");
		assert.deepEqual(
			report.manifest.files.map(({ path }) => path),
			["LICENSE", "NOTICE", "README.md", "src/index.js"],
		);
	} finally {
		env.cleanup();
	}
});

test("write mode creates one new root commit with no copied refs, remotes, or audit files", () => {
	const env = fixture({
		"docs/STABILITY_AUDIT.md": "private forensic evidence\n",
		"docs/guide.md": "public guide\n",
	});
	const output = join(env.parent, "public");
	try {
		env.policy.include.push("docs");
		env.writePolicy(env.policy);
		const report = exportPublicSnapshot({
			sourceRoot: env.root,
			policyPath: env.policyPath,
			dryRun: false,
			outputPath: output,
			gitleaksRunner: passGitleaks,
		});
		assert.equal(report.output, output);
		assert.equal(git(output, ["rev-list", "--count", "--all"]), "1");
		assert.equal(git(output, ["rev-list", "--parents", "--max-count=1", "HEAD"]).split(/\s+/u).length, 1);
		assert.equal(git(output, ["remote"]), "");
		assert.equal(git(output, ["tag", "--list"]), "");
		assert.equal(git(output, ["for-each-ref", "--format=%(refname)"]), "refs/heads/main");
		assert.equal(existsSync(join(output, ".git/hooks")), false);
		assert.equal(readFileSync(join(output, "docs/guide.md"), "utf8"), "public guide\n");
		assert.throws(() => readFileSync(join(output, "docs/STABILITY_AUDIT.md")), /ENOENT/u);
		const manifest = JSON.parse(readFileSync(join(output, "PUBLIC_SNAPSHOT_MANIFEST.json"), "utf8"));
		assert.equal(manifest.source.commit, env.commit);
		assert.equal(manifest.source.historyCopied, false);
		assert.equal(manifest.source.refsCopied, false);
	} finally {
		env.cleanup();
	}
});

test("write mode strips inherited Git author, config, object, index, and worktree overrides", () => {
	const env = fixture();
	const output = join(env.parent, "public");
	try {
		const report = withEnvironment(
			{
				GIT_ALTERNATE_OBJECT_DIRECTORIES: join(env.parent, "alternate-objects"),
				GIT_AUTHOR_EMAIL: "injected-author@example.test",
				GIT_AUTHOR_NAME: "Injected Author",
				GIT_COMMON_DIR: join(env.parent, "wrong-common-dir"),
				GIT_COMMITTER_EMAIL: "injected-committer@example.test",
				GIT_COMMITTER_NAME: "Injected Committer",
				GIT_CONFIG_COUNT: "2",
				GIT_CONFIG_KEY_0: "user.name",
				GIT_CONFIG_KEY_1: "user.email",
				GIT_CONFIG_VALUE_0: "Injected Config",
				GIT_CONFIG_VALUE_1: "injected-config@example.test",
				GIT_DIR: join(env.parent, "wrong-git-dir"),
				GIT_INDEX_FILE: join(env.parent, "wrong-index"),
				GIT_NAMESPACE: "wrong-namespace",
				GIT_OBJECT_DIRECTORY: join(env.parent, "wrong-objects"),
				GIT_WORK_TREE: join(env.parent, "wrong-worktree"),
			},
			() =>
				exportPublicSnapshot({
					sourceRoot: env.root,
					policyPath: env.policyPath,
					dryRun: false,
					outputPath: output,
					gitleaksRunner: passGitleaks,
				}),
		);

		assert.equal(report.output, output);
		assert.equal(
			git(output, ["show", "-s", "--format=%an%x00%ae%x00%cn%x00%ce", "HEAD"]),
			"Public Release\0release@example.test\0Public Release\0release@example.test",
		);
	} finally {
		env.cleanup();
	}
});

test("rejects non-portable policy paths before capture", () => {
	const env = fixture();
	const unsafePaths = [
		"src/trailing ",
		"src/trailing.",
		"src/control\nname.js",
		"src\\index.js",
		"src/../README.md",
		"src//index.js",
		"src/name:stream",
		"src/CON",
		"src/\u202eindex.js",
		"src/e\u0301.js",
	];
	try {
		const originalInclude = [...env.policy.include];
		for (const unsafePath of unsafePaths) {
			env.policy.include = [...originalInclude, unsafePath];
			env.writePolicy(env.policy);
			assert.throws(
				() =>
					exportPublicSnapshot({
						sourceRoot: env.root,
						policyPath: env.policyPath,
						gitleaksRunner: passGitleaks,
					}),
				/portable|canonical|escapes/u,
				unsafePath,
			);
		}
	} finally {
		env.cleanup();
	}
});

test("rejects an unsafe tracked path instead of rewriting it", { skip: process.platform === "win32" }, () => {
	const env = fixture({ "src/tracked ": "unsafe trailing-space name\n" });
	try {
		assert.throws(
			() =>
				exportPublicSnapshot({
					sourceRoot: env.root,
					policyPath: env.policyPath,
					gitleaksRunner: passGitleaks,
				}),
			/non-portable path component/u,
		);
	} finally {
		env.cleanup();
	}
});

test("commit verification rejects bytes changed after the reviewed capture", () => {
	const env = fixture();
	const output = join(env.parent, "public");
	try {
		assert.throws(
			() =>
				exportPublicSnapshot({
					sourceRoot: env.root,
					policyPath: env.policyPath,
					dryRun: false,
					outputPath: output,
					gitleaksRunner: ({ root }) => {
						writeFileSync(join(root, "src/index.js"), "export const answer = 'tampered';\n");
						return { ok: true, version: "test-gitleaks" };
					},
				}),
			/blob bytes differ from the reviewed snapshot/u,
		);
		assert.equal(existsSync(output), false);
	} finally {
		env.cleanup();
	}
});

test(
	"commit verification rejects a mode changed after the reviewed capture",
	{ skip: process.platform === "win32" },
	() => {
		const env = fixture();
		const output = join(env.parent, "public");
		try {
			assert.throws(
				() =>
					exportPublicSnapshot({
						sourceRoot: env.root,
						policyPath: env.policyPath,
						dryRun: false,
						outputPath: output,
						gitleaksRunner: ({ root }) => {
							chmodSync(join(root, "src/index.js"), 0o755);
							return { ok: true, version: "test-gitleaks" };
						},
					}),
				/tree differs from the reviewed snapshot|file mode differs from the reviewed snapshot/u,
			);
			assert.equal(existsSync(output), false);
		} finally {
			env.cleanup();
		}
	},
);

test("tree verification rejects an ignored file absent from the reviewed snapshot", () => {
	const env = fixture({ ".gitignore": "ignored.txt\n" });
	const output = join(env.parent, "public");
	try {
		env.policy.include.push(".gitignore");
		env.writePolicy(env.policy);
		assert.throws(
			() =>
				exportPublicSnapshot({
					sourceRoot: env.root,
					policyPath: env.policyPath,
					dryRun: false,
					outputPath: output,
					gitleaksRunner: ({ root }) => {
						writeFileSync(join(root, "ignored.txt"), "not reviewed\n");
						return { ok: true, version: "test-gitleaks" };
					},
				}),
			/tree file count|unexpected file/u,
		);
		assert.equal(existsSync(output), false);
	} finally {
		env.cleanup();
	}
});

test("rejects secrets, restricted terms, unapproved interoperability, packages, backups, and binaries", () => {
	const env = fixture({
		"README.md": [
			"# Unsafe",
			"Biomni package notes",
			"Codex without a reviewed line",
			`token = ghp_${"a".repeat(36)}`,
		].join("\n"),
		"artifact.bin": Buffer.from([0, 1, 2, 3]),
		"approved.wasm": Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
		"notes.bak": "old backup\n",
		"packages/unreviewed/index.js": "export default true;\n",
	});
	try {
		env.policy.include.push("approved.wasm", "artifact.bin", "notes.bak", "packages");
		env.policy.allowedBinaryFiles = [
			{
				path: "approved.wasm",
				sha256: sha256Bytes(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])),
				justification: "Explicit test-only binary review does not override the high-risk ban.",
			},
		];
		env.policy.interoperabilityAllowlist = [];
		env.writePolicy(env.policy);
		assert.throws(
			() =>
				exportPublicSnapshot({
					sourceRoot: env.root,
					policyPath: env.policyPath,
					gitleaksRunner: passGitleaks,
				}),
			(error) => {
				assert.equal(error instanceof PublicSnapshotError, true);
				const codes = new Set(error.issues.map(({ code }) => code));
				for (const code of [
					"binary",
					"dangerous-file",
					"high-risk-binary",
					"package-root",
					"restricted-term",
					"secret",
					"unapproved-interoperability",
				]) {
					assert.equal(codes.has(code), true, `missing ${code}`);
				}
				return true;
			},
		);
	} finally {
		env.cleanup();
	}
});

test("keeps LICENSE, NOTICE, owner, commit review, and gitleaks as hard gates", () => {
	const env = fixture();
	try {
		const invalid = structuredClone(env.policy);
		invalid.approval.reviewed = false;
		invalid.approval.reviewedSourceCommit = "f".repeat(40);
		invalid.approvedRepositoryOwners = [];
		invalid.approvedCommitOwners = [];
		invalid.requiredLegalFiles[0].sha256 = "0".repeat(64);
		env.writePolicy(invalid);
		assert.throws(
			() =>
				exportPublicSnapshot({
					sourceRoot: env.root,
					policyPath: env.policyPath,
					gitleaksRunner: () => ({ ok: false, code: "gitleaks-missing" }),
				}),
			(error) => {
				assert.equal(error instanceof PublicSnapshotError, true);
				const codes = new Set(error.issues.map(({ code }) => code));
				for (const code of ["approval", "owner", "legal", "gitleaks-missing"]) assert.equal(codes.has(code), true);
				return true;
			},
		);
	} finally {
		env.cleanup();
	}
});

test("write mode never overwrites an existing directory or writes inside the private source", () => {
	const env = fixture();
	try {
		const existing = join(env.parent, "existing");
		mkdirSync(existing);
		assert.throws(
			() =>
				exportPublicSnapshot({
					sourceRoot: env.root,
					policyPath: env.policyPath,
					dryRun: false,
					outputPath: existing,
					gitleaksRunner: passGitleaks,
				}),
			/already exists/u,
		);
		assert.throws(
			() =>
				exportPublicSnapshot({
					sourceRoot: env.root,
					policyPath: env.policyPath,
					dryRun: false,
					outputPath: join(env.root, "public"),
					gitleaksRunner: passGitleaks,
				}),
			/outside the private source/u,
		);
	} finally {
		env.cleanup();
	}
});
