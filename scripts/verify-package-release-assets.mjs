#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";

export const HcpClientpackageplatforms = ["linux-x64", "macos-arm64", "macos-x64", "windows-x64"];

const HcpClientpackageidpattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const HcpClientstrictsemverpattern =
	/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const HcpClientwindowsreservednamepattern = /^(?:aux|con|nul|prn|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export function HcpClientassertreleaseidentity(packageId, version) {
	if (
		!HcpClientpackageidpattern.test(packageId) ||
		packageId === "." ||
		packageId === ".." ||
		packageId.endsWith(".") ||
		HcpClientwindowsreservednamepattern.test(packageId)
	) {
		throw new Error(`Unsafe Package id: ${JSON.stringify(packageId)}`);
	}
	if (!HcpClientstrictsemverpattern.test(version)) {
		throw new Error(`Invalid semantic version: ${JSON.stringify(version)}`);
	}
}

function HcpClientexpectedreleaseassets(packageId, version) {
	return HcpClientpackageplatforms.flatMap((platform) => {
		const archive = `${packageId}-v${version}-${platform}.tar.gz`;
		return [archive, `${archive}.sha256`];
	});
}

function HcpClientsha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function HcpClientverifychecksum(archivePath, checksumPath) {
	const bytes = readFileSync(checksumPath);
	if (bytes.includes(13)) {
		throw new Error(`Checksum must use LF line endings: ${basename(checksumPath)}`);
	}
	const text = bytes.toString("ascii");
	const match = /^([a-f0-9]{64})  ([^\r\n]+)\n$/.exec(text);
	if (!match) throw new Error(`Invalid checksum format: ${basename(checksumPath)}`);
	const [, expectedHash, expectedName] = match;
	if (expectedName !== basename(archivePath)) {
		throw new Error(`Checksum filename mismatch: expected ${basename(archivePath)}, got ${expectedName}`);
	}
	const actualHash = HcpClientsha256(archivePath);
	if (actualHash !== expectedHash) {
		throw new Error(`Checksum mismatch for ${basename(archivePath)}: expected ${expectedHash}, got ${actualHash}`);
	}
	return actualHash;
}

function HcpClientruntar(args, archivePath) {
	const result = spawnSync("tar", [...args, archivePath], {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		timeout: 60_000,
	});
	if (result.error) throw new Error(`Failed to inspect ${basename(archivePath)}: ${result.error.message}`);
	if (result.status !== 0) {
		throw new Error(
			`tar ${args.join(" ")} failed for ${basename(archivePath)}: ${result.stderr.trim() || "no stderr"}`,
		);
	}
	return result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
}

export function HcpClientvalidatearchiveentrypath(entryPath, packageId) {
	if (/[\u0000-\u001f\u007f]/.test(entryPath) || entryPath.includes("\\")) {
		throw new Error(`Unsafe archive path: ${JSON.stringify(entryPath)}`);
	}
	if (entryPath.startsWith("/") || /^[A-Za-z]:/.test(entryPath)) {
		throw new Error(`Absolute archive path: ${JSON.stringify(entryPath)}`);
	}
	const normalized = entryPath.endsWith("/") ? entryPath.slice(0, -1) : entryPath;
	const segments = normalized.split("/");
	if (
		!normalized ||
		segments[0] !== packageId ||
		segments.some((segment) => !segment || segment === "." || segment === "..")
	) {
		throw new Error(`Archive path escapes ${packageId}/: ${JSON.stringify(entryPath)}`);
	}
	for (const segment of segments) {
		if (segment.includes(":") || /[. ]$/.test(segment) || HcpClientwindowsreservednamepattern.test(segment)) {
			throw new Error(`Archive path is not cross-platform safe: ${JSON.stringify(entryPath)}`);
		}
	}
	return normalized;
}

function HcpClientverifyarchive(archivePath, packageId, version) {
	const pathsOutput = HcpClientruntar(["tzf"], archivePath);
	const verboseOutput = HcpClientruntar(["tvzf"], archivePath);
	const paths = pathsOutput ? pathsOutput.split("\n").map((line) => line.replace(/\r$/, "")) : [];
	const verbose = verboseOutput ? verboseOutput.split("\n").map((line) => line.replace(/\r$/, "")) : [];
	if (paths.length === 0 || paths.length !== verbose.length) {
		throw new Error(`Archive listing is empty or ambiguous: ${basename(archivePath)}`);
	}
	const seen = new Map();
	for (let index = 0; index < paths.length; index++) {
		const type = verbose[index]?.[0];
		if (type !== "-" && type !== "d") {
			throw new Error(`Archive contains unsupported entry type ${JSON.stringify(type)}: ${paths[index]}`);
		}
		const normalized = HcpClientvalidatearchiveentrypath(paths[index], packageId);
		const portable = normalized.normalize("NFC").toLowerCase();
		const collision = seen.get(portable);
		if (collision) throw new Error(`Archive path collision: ${collision} and ${normalized}`);
		seen.set(portable, normalized);
	}

	const manifestPath = `${packageId}/package.toml`;
	if (!seen.has(manifestPath.toLowerCase())) {
		throw new Error(`Archive has no ${manifestPath}: ${basename(archivePath)}`);
	}
	const manifestResult = spawnSync("tar", ["xOzf", archivePath, manifestPath], {
		encoding: "utf8",
		maxBuffer: 4 * 1024 * 1024,
		timeout: 60_000,
	});
	if (manifestResult.error || manifestResult.status !== 0) {
		throw new Error(`Cannot read ${manifestPath} from ${basename(archivePath)}`);
	}
	const manifest = parseToml(manifestResult.stdout);
	if (manifest.schema_version !== "magenta.package.v2") throw new Error("Package manifest schema is not v2");
	if (manifest.id !== packageId) throw new Error(`Package manifest id does not match ${packageId}`);
	if (manifest.version !== version) throw new Error(`Package manifest version does not match ${version}`);
	if (typeof manifest.name !== "string" || !manifest.name) throw new Error("Package manifest has no name");
	if (typeof manifest.source !== "string" || !manifest.source) throw new Error("Package manifest has no source");
	// Windows checkout line endings may differ while the TOML is semantically
	// identical. Compare the parsed manifest rather than its raw bytes.
	return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

export function HcpClientverifypackagereleaseassets({ packageId, version, assetsDir }) {
	HcpClientassertreleaseidentity(packageId, version);
	const root = resolve(assetsDir);
	const expectedAssets = HcpClientexpectedreleaseassets(packageId, version).sort();
	const actualAssets = readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => entry.name)
		.sort();
	if (JSON.stringify(actualAssets) !== JSON.stringify(expectedAssets)) {
		throw new Error(
			`Release asset set mismatch. Expected ${expectedAssets.join(", ")}; got ${actualAssets.join(", ")}`,
		);
	}

	const archiveHashes = {};
	let manifestHash;
	for (const platform of HcpClientpackageplatforms) {
		const archiveName = `${packageId}-v${version}-${platform}.tar.gz`;
		const archivePath = join(root, archiveName);
		archiveHashes[archiveName] = HcpClientverifychecksum(archivePath, `${archivePath}.sha256`);
		const currentManifestHash = HcpClientverifyarchive(archivePath, packageId, version);
		if (manifestHash === undefined) manifestHash = currentManifestHash;
		else if (manifestHash !== currentManifestHash) {
			throw new Error(`Package manifests differ across platforms: ${archiveName}`);
		}
	}
	return { packageId, version, archiveHashes, manifestHash };
}

function HcpClientparsearguments(args) {
	const values = new Map();
	for (let index = 0; index < args.length; index += 2) {
		const key = args[index];
		const value = args[index + 1];
		if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid argument: ${key ?? "(missing)"}`);
		values.set(key.slice(2), value);
	}
	const packageId = values.get("package");
	const version = values.get("version");
	const assetsDir = values.get("assets-dir");
	if (!packageId || !version || !assetsDir) {
		throw new Error("Usage: verify-package-release-assets.mjs --package <id> --version <semver> --assets-dir <dir>");
	}
	return { packageId, version, assetsDir };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
	const result = HcpClientverifypackagereleaseassets(HcpClientparsearguments(process.argv.slice(2)));
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
