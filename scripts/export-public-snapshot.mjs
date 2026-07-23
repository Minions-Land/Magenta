#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	existsSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const OWNER_PATTERN = /^[A-Za-z0-9_.-]+$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+$/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/u;
const UNSAFE_PATH_CHARACTERS = /[<>:"|?*\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const WINDOWS_RESERVED_BASENAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu;
const MAX_PORTABLE_PATH_BYTES = 4096;
const MAX_PORTABLE_COMPONENT_BYTES = 255;
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const GENERATED_MANIFEST = "PUBLIC_SNAPSHOT_MANIFEST.json";
const GENERATED_CHECKSUMS = "SHA256SUMS.public";
const GENERATED_PATH_KEYS = new Set(
	[GENERATED_MANIFEST, GENERATED_CHECKSUMS].map((path) => path.toLocaleLowerCase("en-US")),
);

// These paths are local evidence or generated state, not public product source.
const ALWAYS_EXCLUDED = [
	".git",
	".research",
	"coverage",
	"node_modules",
	"output",
	"docs/STABILITY_AUDIT.md",
	"HarnessComponentProtocol/eval/results",
];

// Split literals keep the exporter itself from requiring an interoperability
// exception when it is later included in a public source snapshot.
const RESTRICTED_TERMS = [
	["Bio", "mni"].join(""),
	["Pantheon", "OS"].join(""),
	["Bio", "mniBench"].join(""),
	["Panther", " OS"].join(""),
	["Bio", "Mesh"].join(""),
	["Bio", "MeshBatch"].join(""),
	["DA", " Code"].join(""),
	["Q", "-Less"].join(""),
];
const INTEROPERABILITY_TERMS = [["Co", "dex"].join(""), ["Claude", " Code"].join("")];

const NEVER_EXPORT_BASENAMES = new Set([
	".env",
	"id_dsa",
	"id_ecdsa",
	"id_ed25519",
	"id_rsa",
	"credentials",
	"credentials.json",
	"auth.json",
]);
const NEVER_EXPORT_SUFFIXES = [
	".bak",
	".backup",
	".der",
	".jks",
	".key",
	".keystore",
	".old",
	".orig",
	".p12",
	".pfx",
	".pem",
	".db",
	".dump",
	".log",
	".sqlite",
	".sqlite3",
	".swp",
	".tmp",
	"~",
];
const HIGH_RISK_BINARY_SUFFIXES = [
	".7z",
	".a",
	".dmg",
	".dll",
	".dylib",
	".exe",
	".gz",
	".node",
	".o",
	".rar",
	".so",
	".tar",
	".tgz",
	".wasm",
	".xz",
	".zip",
];
const BUILTIN_SECRET_RULES = [
	{ id: "github-classic-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/gu },
	{ id: "github-fine-grained-token", pattern: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/gu },
	{ id: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/gu },
	{ id: "private-key", pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/gu },
	{
		id: "assigned-secret",
		pattern:
			/\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)\b\s*[:=]\s*["']?[A-Za-z0-9_./+~-]{24,}/giu,
	},
];

export class PublicSnapshotError extends Error {
	constructor(issues, report) {
		super(`Public snapshot rejected by ${issues.length} audit gate${issues.length === 1 ? "" : "s"}.`);
		this.name = "PublicSnapshotError";
		this.issues = issues;
		this.report = report;
	}
}

export function sha256Bytes(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

export function interoperabilityLineSha256(line) {
	return sha256Bytes(Buffer.from(line.replace(/\r$/u, ""), "utf8"));
}

function stableJson(value) {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function normalizeRelativePath(value, label) {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${label} must be a non-empty relative path.`);
	}
	if (isAbsolute(value) || value.startsWith("/") || value.includes("\\")) {
		throw new Error(`${label} must use a portable relative path with forward-slash separators.`);
	}
	if (value !== value.normalize("NFC")) throw new Error(`${label} must use canonical NFC Unicode.`);
	if (Buffer.byteLength(value, "utf8") > MAX_PORTABLE_PATH_BYTES) {
		throw new Error(`${label} exceeds the portable path length limit.`);
	}
	const components = value.split("/");
	if (
		components.some((component) => component.length === 0 || component === "." || component === "..") ||
		posix.normalize(value) !== value
	) {
		throw new Error(`${label} escapes the repository root.`);
	}
	for (const component of components) {
		if (
			component.trim() !== component ||
			component.endsWith(".") ||
			UNSAFE_PATH_CHARACTERS.test(component) ||
			component.toLocaleLowerCase("en-US") === ".git" ||
			WINDOWS_RESERVED_BASENAME.test(component) ||
			Buffer.byteLength(component, "utf8") > MAX_PORTABLE_COMPONENT_BYTES
		) {
			throw new Error(`${label} contains a non-portable path component.`);
		}
	}
	return value;
}

function pathMatches(path, root) {
	return path === root || path.startsWith(`${root}/`);
}

function portablePathKey(path) {
	return path.normalize("NFC").toLocaleLowerCase("en-US");
}

function pathInside(root, candidate) {
	const fromRoot = relative(root, candidate);
	return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}

function readRegularFileWithoutFollowing(path, label) {
	const before = lstatSync(path);
	if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${label} must be a regular file.`);
	const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
	const descriptor = openSync(path, constants.O_RDONLY | noFollow);
	try {
		const opened = fstatSync(descriptor);
		if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
			throw new Error(`${label} changed while the snapshot was captured.`);
		}
		const bytes = readFileSync(descriptor);
		const afterOpen = fstatSync(descriptor);
		const afterPath = lstatSync(path);
		if (
			!afterOpen.isFile() ||
			afterOpen.dev !== opened.dev ||
			afterOpen.ino !== opened.ino ||
			afterOpen.size !== opened.size ||
			afterOpen.mtimeMs !== opened.mtimeMs ||
			afterOpen.mode !== opened.mode ||
			afterOpen.nlink !== opened.nlink ||
			!afterPath.isFile() ||
			afterPath.isSymbolicLink() ||
			afterPath.dev !== opened.dev ||
			afterPath.ino !== opened.ino ||
			afterPath.size !== opened.size ||
			afterPath.mtimeMs !== opened.mtimeMs ||
			afterPath.mode !== opened.mode ||
			afterPath.nlink !== opened.nlink
		) {
			throw new Error(`${label} changed while the snapshot was captured.`);
		}
		return bytes;
	} finally {
		closeSync(descriptor);
	}
}

function runCommand(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		encoding: "utf8",
		env: options.env ?? process.env,
		maxBuffer: 16 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`${options.label ?? command} failed with exit code ${result.status}.`);
	}
	return (result.stdout ?? "").trim();
}

function runCommandBytes(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		encoding: null,
		env: options.env ?? process.env,
		input: options.input,
		maxBuffer: 128 * 1024 * 1024,
		stdio: options.input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`${options.label ?? command} failed with exit code ${result.status}.`);
	}
	return Buffer.from(result.stdout ?? []);
}

function runGit(root, args, label = "git", env = isolatedGitEnvironment()) {
	return runCommand("git", ["-C", root, ...args], { env, label });
}

function runGitBytes(root, args, label = "git", env = isolatedGitEnvironment()) {
	return runCommandBytes("git", ["-C", root, ...args], { env, label });
}

function isolatedGitEnvironment() {
	const emptyConfig = process.platform === "win32" ? "NUL" : "/dev/null";
	const inherited = Object.fromEntries(
		Object.entries(process.env).filter(([name]) => !name.toLocaleUpperCase("en-US").startsWith("GIT_")),
	);
	return {
		...inherited,
		GIT_CONFIG_GLOBAL: emptyConfig,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_SYSTEM: emptyConfig,
		GIT_TEMPLATE_DIR: "",
	};
}

function splitNulRecords(bytes, label) {
	if (bytes.length === 0) return [];
	if (bytes.at(-1) !== 0) throw new Error(`${label} was not NUL-terminated.`);
	const records = [];
	let start = 0;
	for (let index = 0; index < bytes.length; index++) {
		if (bytes[index] !== 0) continue;
		if (index > start) records.push(bytes.subarray(start, index));
		start = index + 1;
	}
	return records;
}

function decodeGitPath(bytes, label) {
	let path;
	try {
		path = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new Error(`${label} is not valid UTF-8.`);
	}
	if (!Buffer.from(path, "utf8").equals(bytes)) throw new Error(`${label} is not canonical UTF-8.`);
	return normalizeRelativePath(path, label);
}

function parseTrackedFiles(root, env = isolatedGitEnvironment()) {
	const output = runGitBytes(root, ["ls-files", "-s", "-z"], "git tracked-file scan", env);
	return splitNulRecords(output, "git tracked-file scan").map((record) => {
		const tab = record.indexOf(0x09);
		if (tab <= 0) throw new Error("git returned malformed tracked-file metadata.");
		const metadata = record.subarray(0, tab).toString("ascii");
		const match = metadata.match(/^(\d{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([0-3])$/u);
		if (!match) throw new Error("git returned malformed tracked-file metadata.");
		return {
			mode: match[1],
			objectId: match[2],
			stage: Number(match[3]),
			path: decodeGitPath(record.subarray(tab + 1), "tracked path"),
		};
	});
}

function requireArray(value, label) {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
	return value;
}

function validateCommitOwner(value, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is required.`);
	if (typeof value.name !== "string" || value.name.trim().length === 0) throw new Error(`${label}.name is required.`);
	if (
		value.name !== value.name.trim() ||
		/[<>\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value.name) ||
		value.name.length > 200
	) {
		throw new Error(`${label}.name contains invalid identity data.`);
	}
	if (typeof value.email !== "string" || !EMAIL_PATTERN.test(value.email)) {
		throw new Error(`${label}.email must be a valid explicit address.`);
	}
	if (/[<>\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value.email) || value.email.length > 320) {
		throw new Error(`${label}.email contains invalid identity data.`);
	}
	return { name: value.name, email: value.email };
}

function validatePolicy(rawPolicy) {
	if (!rawPolicy || typeof rawPolicy !== "object" || Array.isArray(rawPolicy) || rawPolicy.schemaVersion !== 1) {
		throw new Error("Public snapshot policy schemaVersion must be 1.");
	}
	const approval = rawPolicy.approval;
	if (!approval || typeof approval !== "object" || Array.isArray(approval)) {
		throw new Error("Public snapshot policy approval is required.");
	}
	const target = rawPolicy.target;
	if (!target || typeof target !== "object" || Array.isArray(target)) {
		throw new Error("Public snapshot policy target is required.");
	}
	if (typeof target.owner !== "string" || !OWNER_PATTERN.test(target.owner)) {
		throw new Error("Public snapshot target.owner is invalid.");
	}
	if (typeof target.repository !== "string" || !REPOSITORY_PATTERN.test(target.repository)) {
		throw new Error("Public snapshot target.repository is invalid.");
	}
	const rootCommitOwner = validateCommitOwner(target.rootCommitOwner, "target.rootCommitOwner");
	const include = requireArray(rawPolicy.include, "include").map((path, index) =>
		normalizeRelativePath(path, `include[${index}]`),
	);
	if (include.length === 0) throw new Error("Public snapshot include allowlist must not be empty.");
	const exclude = requireArray(rawPolicy.exclude ?? [], "exclude").map((path, index) =>
		normalizeRelativePath(path, `exclude[${index}]`),
	);
	const approvedRepositoryOwners = requireArray(rawPolicy.approvedRepositoryOwners, "approvedRepositoryOwners").map(
		(owner, index) => {
			if (typeof owner !== "string" || !OWNER_PATTERN.test(owner)) {
				throw new Error(`approvedRepositoryOwners[${index}] is invalid.`);
			}
			return owner;
		},
	);
	const approvedCommitOwners = requireArray(rawPolicy.approvedCommitOwners, "approvedCommitOwners").map(
		(owner, index) => validateCommitOwner(owner, `approvedCommitOwners[${index}]`),
	);
	const requiredLegalFiles = requireArray(rawPolicy.requiredLegalFiles, "requiredLegalFiles").map((entry, index) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			throw new Error(`requiredLegalFiles[${index}] is invalid.`);
		}
		const path = normalizeRelativePath(entry.path, `requiredLegalFiles[${index}].path`);
		if (!SHA256_PATTERN.test(entry.sha256 ?? "")) {
			throw new Error(`requiredLegalFiles[${index}].sha256 must be a lowercase SHA-256 digest.`);
		}
		return { path, sha256: entry.sha256 };
	});
	const legalPaths = new Set(requiredLegalFiles.map(({ path }) => path));
	if (!legalPaths.has("LICENSE") || !legalPaths.has("NOTICE")) {
		throw new Error("requiredLegalFiles must pin root LICENSE and NOTICE files.");
	}
	const packageRootPrefixes = requireArray(rawPolicy.packageRootPrefixes ?? ["packages"], "packageRootPrefixes").map(
		(path, index) => normalizeRelativePath(path, `packageRootPrefixes[${index}]`),
	);
	const approvedPackageRoots = requireArray(rawPolicy.approvedPackageRoots, "approvedPackageRoots").map(
		(path, index) => normalizeRelativePath(path, `approvedPackageRoots[${index}]`),
	);
	const allowedBinaryFiles = requireArray(rawPolicy.allowedBinaryFiles ?? [], "allowedBinaryFiles").map(
		(entry, index) => {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
				throw new Error(`allowedBinaryFiles[${index}] is invalid.`);
			}
			const path = normalizeRelativePath(entry.path, `allowedBinaryFiles[${index}].path`);
			if (!SHA256_PATTERN.test(entry.sha256 ?? "")) {
				throw new Error(`allowedBinaryFiles[${index}].sha256 must be a lowercase SHA-256 digest.`);
			}
			if (typeof entry.justification !== "string" || entry.justification.trim().length < 12) {
				throw new Error(`allowedBinaryFiles[${index}].justification must describe the reviewed asset.`);
			}
			return { path, sha256: entry.sha256, justification: entry.justification.trim() };
		},
	);
	const interoperabilityAllowlist = requireArray(
		rawPolicy.interoperabilityAllowlist ?? [],
		"interoperabilityAllowlist",
	).map((entry, index) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			throw new Error(`interoperabilityAllowlist[${index}] is invalid.`);
		}
		const path = normalizeRelativePath(entry.path, `interoperabilityAllowlist[${index}].path`);
		if (!Number.isSafeInteger(entry.line) || entry.line <= 0) {
			throw new Error(`interoperabilityAllowlist[${index}].line must be a positive integer.`);
		}
		if (!INTEROPERABILITY_TERMS.includes(entry.term)) {
			throw new Error(`interoperabilityAllowlist[${index}].term is not an interoperability term.`);
		}
		if (!SHA256_PATTERN.test(entry.lineSha256 ?? "")) {
			throw new Error(`interoperabilityAllowlist[${index}].lineSha256 must be a lowercase SHA-256 digest.`);
		}
		if (typeof entry.justification !== "string" || entry.justification.trim().length < 12) {
			throw new Error(`interoperabilityAllowlist[${index}].justification must describe the contract.`);
		}
		return {
			path,
			line: entry.line,
			term: entry.term,
			lineSha256: entry.lineSha256,
			justification: entry.justification.trim(),
		};
	});
	const maxFileBytes = rawPolicy.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
	if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0 || maxFileBytes > 100 * 1024 * 1024) {
		throw new Error("maxFileBytes must be an integer between 1 and 104857600.");
	}
	return {
		schemaVersion: 1,
		approval: {
			reviewed: approval.reviewed === true,
			reviewedBy: requireArray(approval.reviewedBy, "approval.reviewedBy").map(String),
			reviewedSourceCommit: String(approval.reviewedSourceCommit ?? ""),
			reviewTicket: String(approval.reviewTicket ?? ""),
		},
		target: { owner: target.owner, repository: target.repository, rootCommitOwner },
		approvedRepositoryOwners,
		approvedCommitOwners,
		include: [...new Set(include)],
		exclude: [...new Set(exclude)],
		requiredLegalFiles,
		packageRootPrefixes: [...new Set(packageRootPrefixes)],
		approvedPackageRoots: [...new Set(approvedPackageRoots)],
		allowedBinaryFiles,
		interoperabilityAllowlist,
		maxFileBytes,
	};
}

function readPolicy(policyPath) {
	const bytes = readRegularFileWithoutFollowing(policyPath, "Public snapshot policy");
	let parsed;
	try {
		parsed = JSON.parse(bytes.toString("utf8"));
	} catch {
		throw new Error("Public snapshot policy is not valid JSON.");
	}
	return { bytes, policy: validatePolicy(parsed) };
}

function detectPackageRoot(path, prefixes) {
	for (const prefix of prefixes) {
		if (!path.startsWith(`${prefix}/`)) continue;
		const name = path.slice(prefix.length + 1).split("/")[0];
		if (name) return `${prefix}/${name}`;
	}
	return undefined;
}

function looksBinary(bytes) {
	const sample = bytes.subarray(0, Math.min(bytes.length, 8192));
	if (sample.includes(0)) return true;
	const hex = sample.subarray(0, 8).toString("hex");
	return (
		hex.startsWith("7f454c46") ||
		hex.startsWith("4d5a") ||
		hex.startsWith("cafebabe") ||
		hex.startsWith("cffaedfe") ||
		hex.startsWith("feedfacf") ||
		hex.startsWith("89504e470d0a1a0a") ||
		hex.startsWith("ffd8ff") ||
		hex.startsWith("47494638") ||
		hex.startsWith("255044462d") ||
		hex.startsWith("504b0304")
	);
}

function lineAt(content, index) {
	let line = 1;
	for (let cursor = 0; cursor < index; cursor++) if (content.charCodeAt(cursor) === 10) line++;
	return line;
}

function scanBuiltinSecrets(path, content, issues) {
	for (const rule of BUILTIN_SECRET_RULES) {
		rule.pattern.lastIndex = 0;
		for (const match of content.matchAll(rule.pattern)) {
			issues.push({ code: "secret", path, line: lineAt(content, match.index), detail: rule.id });
		}
	}
}

function scanSensitiveTerms(path, content, allowlist, usedAllowlist, issues) {
	const lines = content.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index].replace(/\r$/u, "");
		const lower = line.toLocaleLowerCase("en-US");
		for (const term of RESTRICTED_TERMS) {
			if (lower.includes(term.toLocaleLowerCase("en-US"))) {
				issues.push({ code: "restricted-term", path, line: index + 1, detail: term });
			}
		}
		for (const term of INTEROPERABILITY_TERMS) {
			if (!lower.includes(term.toLocaleLowerCase("en-US"))) continue;
			const key = `${path}\0${index + 1}\0${term}`;
			const approval = allowlist.get(key);
			if (!approval || approval.lineSha256 !== interoperabilityLineSha256(line)) {
				issues.push({ code: "unapproved-interoperability", path, line: index + 1, detail: term });
				continue;
			}
			usedAllowlist.add(key);
		}
	}
}

function scanSensitiveBytes(path, bytes, issues) {
	for (const term of RESTRICTED_TERMS) {
		if (bytes.includes(Buffer.from(term, "utf8"))) {
			issues.push({ code: "restricted-term", path, detail: term });
		}
	}
	for (const term of INTEROPERABILITY_TERMS) {
		if (bytes.includes(Buffer.from(term, "utf8"))) {
			issues.push({ code: "unapproved-interoperability", path, detail: term });
		}
	}
}

function auditPolicy(policy, sourceCommit, captured, issues) {
	if (!policy.approval.reviewed) issues.push({ code: "approval", detail: "policy is not owner-reviewed" });
	if (!COMMIT_PATTERN.test(policy.approval.reviewedSourceCommit)) {
		issues.push({ code: "approval", detail: "reviewedSourceCommit is not an exact commit" });
	} else if (policy.approval.reviewedSourceCommit !== sourceCommit) {
		issues.push({ code: "approval", detail: "reviewedSourceCommit does not match HEAD" });
	}
	if (policy.approval.reviewedBy.length === 0 || policy.approval.reviewTicket.trim().length < 4) {
		issues.push({ code: "approval", detail: "reviewer identities and review ticket are required" });
	}
	if (!policy.approvedRepositoryOwners.includes(policy.target.owner)) {
		issues.push({ code: "owner", detail: "target repository owner is not allowlisted" });
	}
	if (
		!policy.approvedCommitOwners.some(
			(owner) =>
				owner.name === policy.target.rootCommitOwner.name && owner.email === policy.target.rootCommitOwner.email,
		)
	) {
		issues.push({ code: "owner", detail: "root commit owner is not allowlisted" });
	}
	const capturedByPath = new Map(captured.map((file) => [file.path, file]));
	for (const legal of policy.requiredLegalFiles) {
		const file = capturedByPath.get(legal.path);
		if (!file) issues.push({ code: "legal", path: legal.path, detail: "required legal file is not selected" });
		else if (file.sha256 !== legal.sha256) {
			issues.push({ code: "legal", path: legal.path, detail: "legal file digest is not owner-approved" });
		}
	}
}

function auditCapturedFiles(policy, captured, issues) {
	const allowedBinaries = new Map(policy.allowedBinaryFiles.map((entry) => [entry.path, entry]));
	const usedBinaries = new Set();
	const interoperability = new Map(
		policy.interoperabilityAllowlist.map((entry) => [`${entry.path}\0${entry.line}\0${entry.term}`, entry]),
	);
	const usedInteroperability = new Set();
	const selectedPackageRoots = new Set();
	for (const file of captured) {
		const basename = posix.basename(file.path).toLocaleLowerCase("en-US");
		const lowerPath = file.path.toLocaleLowerCase("en-US");
		if (
			NEVER_EXPORT_BASENAMES.has(basename) ||
			basename.startsWith(".env.") ||
			NEVER_EXPORT_SUFFIXES.some((suffix) => lowerPath.endsWith(suffix))
		) {
			issues.push({ code: "dangerous-file", path: file.path, detail: "credential or backup-shaped path" });
		}
		if (file.bytes.length > policy.maxFileBytes) {
			issues.push({ code: "oversized-file", path: file.path, detail: `exceeds ${policy.maxFileBytes} bytes` });
		}
		const packageRoot = detectPackageRoot(file.path, policy.packageRootPrefixes);
		if (packageRoot) {
			selectedPackageRoots.add(packageRoot);
			if (!policy.approvedPackageRoots.includes(packageRoot)) {
				issues.push({ code: "package-root", path: file.path, detail: `${packageRoot} is not approved` });
			}
		}
		for (const term of RESTRICTED_TERMS) {
			if (lowerPath.includes(term.toLocaleLowerCase("en-US"))) {
				issues.push({ code: "restricted-package", path: file.path, detail: term });
			}
		}
		for (const term of INTEROPERABILITY_TERMS) {
			if (lowerPath.includes(term.toLocaleLowerCase("en-US"))) {
				issues.push({ code: "unapproved-interoperability", path: file.path, detail: term });
			}
		}
		const binary = looksBinary(file.bytes);
		const highRiskBinary = HIGH_RISK_BINARY_SUFFIXES.some((suffix) => lowerPath.endsWith(suffix));
		if (highRiskBinary) {
			issues.push({
				code: "high-risk-binary",
				path: file.path,
				detail: "executable or archive payload is forbidden",
			});
		}
		if (binary && !highRiskBinary) {
			const approval = allowedBinaries.get(file.path);
			if (!approval || approval.sha256 !== file.sha256) {
				issues.push({ code: "binary", path: file.path, detail: "binary asset lacks an exact digest approval" });
			} else {
				usedBinaries.add(file.path);
			}
		}
		if (!binary) {
			const content = file.bytes.toString("utf8");
			scanBuiltinSecrets(file.path, content, issues);
			scanSensitiveTerms(file.path, content, interoperability, usedInteroperability, issues);
		} else {
			scanSensitiveBytes(file.path, file.bytes, issues);
		}
	}
	for (const packageRoot of policy.approvedPackageRoots) {
		if (!selectedPackageRoots.has(packageRoot)) {
			issues.push({ code: "stale-package-approval", path: packageRoot, detail: "approved root is not selected" });
		}
	}
	for (const entry of policy.allowedBinaryFiles) {
		if (!usedBinaries.has(entry.path)) {
			issues.push({ code: "stale-binary-approval", path: entry.path, detail: "approval did not match a binary" });
		}
	}
	for (const [key, entry] of interoperability) {
		if (!usedInteroperability.has(key)) {
			issues.push({
				code: "stale-interoperability-approval",
				path: entry.path,
				line: entry.line,
				detail: entry.term,
			});
		}
	}
}

function writeSnapshotFile(root, file) {
	const destination = join(root, ...file.path.split("/"));
	mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
	const descriptor = openSync(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, file.mode);
	try {
		writeFileSync(descriptor, file.bytes);
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
	chmodSync(destination, file.mode);
}

function defaultGitleaksRunner({ binary = "gitleaks", root, reportPath }) {
	const env = isolatedGitEnvironment();
	let version;
	try {
		version = runCommand(binary, ["version"], { env, label: "gitleaks version" });
	} catch (error) {
		if (error?.code === "ENOENT") return { ok: false, code: "gitleaks-missing" };
		return { ok: false, code: "gitleaks-error" };
	}
	const result = spawnSync(
		binary,
		["dir", "--no-banner", "--redact", "--report-format", "json", "--report-path", reportPath, root],
		{
			encoding: "utf8",
			env,
			maxBuffer: 16 * 1024 * 1024,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	if (result.error?.code === "ENOENT") return { ok: false, code: "gitleaks-missing" };
	if (result.error || ![0, 1].includes(result.status)) return { ok: false, code: "gitleaks-error", version };
	if (result.status === 1) return { ok: false, code: "gitleaks-finding", version };
	return { ok: true, version };
}

function parseCommitTree(root, env) {
	const output = runGitBytes(root, ["ls-tree", "-r", "-z", "--full-tree", "HEAD"], "root commit tree check", env);
	return splitNulRecords(output, "root commit tree check").map((record) => {
		const tab = record.indexOf(0x09);
		if (tab <= 0) throw new Error("New public repository tree contains malformed metadata.");
		const metadata = record.subarray(0, tab).toString("ascii");
		const match = metadata.match(/^(\d{6}) (blob|tree|commit) ([a-f0-9]{40}|[a-f0-9]{64})$/u);
		if (!match) throw new Error("New public repository tree contains malformed metadata.");
		return {
			mode: match[1],
			type: match[2],
			objectId: match[3],
			path: decodeGitPath(record.subarray(tab + 1), "committed path"),
		};
	});
}

function verifyCommitIdentity(root, owner, env) {
	const fields = runGit(
		root,
		["show", "-s", "--format=%an%x00%ae%x00%cn%x00%ce%x00%P%x00%B", "HEAD"],
		"root commit identity check",
		env,
	).split("\0");
	if (
		fields.length !== 6 ||
		fields[0] !== owner.name ||
		fields[1] !== owner.email ||
		fields[2] !== owner.name ||
		fields[3] !== owner.email
	) {
		throw new Error("New public repository commit author or committer does not match the reviewed identity.");
	}
	if (fields[4] !== "") throw new Error("New public repository commit unexpectedly has a parent.");
	if (fields[5] !== "Initial reviewed public snapshot") {
		throw new Error("New public repository root commit message is not the reviewed fixed message.");
	}
}

function verifySnapshotWorktree(root, expectedFiles) {
	const expectedByPath = new Map(expectedFiles.map((file) => [file.path, file]));
	const expectedDirectories = new Set();
	for (const file of expectedFiles) {
		const components = file.path.split("/");
		for (let index = 1; index < components.length; index++) {
			expectedDirectories.add(components.slice(0, index).join("/"));
		}
	}
	const seen = new Set();
	const walk = (directory, prefix = "") => {
		const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
			left.name.localeCompare(right.name),
		);
		for (const entry of entries) {
			if (!prefix && entry.name === ".git") {
				const gitStats = lstatSync(join(directory, entry.name));
				if (!gitStats.isDirectory() || gitStats.isSymbolicLink()) {
					throw new Error("New public repository metadata path is not a real directory.");
				}
				continue;
			}
			const relativePath = normalizeRelativePath(prefix ? `${prefix}/${entry.name}` : entry.name, "snapshot path");
			const path = join(directory, entry.name);
			const stats = lstatSync(path);
			if (stats.isSymbolicLink()) throw new Error(`New public snapshot contains a symbolic link: ${relativePath}`);
			if (stats.isDirectory()) {
				if (!expectedDirectories.has(relativePath)) {
					throw new Error(`New public snapshot contains an unexpected directory: ${relativePath}`);
				}
				walk(path, relativePath);
				continue;
			}
			if (!stats.isFile() || stats.nlink !== 1) {
				throw new Error(`New public snapshot contains a non-regular or hard-linked path: ${relativePath}`);
			}
			const expected = expectedByPath.get(relativePath);
			if (!expected) throw new Error(`New public snapshot contains an unexpected file: ${relativePath}`);
			const bytes = readRegularFileWithoutFollowing(path, `New public snapshot file ${relativePath}`);
			const finalStats = lstatSync(path);
			if (
				!finalStats.isFile() ||
				finalStats.isSymbolicLink() ||
				finalStats.dev !== stats.dev ||
				finalStats.ino !== stats.ino ||
				finalStats.size !== stats.size ||
				finalStats.mtimeMs !== stats.mtimeMs ||
				finalStats.mode !== stats.mode ||
				finalStats.nlink !== stats.nlink
			) {
				throw new Error(`New public snapshot path changed during final verification: ${relativePath}`);
			}
			if (!bytes.equals(expected.bytes)) {
				throw new Error(`New public snapshot file bytes differ from the reviewed snapshot: ${relativePath}`);
			}
			if (process.platform !== "win32" && (finalStats.mode & 0o777) !== expected.mode) {
				throw new Error(`New public snapshot file mode differs from the reviewed snapshot: ${relativePath}`);
			}
			seen.add(relativePath);
		}
	};
	walk(root);
	if (seen.size !== expectedByPath.size) throw new Error("New public snapshot worktree is incomplete.");
}

function verifyFreshRepository(root, expectedFiles, owner) {
	const env = isolatedGitEnvironment();
	const commitCount = Number(runGit(root, ["rev-list", "--count", "--all"], "new repository history check"));
	if (commitCount !== 1) throw new Error("New public repository must contain exactly one root commit.");
	const parents = runGit(root, ["rev-list", "--parents", "--max-count=1", "HEAD"], "root commit parent check")
		.split(/\s+/u)
		.filter(Boolean);
	if (parents.length !== 1) throw new Error("New public repository commit unexpectedly has a parent.");
	const refs = runGit(root, ["for-each-ref", "--format=%(refname)"], "new repository ref check")
		.split(/\r?\n/u)
		.filter(Boolean);
	if (JSON.stringify(refs) !== JSON.stringify(["refs/heads/main"])) {
		throw new Error("New public repository contains unexpected refs.");
	}
	if (runGit(root, ["remote"], "new repository remote check") !== "") {
		throw new Error("New public repository unexpectedly contains a remote.");
	}
	if (runGit(root, ["tag", "--list"], "new repository tag check") !== "") {
		throw new Error("New public repository unexpectedly contains tags.");
	}
	verifyCommitIdentity(root, owner, env);
	const expectedByPath = new Map(expectedFiles.map((file) => [file.path, file]));
	if (expectedByPath.size !== expectedFiles.length) throw new Error("Reviewed snapshot contains duplicate paths.");
	const tree = parseCommitTree(root, env);
	if (tree.length !== expectedByPath.size) {
		throw new Error("New public repository tree file count differs from the reviewed snapshot.");
	}
	const treeByPath = new Map();
	for (const entry of tree) {
		const expected = expectedByPath.get(entry.path);
		if (!expected || entry.type !== "blob" || entry.mode !== expected.gitMode) {
			throw new Error(`New public repository tree differs from the reviewed snapshot: ${entry.path}`);
		}
		const committedBytes = runGitBytes(
			root,
			["cat-file", "blob", entry.objectId],
			`committed blob ${entry.path}`,
			env,
		);
		if (!committedBytes.equals(expected.bytes)) {
			throw new Error(`New public repository blob bytes differ from the reviewed snapshot: ${entry.path}`);
		}
		treeByPath.set(entry.path, entry);
	}
	const index = parseTrackedFiles(root, env);
	if (index.length !== expectedByPath.size) {
		throw new Error("New public repository index file count differs from the reviewed snapshot.");
	}
	for (const entry of index) {
		const committed = treeByPath.get(entry.path);
		if (!committed || entry.stage !== 0 || entry.mode !== committed.mode || entry.objectId !== committed.objectId) {
			throw new Error(`New public repository index differs from its reviewed commit: ${entry.path}`);
		}
	}
	if (runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], "new repository status check", env)) {
		throw new Error("New public repository worktree or index is dirty after the root commit.");
	}
	verifySnapshotWorktree(root, expectedFiles);
	return runGit(root, ["rev-parse", "HEAD"], "new repository commit check");
}

function initializeFreshRepository(root, owner) {
	const env = isolatedGitEnvironment();
	runCommand("git", ["init", "--initial-branch=main", "--template=", root], {
		env,
		label: "new public repository initialization",
	});
	runGit(root, ["add", "--all", "--force"], "new public repository staging", env);
	runCommand(
		"git",
		[
			"-C",
			root,
			"-c",
			`user.name=${owner.name}`,
			"-c",
			`user.email=${owner.email}`,
			"commit",
			"--no-gpg-sign",
			"--no-verify",
			"-m",
			"Initial reviewed public snapshot",
		],
		{ env, label: "new public repository root commit" },
	);
}

function prepareOutput(outputPath, sourceRoot) {
	if (!outputPath) throw new Error("Write mode requires an explicit --output path.");
	const output = resolve(outputPath);
	if (pathInside(sourceRoot, output))
		throw new Error("Public snapshot output must be outside the private source tree.");
	if (existsSync(output))
		throw new Error("Public snapshot output already exists; overwrite and backup are forbidden.");
	const parent = dirname(output);
	const parentStats = lstatSync(parent);
	if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
		throw new Error("Public snapshot output parent must be a real existing directory.");
	}
	const canonicalParent = realpathSync(parent);
	const canonicalOutput = join(canonicalParent, basename(output));
	if (pathInside(realpathSync(sourceRoot), canonicalOutput)) {
		throw new Error("Public snapshot output resolves inside the private source tree.");
	}
	return {
		output,
		parent,
		canonicalParent,
		staging: mkdtempSync(join(parent, ".magenta-public-snapshot-")),
	};
}

export function exportPublicSnapshot({
	sourceRoot = SCRIPT_ROOT,
	policyPath,
	dryRun = true,
	outputPath,
	gitleaksBinary = "gitleaks",
	gitleaksRunner = defaultGitleaksRunner,
} = {}) {
	const root = resolve(sourceRoot);
	if (!policyPath) throw new Error("An explicit reviewed --policy file is required.");
	const canonicalRoot = runGit(root, ["rev-parse", "--show-toplevel"], "source repository root check");
	if (realpathSync(canonicalRoot) !== realpathSync(root)) {
		throw new Error("Source root must be the exact Git repository root.");
	}
	const sourceCommit = runGit(root, ["rev-parse", "HEAD"], "source commit check");
	const initialStatus = runGit(
		root,
		["status", "--porcelain=v1", "-z", "--untracked-files=all"],
		"source status check",
	);
	const { bytes: policyBytes, policy } = readPolicy(resolve(policyPath));
	const issues = [];
	if (initialStatus !== "") issues.push({ code: "dirty-source", detail: "source worktree is not clean" });

	const tracked = parseTrackedFiles(root);
	const includeMatches = new Map(policy.include.map((entry) => [entry, 0]));
	const selected = [];
	const selectedPortablePaths = new Map();
	for (const entry of tracked) {
		if (entry.stage !== 0) {
			issues.push({ code: "git-stage", path: entry.path, detail: "unmerged index entry" });
			continue;
		}
		const path = normalizeRelativePath(entry.path, "tracked path");
		const matchingIncludes = policy.include.filter((allowed) => pathMatches(path, allowed));
		if (matchingIncludes.length === 0) continue;
		for (const allowed of matchingIncludes) includeMatches.set(allowed, (includeMatches.get(allowed) ?? 0) + 1);
		const hardExcluded = ALWAYS_EXCLUDED.find((excluded) => pathMatches(path, excluded));
		const policyExcluded = policy.exclude.find((excluded) => pathMatches(path, excluded));
		if (hardExcluded || policyExcluded) continue;
		if (entry.mode === "120000" || entry.mode === "160000") {
			issues.push({ code: "git-entry", path, detail: "symlinks and submodules are forbidden" });
			continue;
		}
		if (!["100644", "100755"].includes(entry.mode)) {
			issues.push({ code: "git-entry", path, detail: `unsupported mode ${entry.mode}` });
			continue;
		}
		const portableKey = portablePathKey(path);
		if (GENERATED_PATH_KEYS.has(portableKey)) {
			issues.push({ code: "git-entry", path, detail: "path is reserved for generated snapshot evidence" });
			continue;
		}
		const collidingPath = selectedPortablePaths.get(portableKey);
		if (collidingPath) {
			issues.push({ code: "path-collision", path, detail: `not portable alongside ${collidingPath}` });
			continue;
		}
		selectedPortablePaths.set(portableKey, path);
		try {
			const bytes = readRegularFileWithoutFollowing(join(root, ...path.split("/")), `Tracked file ${path}`);
			selected.push({
				path,
				bytes,
				sha256: sha256Bytes(bytes),
				size: bytes.length,
				mode: entry.mode === "100755" ? 0o755 : 0o644,
				gitMode: entry.mode,
			});
		} catch (error) {
			issues.push({ code: "capture", path, detail: error instanceof Error ? error.message : "capture failed" });
		}
	}
	for (const [entry, count] of includeMatches) {
		if (count === 0)
			issues.push({ code: "empty-include", path: entry, detail: "allowlist entry matches no tracked file" });
	}
	if (selected.length === 0) issues.push({ code: "empty-snapshot", detail: "allowlist selected no files" });

	auditPolicy(policy, sourceCommit, selected, issues);
	auditCapturedFiles(policy, selected, issues);
	const finalStatus = runGit(
		root,
		["status", "--porcelain=v1", "-z", "--untracked-files=all"],
		"final source status check",
	);
	if (
		finalStatus !== initialStatus ||
		runGit(root, ["rev-parse", "HEAD"], "final source commit check") !== sourceCommit
	) {
		issues.push({ code: "source-race", detail: "source repository changed during capture" });
	}

	let output;
	let staging;
	let outputParent;
	let canonicalParent;
	if (dryRun) staging = mkdtempSync(join(tmpdir(), "magenta-public-snapshot-audit-"));
	else ({ output, staging, parent: outputParent, canonicalParent } = prepareOutput(outputPath, root));
	let keepStaging = false;
	try {
		for (const file of selected) writeSnapshotFile(staging, file);
		const treeSha256 = sha256Bytes(
			Buffer.from(
				selected
					.map((file) => `${file.path}\0${file.gitMode}\0${file.size}\0${file.sha256}\n`)
					.sort()
					.join(""),
				"utf8",
			),
		);
		const manifest = {
			schemaVersion: 1,
			kind: "reviewed-public-root-snapshot",
			source: { commit: sourceCommit, historyCopied: false, refsCopied: false, worktreeClean: initialStatus === "" },
			target: { owner: policy.target.owner, repository: policy.target.repository, branch: "main" },
			policySha256: sha256Bytes(policyBytes),
			treeSha256,
			files: selected
				.map((file) => ({ path: file.path, mode: file.gitMode, size: file.size, sha256: file.sha256 }))
				.sort((left, right) => left.path.localeCompare(right.path)),
			excludedState: [
				"source .git and refs",
				"tags",
				"Releases",
				"pull-request refs",
				"Actions artifacts",
				"internal audit",
			],
			audits: { builtinSecrets: true, sensitiveTerms: true, gitleaksDirectoryScan: true },
		};
		const manifestBytes = Buffer.from(stableJson(manifest), "utf8");
		const manifestFile = {
			path: GENERATED_MANIFEST,
			bytes: manifestBytes,
			mode: 0o644,
			gitMode: "100644",
			size: manifestBytes.length,
			sha256: sha256Bytes(manifestBytes),
		};
		writeSnapshotFile(staging, manifestFile);
		const checksumLines = [
			...manifest.files.map((file) => `${file.sha256}  ${file.path}`),
			`${manifestFile.sha256}  ${GENERATED_MANIFEST}`,
		];
		const checksumBytes = Buffer.from(`${checksumLines.join("\n")}\n`, "utf8");
		const checksumsFile = {
			path: GENERATED_CHECKSUMS,
			bytes: checksumBytes,
			mode: 0o644,
			gitMode: "100644",
			size: checksumBytes.length,
			sha256: sha256Bytes(checksumBytes),
		};
		writeSnapshotFile(staging, checksumsFile);
		const reviewedSnapshotFiles = [...selected, manifestFile, checksumsFile];
		const gitleaksReportPath = join(staging, ".gitleaks-report.json");
		const gitleaks = gitleaksRunner({
			binary: gitleaksBinary,
			root: staging,
			reportPath: gitleaksReportPath,
		});
		rmSync(gitleaksReportPath, { force: true });
		if (!gitleaks?.ok)
			issues.push({ code: gitleaks?.code ?? "gitleaks-error", detail: "gitleaks directory scan failed" });
		const report = {
			dryRun,
			sourceCommit,
			policySha256: manifest.policySha256,
			treeSha256,
			selectedFiles: selected.length,
			gitleaksVersion: gitleaks?.version,
			issues: issues.map((issue) => ({ ...issue })),
			manifest,
		};
		if (issues.length > 0) throw new PublicSnapshotError(issues, report);
		if (dryRun) return report;

		initializeFreshRepository(staging, policy.target.rootCommitOwner);
		const rootCommit = verifyFreshRepository(staging, reviewedSnapshotFiles, policy.target.rootCommitOwner);
		if (realpathSync(outputParent) !== canonicalParent || existsSync(output)) {
			throw new Error("Public snapshot output destination changed before activation.");
		}
		renameSync(staging, output);
		keepStaging = true;
		return { ...report, output, rootCommit };
	} finally {
		if (!keepStaging) rmSync(staging, { recursive: true, force: true });
	}
}

function usage() {
	return `Usage: node scripts/export-public-snapshot.mjs --policy <reviewed.json> [--dry-run]\n       node scripts/export-public-snapshot.mjs --policy <reviewed.json> --write --output <new-directory>\n\nThe default is dry-run. This command never creates a remote or pushes refs.\n`;
}

function parseCli(argv) {
	const options = { dryRun: true, sourceRoot: SCRIPT_ROOT };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") return { help: true };
		if (arg === "--dry-run") options.dryRun = true;
		else if (arg === "--write") options.dryRun = false;
		else if (arg === "--policy") options.policyPath = argv[++index];
		else if (arg === "--output") options.outputPath = argv[++index];
		else if (arg === "--source") options.sourceRoot = argv[++index];
		else if (arg === "--gitleaks-bin") options.gitleaksBinary = argv[++index];
		else throw new Error(`Unknown argument: ${arg}`);
	}
	return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const options = parseCli(process.argv.slice(2));
		if (options.help) {
			process.stdout.write(usage());
		} else {
			const report = exportPublicSnapshot(options);
			process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		}
	} catch (error) {
		if (error instanceof PublicSnapshotError) {
			for (const issue of error.issues) {
				const location = issue.path ? `${issue.path}${issue.line ? `:${issue.line}` : ""}: ` : "";
				process.stderr.write(`${location}[${issue.code}] ${issue.detail}\n`);
			}
		} else {
			process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		}
		process.exitCode = 1;
	}
}
