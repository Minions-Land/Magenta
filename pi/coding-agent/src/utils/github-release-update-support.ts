import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, createReadStream } from "node:fs";
import {
	chmod,
	cp,
	type FileHandle,
	link,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { secureReadFile } from "@magenta/harness";

export const RELEASE_RESOURCES_ASSET_NAME = "magenta-resources-universal.tar.gz";
export const RELEASE_CHECKSUMS_ASSET_NAME = "SHA256SUMS";
export const RELEASE_RESOURCE_MARKER_NAME = "magenta-release.json";
export const INSTALLED_RELEASE_MARKER_SCHEMA = "magenta.installed-release.v1";
const INSTALLED_RELEASE_MARKER_TEMP_NAME = ".magenta-release.json.tmp";
export const RELEASE_INSTALL_LOCK_NAME = ".magenta-install-update.lock";
export const RELEASE_UPDATE_JOURNAL_NAME = ".magenta-install-update.json";
const RELEASE_UPDATE_JOURNAL_TEMP_NAME = `${RELEASE_UPDATE_JOURNAL_NAME}.tmp`;
// Journal version six binds original paths and staged resource objects to the
// filesystem identities observed during prepare; the staged binary is bound by
// its SHA-256 digest. Readers continue to accept every prior journal shape.
const RELEASE_UPDATE_JOURNAL_VERSION = 6;
const PREVIOUS_RELEASE_UPDATE_JOURNAL_VERSION = 5;
const PREVIOUS_V4_RELEASE_UPDATE_JOURNAL_VERSION = 4;
const PREVIOUS_V3_RELEASE_UPDATE_JOURNAL_VERSION = 3;
const PREVIOUS_V2_RELEASE_UPDATE_JOURNAL_VERSION = 2;
const LEGACY_RELEASE_UPDATE_JOURNAL_VERSION = 1;
const RELEASE_RESOURCE_MARKER_MAX_BYTES = 16 * 1024;
const RELEASE_UPDATE_JOURNAL_MAX_BYTES = 64 * 1024;

export const RESOURCE_DIRECTORY_NAMES = [
	"sandbox",
	"tools",
	"policy",
	"runtime",
	"skills",
	"theme",
	"assets",
	"export-html",
	"docs",
	"examples",
] as const;

export const RESOURCE_FILE_NAMES = ["package.json", "README.md", "CHANGELOG.md"] as const;

export const LEGACY_MANAGED_RELEASE_RESOURCE_NAMES = [
	...RESOURCE_DIRECTORY_NAMES,
	...RESOURCE_FILE_NAMES,
	RELEASE_RESOURCE_MARKER_NAME,
	"_magenta",
	"photon_rs_bg.wasm",
] as const;

export const BASE_REQUIRED_RESOURCE_PATHS = [
	"theme/dark.json",
	"tools/read/read.toml",
	"skills/paper-analysis/pi/SKILL.md",
	"photon_rs_bg.wasm",
	"runtime/node_modules/@mariozechner/clipboard/package.json",
	"runtime/node_modules/@mariozechner/clipboard/index.js",
] as const;

export const CLIPBOARD_NATIVE_RESOURCE_PATHS = {
	darwin: [
		"runtime/node_modules/@mariozechner/clipboard-darwin-universal/package.json",
		"runtime/node_modules/@mariozechner/clipboard-darwin-universal/clipboard.darwin-universal.node",
	],
	linux: [
		"runtime/node_modules/@mariozechner/clipboard-linux-x64-gnu/package.json",
		"runtime/node_modules/@mariozechner/clipboard-linux-x64-gnu/clipboard.linux-x64-gnu.node",
	],
	win32: [
		"runtime/node_modules/@mariozechner/clipboard-win32-x64-msvc/package.json",
		"runtime/node_modules/@mariozechner/clipboard-win32-x64-msvc/clipboard.win32-x64-msvc.node",
	],
} as const;

export const REQUIRED_RESOURCE_PATHS = [
	...BASE_REQUIRED_RESOURCE_PATHS,
	...CLIPBOARD_NATIVE_RESOURCE_PATHS.darwin,
	...CLIPBOARD_NATIVE_RESOURCE_PATHS.linux,
	...CLIPBOARD_NATIVE_RESOURCE_PATHS.win32,
] as const;

const releaseMarkerVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function isManagedReleaseResourceName(value: string): boolean {
	return (
		value === "_magenta" ||
		value === RELEASE_RESOURCE_MARKER_NAME ||
		(RESOURCE_DIRECTORY_NAMES as readonly string[]).includes(value) ||
		(RESOURCE_FILE_NAMES as readonly string[]).includes(value) ||
		/^[A-Za-z0-9][A-Za-z0-9._-]*\.wasm$/.test(value)
	);
}

export interface InstalledReleaseOwnership {
	version: string;
	/** Undefined for the legacy marker that recorded only a version. */
	resourceNames?: readonly string[];
}

export function getInstalledRequiredResourcePaths(
	runtimePlatform: NodeJS.Platform = process.platform,
	runtimeArch: string = process.arch,
): readonly string[] {
	if (runtimePlatform === "darwin" && (runtimeArch === "arm64" || runtimeArch === "x64")) {
		return [...BASE_REQUIRED_RESOURCE_PATHS, ...CLIPBOARD_NATIVE_RESOURCE_PATHS.darwin];
	}
	if (runtimePlatform === "linux" && runtimeArch === "x64") {
		return [...BASE_REQUIRED_RESOURCE_PATHS, ...CLIPBOARD_NATIVE_RESOURCE_PATHS.linux];
	}
	if (runtimePlatform === "win32" && runtimeArch === "x64") {
		return [...BASE_REQUIRED_RESOURCE_PATHS, ...CLIPBOARD_NATIVE_RESOURCE_PATHS.win32];
	}
	return BASE_REQUIRED_RESOURCE_PATHS;
}

export interface ReleaseAssetDescriptor {
	name: string;
	browser_download_url: string;
	digest?: string | null;
}

export interface ReleaseAssetDownload {
	name: string;
	downloadUrl: string;
	/** SHA-256 published in the direct GitHub API release response. */
	sha256?: string;
}

export interface ReleaseAssetPlan {
	binary: ReleaseAssetDownload;
	resources: ReleaseAssetDownload;
	checksums: ReleaseAssetDownload;
}

export function shouldUseMirrorForReleaseAsset(asset: ReleaseAssetDownload): boolean {
	return asset.name !== RELEASE_CHECKSUMS_ASSET_NAME || Boolean(asset.sha256);
}

export function resolveReleaseAssetPlan(
	assets: readonly ReleaseAssetDescriptor[],
	binaryAssetName: string,
): ReleaseAssetPlan {
	const resolveOne = (name: string): ReleaseAssetDownload => {
		const matches = assets.filter((asset) => asset.name === name);
		if (matches.length === 0) {
			throw new Error(`Release is missing required asset: ${name}`);
		}
		if (matches.length !== 1) {
			throw new Error(`Release contains duplicate assets named: ${name}`);
		}
		const descriptor = matches[0];
		const downloadUrl = descriptor?.browser_download_url;
		if (!downloadUrl) {
			throw new Error(`Release asset has no download URL: ${name}`);
		}
		const digest = descriptor?.digest;
		if (digest == null) return { name, downloadUrl };
		const digestMatch = /^sha256:([0-9a-f]{64})$/i.exec(digest);
		const sha256 = digestMatch?.[1];
		if (!sha256) {
			throw new Error(`Release asset has an invalid SHA-256 digest: ${name}`);
		}
		return { name, downloadUrl, sha256: sha256.toLowerCase() };
	};

	return {
		binary: resolveOne(binaryAssetName),
		resources: resolveOne(RELEASE_RESOURCES_ASSET_NAME),
		checksums: resolveOne(RELEASE_CHECKSUMS_ASSET_NAME),
	};
}

function isSafeArtifactBasename(value: string): boolean {
	return (
		value !== "." &&
		value !== ".." &&
		basename(value) === value &&
		!value.includes("\\") &&
		/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
	);
}

function isSafeUpdateResourceName(value: string): boolean {
	// `_magenta` is a fixed, generated top-level helper tree. Keep the general
	// artifact grammar strict and allow only this exact leading-underscore name.
	return value === "_magenta" || isSafeArtifactBasename(value);
}

export function parseReleaseChecksums(content: string): ReadonlyMap<string, string> {
	const checksums = new Map<string, string>();
	const lines = content.split(/\r?\n/);

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		if (line.trim().length === 0) continue;
		const match = line.match(/^([0-9a-fA-F]{64})[ \t]+\*?([^ \t]+)[ \t]*$/);
		if (!match) {
			throw new Error(`Invalid SHA256SUMS line ${index + 1}`);
		}
		const artifactName = match[2] ?? "";
		if (!isSafeArtifactBasename(artifactName)) {
			throw new Error(`Unsafe artifact name in SHA256SUMS: ${artifactName}`);
		}
		if (checksums.has(artifactName)) {
			throw new Error(`Duplicate checksum entry: ${artifactName}`);
		}
		checksums.set(artifactName, (match[1] ?? "").toLowerCase());
	}

	if (checksums.size === 0) {
		throw new Error("SHA256SUMS contains no checksums");
	}

	return checksums;
}

export async function calculateFileSha256(filePath: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(filePath)) {
		hash.update(chunk);
	}
	return hash.digest("hex");
}

/** Verify an asset against the digest obtained from the direct GitHub API. */
export async function verifyReleaseAssetDigest(asset: ReleaseAssetDownload, filePath: string): Promise<boolean> {
	if (!asset.sha256) return false;
	const actual = await calculateFileSha256(filePath);
	if (actual !== asset.sha256) {
		throw new Error(`GitHub API digest verification failed for ${asset.name}`);
	}
	return true;
}

export async function verifyReleaseArtifactChecksums(
	checksums: ReadonlyMap<string, string>,
	artifacts: ReadonlyArray<{ name: string; path: string }>,
): Promise<void> {
	for (const artifact of artifacts) {
		const expected = checksums.get(artifact.name);
		if (!expected) {
			throw new Error(`SHA256SUMS does not contain ${artifact.name}`);
		}
		const actual = await calculateFileSha256(artifact.path);
		if (actual !== expected) {
			throw new Error(`Checksum verification failed for ${artifact.name}`);
		}
	}
}

export type ReleaseArchiveEntryType = "file" | "directory" | "symlink" | "hardlink" | "other";

export interface ReleaseArchiveEntry {
	path: string;
	type: ReleaseArchiveEntryType;
}

// The archive is downloaded before it is inspected.  Keep decompression and
// metadata processing bounded so a small gzip member cannot force an
// unbounded allocation or parser work (a classic archive-bomb failure mode).
export const MAX_RELEASE_ARCHIVE_EXPANDED_BYTES = 512 * 1024 * 1024;
export const MAX_RELEASE_ARCHIVE_ENTRY_COUNT = 100_000;
export const MAX_RELEASE_ARCHIVE_ENTRY_BYTES = 256 * 1024 * 1024;

export interface ReleaseArchiveParseLimits {
	/** Maximum bytes produced by gzip decompression. Defaults to the product cap. */
	maxExpandedBytes?: number;
	/** Maximum tar records, including PAX/long-name metadata records. */
	maxEntryCount?: number;
	/** Maximum declared size of any one tar record, including metadata. */
	maxEntryBytes?: number;
}

const textDecoder = new TextDecoder("utf-8", { fatal: true });
const windowsReservedNamePattern = /^(?:aux|con|nul|prn|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function decodeTarString(field: Uint8Array, label: string): string {
	const terminator = field.indexOf(0);
	const bytes = terminator >= 0 ? field.subarray(0, terminator) : field;
	try {
		return textDecoder.decode(bytes);
	} catch {
		throw new Error(`Invalid UTF-8 in tar ${label}`);
	}
}

function parseTarNumber(field: Uint8Array, label: string): number {
	if ((field[0] ?? 0) >= 0x80) {
		throw new Error(`Unsupported base-256 tar ${label}`);
	}
	const value = decodeTarString(field, label).trim();
	if (value.length === 0) return 0;
	if (!/^[0-7]+$/.test(value)) {
		throw new Error(`Invalid tar ${label}`);
	}
	const parsed = Number.parseInt(value, 8);
	if (!Number.isSafeInteger(parsed) || parsed < 0) {
		throw new Error(`Unsafe tar ${label}`);
	}
	return parsed;
}

function verifyTarHeaderChecksum(header: Uint8Array): void {
	const expected = parseTarNumber(header.subarray(148, 156), "header checksum");
	let actual = 0;
	for (let index = 0; index < header.length; index++) {
		actual += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
	}
	if (actual !== expected) {
		throw new Error("Invalid tar header checksum");
	}
}

function parsePaxRecords(data: Uint8Array): Map<string, string> {
	const records = new Map<string, string>();
	let offset = 0;

	while (offset < data.length) {
		let space = offset;
		while (space < data.length && data[space] !== 0x20) space++;
		if (space === data.length) throw new Error("Malformed PAX record length");
		const lengthText = Buffer.from(data.subarray(offset, space)).toString("ascii");
		if (!/^[1-9][0-9]*$/.test(lengthText)) throw new Error("Malformed PAX record length");
		const recordLength = Number.parseInt(lengthText, 10);
		const recordEnd = offset + recordLength;
		if (!Number.isSafeInteger(recordLength) || recordEnd > data.length || data[recordEnd - 1] !== 0x0a) {
			throw new Error("Malformed PAX record");
		}
		const record = data.subarray(space + 1, recordEnd - 1);
		const equals = record.indexOf(0x3d);
		if (equals <= 0) throw new Error("Malformed PAX key/value record");
		const key = textDecoder.decode(record.subarray(0, equals));
		if (/sparse|reparse|rawsd/i.test(key)) {
			throw new Error(`Unsupported PAX attribute: ${key}`);
		}
		if (key === "path" || key === "linkpath" || key === "size") {
			records.set(key, textDecoder.decode(record.subarray(equals + 1)));
		}
		offset = recordEnd;
	}

	return records;
}

function decodeLongTarValue(data: Uint8Array, label: string): string {
	const terminator = data.indexOf(0);
	const bytes = terminator >= 0 ? data.subarray(0, terminator) : data;
	try {
		return textDecoder.decode(bytes).replace(/\n$/, "");
	} catch {
		throw new Error(`Invalid UTF-8 in tar ${label}`);
	}
}

function isZeroBlock(block: Uint8Array): boolean {
	for (const byte of block) {
		if (byte !== 0) return false;
	}
	return true;
}

export function parseReleaseArchive(
	archiveBytes: Uint8Array,
	limits: ReleaseArchiveParseLimits = {},
): ReleaseArchiveEntry[] {
	const maxExpandedBytes = limits.maxExpandedBytes ?? MAX_RELEASE_ARCHIVE_EXPANDED_BYTES;
	const maxEntryCount = limits.maxEntryCount ?? MAX_RELEASE_ARCHIVE_ENTRY_COUNT;
	const maxEntryBytes = limits.maxEntryBytes ?? MAX_RELEASE_ARCHIVE_ENTRY_BYTES;
	if (!Number.isSafeInteger(maxExpandedBytes) || maxExpandedBytes <= 0) {
		throw new Error("Runtime resource archive expanded-byte limit is invalid");
	}
	if (!Number.isSafeInteger(maxEntryCount) || maxEntryCount <= 0) {
		throw new Error("Runtime resource archive entry-count limit is invalid");
	}
	if (!Number.isSafeInteger(maxEntryBytes) || maxEntryBytes <= 0) {
		throw new Error("Runtime resource archive per-entry byte limit is invalid");
	}
	let tarBytes: Buffer;
	try {
		tarBytes = gunzipSync(archiveBytes, { maxOutputLength: maxExpandedBytes });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
			throw new Error(`Runtime resource archive exceeds the ${maxExpandedBytes}-byte expanded size limit`);
		}
		throw new Error("Runtime resource archive is not a valid gzip stream");
	}

	const entries: ReleaseArchiveEntry[] = [];
	const globalPax = new Map<string, string>();
	let localPax = new Map<string, string>();
	let longPath: string | undefined;
	let longLinkPath: string | undefined;
	let offset = 0;
	let recordCount = 0;

	while (offset + 512 <= tarBytes.length) {
		const header = tarBytes.subarray(offset, offset + 512);
		if (isZeroBlock(header)) {
			for (const byte of tarBytes.subarray(offset)) {
				if (byte !== 0) throw new Error("Unexpected data after tar end marker");
			}
			break;
		}
		recordCount += 1;
		if (recordCount > maxEntryCount) {
			throw new Error(`Runtime resource archive contains more than ${maxEntryCount} tar entries`);
		}

		verifyTarHeaderChecksum(header);
		const size = parseTarNumber(header.subarray(124, 136), "entry size");
		if (size > maxEntryBytes) {
			throw new Error(`Runtime resource archive entry exceeds the ${maxEntryBytes}-byte per-entry size limit`);
		}
		const dataOffset = offset + 512;
		const paddedSize = Math.ceil(size / 512) * 512;
		const nextOffset = dataOffset + paddedSize;
		if (nextOffset > tarBytes.length) throw new Error("Truncated tar entry");
		const data = tarBytes.subarray(dataOffset, dataOffset + size);
		const typeFlag = String.fromCharCode(header[156] ?? 0);

		if (typeFlag === "x" || typeFlag === "g") {
			const pax = parsePaxRecords(data);
			if (typeFlag === "g") {
				for (const [key, value] of pax) globalPax.set(key, value);
			} else {
				for (const [key, value] of pax) localPax.set(key, value);
			}
			offset = nextOffset;
			continue;
		}

		if (typeFlag === "L" || typeFlag === "K") {
			const value = decodeLongTarValue(data, typeFlag === "L" ? "long path" : "long link path");
			if (typeFlag === "L") longPath = value;
			else longLinkPath = value;
			offset = nextOffset;
			continue;
		}

		const headerName = decodeTarString(header.subarray(0, 100), "entry path");
		const prefix = decodeTarString(header.subarray(345, 500), "entry prefix");
		const combinedHeaderName = prefix ? `${prefix}/${headerName}` : headerName;
		const effectivePax = new Map(globalPax);
		for (const [key, value] of localPax) effectivePax.set(key, value);
		const paxSize = effectivePax.get("size");
		if (paxSize !== undefined && (!/^[0-9]+$/.test(paxSize) || Number(paxSize) !== size)) {
			throw new Error("Unsupported PAX size override");
		}
		const entryPath = effectivePax.get("path") ?? longPath ?? combinedHeaderName;
		const headerLinkPath = decodeTarString(header.subarray(157, 257), "link path");
		const linkPath = effectivePax.get("linkpath") ?? longLinkPath ?? headerLinkPath;
		if (linkPath && typeFlag !== "1" && typeFlag !== "2") {
			throw new Error(`Unexpected link target on regular tar entry: ${entryPath}`);
		}

		let type: ReleaseArchiveEntryType;
		if (typeFlag === "\0" || typeFlag === "0") type = "file";
		else if (typeFlag === "5") type = "directory";
		else if (typeFlag === "2") type = "symlink";
		else if (typeFlag === "1") type = "hardlink";
		else type = "other";

		entries.push({ path: entryPath, type });
		localPax = new Map<string, string>();
		longPath = undefined;
		longLinkPath = undefined;
		offset = nextOffset;
	}

	if (localPax.size > 0 || longPath || longLinkPath) {
		throw new Error("Dangling tar metadata record");
	}
	if (entries.length === 0) throw new Error("Runtime resource archive is empty");
	return entries;
}

function normalizeArchivePath(entryPath: string): string {
	if (!entryPath || /[\u0000-\u001f\u007f]/.test(entryPath)) {
		throw new Error("Archive contains an empty or control-character path");
	}
	if (entryPath.includes("\\")) throw new Error(`Archive path uses a backslash: ${entryPath}`);
	if (entryPath.startsWith("/") || /^[A-Za-z]:/.test(entryPath)) {
		throw new Error(`Archive path is absolute: ${entryPath}`);
	}

	const withoutTrailingSlash = entryPath.endsWith("/") ? entryPath.slice(0, -1) : entryPath;
	const segments = withoutTrailingSlash.split("/");
	if (
		withoutTrailingSlash.length === 0 ||
		segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
	) {
		throw new Error(`Archive path is unsafe: ${entryPath}`);
	}
	for (const segment of segments) {
		if (segment.includes(":") || /[. ]$/.test(segment) || windowsReservedNamePattern.test(segment)) {
			throw new Error(`Archive path is not cross-platform safe: ${entryPath}`);
		}
	}
	return withoutTrailingSlash;
}

export function validateReleaseArchiveEntries(entries: readonly ReleaseArchiveEntry[]): string[] {
	const directoryRoots = new Set<string>(RESOURCE_DIRECTORY_NAMES);
	const fileRoots = new Set<string>([...RESOURCE_FILE_NAMES, RELEASE_RESOURCE_MARKER_NAME]);
	const normalizedPaths = new Set<string>();
	const caseFoldedPaths = new Set<string>();
	const topLevelNames = new Set<string>();

	for (const entry of entries) {
		if (entry.type !== "file" && entry.type !== "directory") {
			throw new Error(`Archive contains unsupported ${entry.type}: ${entry.path}`);
		}
		const normalized = normalizeArchivePath(entry.path);
		const caseFolded = normalized.normalize("NFC").toLowerCase();
		if (normalizedPaths.has(normalized) || caseFoldedPaths.has(caseFolded)) {
			throw new Error(`Archive contains a duplicate path: ${normalized}`);
		}
		normalizedPaths.add(normalized);
		caseFoldedPaths.add(caseFolded);

		const segments = normalized.split("/");
		const topLevelName = segments[0] ?? "";
		const isTopLevelWasm = segments.length === 1 && /^[A-Za-z0-9][A-Za-z0-9._-]*\.wasm$/.test(topLevelName);
		if (!directoryRoots.has(topLevelName) && !fileRoots.has(topLevelName) && !isTopLevelWasm) {
			throw new Error(`Archive contains an unknown top-level path: ${normalized}`);
		}
		if (fileRoots.has(topLevelName) && (segments.length !== 1 || entry.type !== "file")) {
			throw new Error(`Archive top-level file has an invalid shape: ${normalized}`);
		}
		if (isTopLevelWasm && entry.type !== "file") {
			throw new Error(`Archive WASM entry is not a regular file: ${normalized}`);
		}
		if (directoryRoots.has(topLevelName) && segments.length === 1 && entry.type !== "directory") {
			throw new Error(`Archive resource root is not a directory: ${normalized}`);
		}
		topLevelNames.add(topLevelName);
	}

	for (const directoryName of RESOURCE_DIRECTORY_NAMES) {
		if (!topLevelNames.has(directoryName)) {
			throw new Error(`Runtime resource archive is missing directory: ${directoryName}`);
		}
	}
	for (const fileName of RESOURCE_FILE_NAMES) {
		if (!normalizedPaths.has(fileName)) {
			throw new Error(`Runtime resource archive is missing file: ${fileName}`);
		}
	}
	for (const requiredPath of REQUIRED_RESOURCE_PATHS) {
		if (!normalizedPaths.has(requiredPath)) {
			throw new Error(`Runtime resource archive is missing required file: ${requiredPath}`);
		}
	}
	if (![...topLevelNames].some((name) => name.endsWith(".wasm"))) {
		throw new Error("Runtime resource archive contains no top-level WASM asset");
	}

	return [...topLevelNames].sort();
}

export async function inspectReleaseResourceArchive(archivePath: string): Promise<string[]> {
	const entries = parseReleaseArchive(await readFile(archivePath));
	return validateReleaseArchiveEntries(entries);
}

async function assertDirectory(path: string, label: string): Promise<void> {
	const stats = await lstat(path);
	if (!stats.isDirectory() || stats.isSymbolicLink()) {
		throw new Error(`Runtime resource is not a directory: ${label}`);
	}
}

async function assertRegularFile(path: string, label: string): Promise<void> {
	const stats = await lstat(path);
	if (!stats.isFile() || stats.isSymbolicLink()) {
		throw new Error(`Runtime resource is not a regular file: ${label}`);
	}
}

export async function validateExtractedReleaseResources(
	stagingDirectory: string,
	topLevelNames: readonly string[],
	expectedVersion?: string,
): Promise<void> {
	for (const directoryName of RESOURCE_DIRECTORY_NAMES) {
		await assertDirectory(join(stagingDirectory, directoryName), directoryName);
	}
	for (const fileName of RESOURCE_FILE_NAMES) {
		await assertRegularFile(join(stagingDirectory, fileName), fileName);
	}
	for (const requiredPath of REQUIRED_RESOURCE_PATHS) {
		await assertRegularFile(join(stagingDirectory, ...requiredPath.split("/")), requiredPath);
	}
	for (const topLevelName of topLevelNames) {
		if (topLevelName.endsWith(".wasm")) {
			await assertRegularFile(join(stagingDirectory, topLevelName), topLevelName);
		}
	}
	if (expectedVersion !== undefined) {
		await ensureReleaseResourceVersion(stagingDirectory, expectedVersion, [
			...topLevelNames,
			RELEASE_RESOURCE_MARKER_NAME,
			"_magenta",
		]);
	}
}

function parseInstalledReleaseOwnership(content: string, markerPath: string): InstalledReleaseOwnership {
	let marker: unknown;
	try {
		marker = JSON.parse(content);
	} catch {
		throw new Error(`Runtime resource marker is invalid: ${markerPath}`);
	}
	if (typeof marker !== "object" || marker === null || Array.isArray(marker)) {
		throw new Error(`Runtime resource marker is invalid: ${markerPath}`);
	}
	const candidate = marker as Record<string, unknown>;
	if (typeof candidate.version !== "string" || !releaseMarkerVersionPattern.test(candidate.version)) {
		throw new Error(`Runtime resource marker is invalid: ${markerPath}`);
	}
	const keys = Object.keys(candidate).sort();
	if (keys.length === 1 && keys[0] === "version") return { version: candidate.version };
	if (
		keys.length !== 3 ||
		keys[0] !== "resourceNames" ||
		keys[1] !== "schema" ||
		keys[2] !== "version" ||
		candidate.schema !== INSTALLED_RELEASE_MARKER_SCHEMA ||
		!Array.isArray(candidate.resourceNames)
	) {
		throw new Error(`Runtime resource marker has an unsupported ownership schema: ${markerPath}`);
	}
	const resourceNames = candidate.resourceNames as unknown[];
	if (
		resourceNames.length === 0 ||
		resourceNames.length > 128 ||
		resourceNames.some((name) => typeof name !== "string" || !isManagedReleaseResourceName(name)) ||
		new Set(resourceNames).size !== resourceNames.length ||
		!resourceNames.includes(RELEASE_RESOURCE_MARKER_NAME)
	) {
		throw new Error(`Runtime resource marker has an unsafe ownership manifest: ${markerPath}`);
	}
	return { version: candidate.version, resourceNames: resourceNames as string[] };
}

export async function readInstalledReleaseOwnership(resourceDirectory: string): Promise<InstalledReleaseOwnership> {
	const markerPath = join(resourceDirectory, RELEASE_RESOURCE_MARKER_NAME);
	await assertRegularFile(markerPath, RELEASE_RESOURCE_MARKER_NAME);
	const content = await secureReadFile(markerPath, {
		requireOwnerWritable: false,
		maxBytes: RELEASE_RESOURCE_MARKER_MAX_BYTES,
	});
	return parseInstalledReleaseOwnership(content.toString("utf8"), markerPath);
}

export async function writeInstalledReleaseOwnership(
	resourceDirectory: string,
	expectedVersion: string,
	resourceNames: readonly string[],
): Promise<void> {
	if (!releaseMarkerVersionPattern.test(expectedVersion)) {
		throw new Error(`Invalid installed release version: ${expectedVersion}`);
	}
	const normalizedNames = [...new Set([...resourceNames, RELEASE_RESOURCE_MARKER_NAME])].sort();
	if (normalizedNames.length > 128 || normalizedNames.some((name) => !isManagedReleaseResourceName(name))) {
		throw new Error("Installed release ownership manifest contains an unsafe resource name");
	}
	const markerPath = join(resourceDirectory, RELEASE_RESOURCE_MARKER_NAME);
	try {
		await assertRegularFile(markerPath, RELEASE_RESOURCE_MARKER_NAME);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const content = `${JSON.stringify({
		schema: INSTALLED_RELEASE_MARKER_SCHEMA,
		version: expectedVersion,
		resourceNames: normalizedNames,
	})}\n`;
	const temporaryPath = join(resourceDirectory, INSTALLED_RELEASE_MARKER_TEMP_NAME);
	let pendingExists = false;
	try {
		const stats = await lstat(temporaryPath);
		if (!stats.isFile() || stats.isSymbolicLink() || (currentUid() !== undefined && stats.uid !== currentUid())) {
			throw new Error(`Installed release marker temporary path is unsafe: ${temporaryPath}`);
		}
		pendingExists = true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (pendingExists) {
		const pendingContent = await secureReadFile(temporaryPath, {
			requireOwnerWritable: false,
			maxBytes: RELEASE_RESOURCE_MARKER_MAX_BYTES,
		});
		if (pendingContent.toString("utf8") !== content) {
			throw new Error(
				`Installed release marker temporary file does not match the requested ownership: ${temporaryPath}`,
			);
		}
	} else {
		const handle = await open(temporaryPath, "wx", 0o600);
		try {
			await handle.writeFile(content, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
	}
	await rename(temporaryPath, markerPath);
	await chmod(markerPath, 0o644);
	await syncDirectory(resourceDirectory);
}

export async function ensureReleaseResourceVersion(
	resourceDirectory: string,
	expectedVersion: string,
	managedResourceNames?: readonly string[],
): Promise<void> {
	const markerPath = join(resourceDirectory, RELEASE_RESOURCE_MARKER_NAME);
	try {
		await lstat(markerPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		if (managedResourceNames) {
			await writeInstalledReleaseOwnership(resourceDirectory, expectedVersion, managedResourceNames);
		} else {
			await writeFile(markerPath, `${JSON.stringify({ version: expectedVersion })}\n`, {
				encoding: "utf8",
				flag: "wx",
			});
		}
		return;
	}
	await assertReleaseResourceVersion(resourceDirectory, expectedVersion);
	if (managedResourceNames) {
		await writeInstalledReleaseOwnership(resourceDirectory, expectedVersion, managedResourceNames);
	}
}

export async function assertReleaseResourceVersion(resourceDirectory: string, expectedVersion: string): Promise<void> {
	const marker = await readInstalledReleaseOwnership(resourceDirectory);
	if (marker.version !== expectedVersion) {
		throw new Error(`Runtime resources do not match Magenta ${expectedVersion}`);
	}
}

export async function currentReleaseResourcesAreValid(
	resourceDirectory: string,
	expectedVersion: string,
): Promise<boolean> {
	try {
		await assertReleaseResourceVersion(resourceDirectory, expectedVersion);
		for (const directoryName of RESOURCE_DIRECTORY_NAMES) {
			await assertDirectory(join(resourceDirectory, directoryName), directoryName);
		}
		for (const fileName of RESOURCE_FILE_NAMES) {
			await assertRegularFile(join(resourceDirectory, fileName), fileName);
		}
		for (const requiredPath of getInstalledRequiredResourcePaths()) {
			await assertRegularFile(join(resourceDirectory, ...requiredPath.split("/")), requiredPath);
		}
		return true;
	} catch {
		return false;
	}
}

export interface UpdateTransactionFileSystem {
	pathExists(path: string): Promise<boolean>;
	makeDirectory(path: string): Promise<void>;
	movePath(source: string, destination: string): Promise<void>;
	removePath(path: string): Promise<void>;
}

export const NODE_UPDATE_TRANSACTION_FILE_SYSTEM: UpdateTransactionFileSystem = {
	async pathExists(path) {
		try {
			await lstat(path);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	},
	async makeDirectory(path) {
		await mkdir(path, { mode: 0o700 });
	},
	async movePath(source, destination) {
		await rename(source, destination);
	},
	async removePath(path) {
		await rm(path, { recursive: true, force: true });
	},
};

export type ReleaseUpdateTransactionKind = "resources" | "unix" | "windows";
type ReleaseUpdateTransactionPhase = "staging" | "prepared" | "rolling_back" | "committed";

/** Stable metadata captured for every path that existed before activation. */
interface ReleaseUpdatePathIdentity {
	name: string;
	type: "file" | "directory";
	device: string;
	inode: string;
	size: string;
	mode: string;
	birthtimeMs: string;
	mtimeMs: string;
}

interface ReleaseUpdateTransactionJournal {
	version:
		| typeof RELEASE_UPDATE_JOURNAL_VERSION
		| typeof PREVIOUS_RELEASE_UPDATE_JOURNAL_VERSION
		| typeof PREVIOUS_V4_RELEASE_UPDATE_JOURNAL_VERSION
		| typeof PREVIOUS_V3_RELEASE_UPDATE_JOURNAL_VERSION
		| typeof PREVIOUS_V2_RELEASE_UPDATE_JOURNAL_VERSION
		| typeof LEGACY_RELEASE_UPDATE_JOURNAL_VERSION;
	operationId: string;
	kind: ReleaseUpdateTransactionKind;
	binaryName: string | null;
	originalBinaryPresent: boolean | null;
	binarySha256: string | null;
	targetVersion: string | null;
	/** Resources copied from staging into the installation at activation. */
	installResourceNames: string[];
	/** Previously marker-owned resources intentionally retired by this update. */
	removeResourceNames: string[];
	originalResourceNames: string[];
	/** Null for legacy journals that predate path identity binding. */
	originalPathIdentities: ReleaseUpdatePathIdentity[] | null;
	/** Staged objects expected to occupy installed paths after activation; null for v1-v5. */
	installedPathIdentities: ReleaseUpdatePathIdentity[] | null;
	phase: ReleaseUpdateTransactionPhase;
	/** PID of the detached Windows helper which owns a prepared transaction. */
	helperPid: number | null;
	/** Invariant UTC `DateTime.ToString("o")` value for that helper process. */
	helperStartTimeUtc: string | null;
}

export interface InitializeReleaseUpdateTransactionOptions {
	installDirectory: string;
	operationId: string;
	kind: ReleaseUpdateTransactionKind;
	binaryName?: string;
	originalBinaryPresent?: boolean;
	targetVersion?: string;
}

export interface RecoverReleaseUpdateTransactionOptions {
	/** The version of the currently running binary, used only to finish a fully switched transaction. */
	runningVersion?: string;
	/** @internal Deterministic process probe for recovery tests. */
	helperProcessIsAlive?: (pid: number) => boolean | Promise<boolean>;
	/** @internal Deterministic process creation-time probe for recovery tests. */
	helperProcessStartTimeUtc?: (pid: number) => string | undefined | Promise<string | undefined>;
	/** @internal Deterministic replacement race immediately before rollback claims a path. */
	testBeforeRollbackMutation?: (path: string) => void | Promise<void>;
	/** @internal Deterministic crash immediately after a rollback path has been claimed. */
	testAfterRollbackClaim?: (path: string, quarantinePath: string) => void | Promise<void>;
	/** @internal Deterministic crash after an original path has been published without overwrite. */
	testAfterRollbackPublication?: (sourcePath: string, destinationPath: string) => void | Promise<void>;
	/** @internal Deterministic crash after rollback is complete but before terminal intent is durable. */
	testBeforeRollbackTerminalJournal?: () => void | Promise<void>;
}

const operationIdPattern = /^[0-9a-f]{32}$/;
const transactionPhaseSet = new Set<ReleaseUpdateTransactionPhase>([
	"staging",
	"prepared",
	"rolling_back",
	"committed",
]);

function assertSafeOperationId(operationId: string): void {
	if (!operationIdPattern.test(operationId)) {
		throw new Error("Unsafe update operation id");
	}
}

function updateTransactionDirectoryNames(
	kind: ReleaseUpdateTransactionKind,
	operationId: string,
): { stagingName: string; backupName: string; scriptName?: string } {
	assertSafeOperationId(operationId);
	if (kind === "resources") {
		return {
			stagingName: `.magenta-resource-staging-${operationId}`,
			backupName: `.magenta-resource-backup-${operationId}`,
		};
	}
	return {
		stagingName: `.magenta-update-staging-${operationId}`,
		backupName: `.magenta-update-backup-${operationId}`,
		scriptName: kind === "windows" ? `.magenta-update-${operationId}.ps1` : undefined,
	};
}

function updateTransactionPaths(installDirectory: string, journal: ReleaseUpdateTransactionJournal) {
	const names = updateTransactionDirectoryNames(journal.kind, journal.operationId);
	return {
		journalPath: join(installDirectory, RELEASE_UPDATE_JOURNAL_NAME),
		journalTempPath: join(installDirectory, RELEASE_UPDATE_JOURNAL_TEMP_NAME),
		stagingDirectory: join(installDirectory, names.stagingName),
		backupDirectory: join(installDirectory, names.backupName),
		scriptPath: names.scriptName ? join(installDirectory, names.scriptName) : undefined,
	};
}

function assertPathIsDirectChild(parent: string, child: string, expectedBasename: string): void {
	if (resolve(dirname(child)) !== resolve(parent) || basename(child) !== expectedBasename) {
		throw new Error(`Unsafe update transaction path: ${child}`);
	}
}

function currentUid(): number | undefined {
	return typeof process.getuid === "function" ? process.getuid() : undefined;
}

async function assertOwnedPath(path: string, options: { type?: "file" | "directory"; privateFile?: boolean } = {}) {
	const stats = await lstat(path);
	if (stats.isSymbolicLink()) throw new Error(`Update transaction path is a symbolic link: ${path}`);
	if (options.type === "file" && !stats.isFile()) {
		throw new Error(`Update transaction path is not a regular file: ${path}`);
	}
	if (options.type === "directory" && !stats.isDirectory()) {
		throw new Error(`Update transaction path is not a directory: ${path}`);
	}
	const uid = currentUid();
	if (uid !== undefined && stats.uid !== uid) {
		throw new Error(`Update transaction path is not owned by the current user: ${path}`);
	}
	if (options.privateFile && process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
		throw new Error(`Update transaction journal permissions are not private: ${path}`);
	}
	return stats;
}

function roundedNanosecondsToMilliseconds(value: bigint, label: string): string {
	if (value < 0n) throw new Error(`Update transaction ${label} timestamp is invalid`);
	return ((value + 500_000n) / 1_000_000n).toString();
}

function capturePathIdentity(name: string, stats: BigIntStats): ReleaseUpdatePathIdentity {
	if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) {
		throw new Error(`Update transaction original path is not a regular file or directory: ${name}`);
	}
	return {
		name,
		type: stats.isFile() ? "file" : "directory",
		device: stats.dev.toString(),
		inode: stats.ino.toString(),
		size: stats.size.toString(),
		mode: (stats.mode & 0o7777n).toString(),
		birthtimeMs: roundedNanosecondsToMilliseconds(stats.birthtimeNs, `${name} birthtime`),
		mtimeMs: roundedNanosecondsToMilliseconds(stats.mtimeNs, `${name} mtime`),
	};
}

async function captureOwnedPathIdentity(name: string, path: string): Promise<ReleaseUpdatePathIdentity> {
	await assertOwnedPath(path);
	return capturePathIdentity(name, await lstat(path, { bigint: true }));
}

function samePathIdentity(expected: ReleaseUpdatePathIdentity, actual: ReleaseUpdatePathIdentity): boolean {
	return (
		expected.name === actual.name &&
		expected.type === actual.type &&
		expected.device === actual.device &&
		expected.inode === actual.inode &&
		expected.size === actual.size &&
		expected.mode === actual.mode &&
		expected.birthtimeMs === actual.birthtimeMs &&
		expected.mtimeMs === actual.mtimeMs
	);
}

async function assertPathIdentity(path: string, expected: ReleaseUpdatePathIdentity): Promise<void> {
	const actual = capturePathIdentity(expected.name, await lstat(path, { bigint: true }));
	if (!samePathIdentity(expected, actual)) {
		throw new Error(`Update transaction path identity changed: ${path}`);
	}
}

function findOriginalPathIdentity(
	journal: ReleaseUpdateTransactionJournal,
	name: string,
): ReleaseUpdatePathIdentity | undefined {
	return journal.originalPathIdentities?.find((identity) => identity.name === name);
}

function requireOriginalPathIdentity(
	journal: ReleaseUpdateTransactionJournal,
	name: string,
): ReleaseUpdatePathIdentity {
	const identity = findOriginalPathIdentity(journal, name);
	if (!identity) {
		throw new Error(`Update transaction has no identity for original path: ${name}`);
	}
	return identity;
}

function findInstalledPathIdentity(
	journal: ReleaseUpdateTransactionJournal,
	name: string,
): ReleaseUpdatePathIdentity | undefined {
	return journal.installedPathIdentities?.find((identity) => identity.name === name);
}

function requireInstalledPathIdentity(
	journal: ReleaseUpdateTransactionJournal,
	name: string,
): ReleaseUpdatePathIdentity {
	const identity = findInstalledPathIdentity(journal, name);
	if (!identity) {
		throw new Error(`Update transaction has no identity for installed path: ${name}`);
	}
	return identity;
}

const releaseUpdatePathIdentityKeys = [
	"birthtimeMs",
	"device",
	"inode",
	"mode",
	"mtimeMs",
	"name",
	"size",
	"type",
] as const;

function parseReleaseUpdatePathIdentities(
	value: unknown,
	label: "original" | "installed",
	allowedNames: ReadonlySet<string>,
	expectedNames: ReadonlySet<string>,
): ReleaseUpdatePathIdentity[] {
	if (!Array.isArray(value)) {
		throw new Error(`Current update transaction journal has invalid ${label} path identities`);
	}
	const identities: ReleaseUpdatePathIdentity[] = [];
	const seenNames = new Set<string>();
	for (const rawIdentity of value) {
		if (typeof rawIdentity !== "object" || rawIdentity === null || Array.isArray(rawIdentity)) {
			throw new Error(`Update transaction journal has an invalid ${label} path identity`);
		}
		const identity = rawIdentity as Record<string, unknown>;
		const identityName = identity.name;
		const identityKeys = Object.keys(identity).sort();
		if (
			identityKeys.length !== releaseUpdatePathIdentityKeys.length ||
			identityKeys.some((key, index) => key !== releaseUpdatePathIdentityKeys[index])
		) {
			throw new Error(`Update transaction journal has an unsupported ${label} path identity schema`);
		}
		if (
			typeof identityName !== "string" ||
			!allowedNames.has(identityName) ||
			(identity.type !== "file" && identity.type !== "directory") ||
			!["device", "inode", "size", "mode", "birthtimeMs", "mtimeMs"].every(
				(field) => typeof identity[field] === "string" && /^\d+$/.test(identity[field] as string),
			) ||
			seenNames.has(identityName)
		) {
			throw new Error(`Update transaction journal has an unsafe ${label} path identity`);
		}
		seenNames.add(identityName);
		identities.push(identity as unknown as ReleaseUpdatePathIdentity);
	}
	if (seenNames.size !== expectedNames.size || [...expectedNames].some((name) => !seenNames.has(name))) {
		throw new Error(`Update transaction journal ${label} path identities do not match its ${label} paths`);
	}
	return identities;
}

async function ownedPathExists(path: string, type?: "file" | "directory"): Promise<boolean> {
	try {
		await assertOwnedPath(path, { type });
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function syncFile(path: string): Promise<void> {
	const handle = await open(path, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function syncDirectory(path: string): Promise<void> {
	let handle: FileHandle | undefined;
	try {
		handle = await open(path, "r");
		await handle.sync();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (process.platform !== "win32" || !["EACCES", "EINVAL", "ENOTSUP", "EPERM"].includes(code ?? "")) {
			throw error;
		}
	} finally {
		await handle?.close();
	}
}

function parseReleaseUpdateJournal(content: string): ReleaseUpdateTransactionJournal {
	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch {
		throw new Error("Update transaction journal is corrupted");
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Update transaction journal is corrupted");
	}
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.version !== "number" || !Number.isInteger(candidate.version)) {
		throw new Error("Update transaction journal has an invalid version type");
	}
	const keys = Object.keys(candidate).sort();
	const legacyKeys = [
		"binaryName",
		"kind",
		"operationId",
		"originalResourceNames",
		"phase",
		"resourceNames",
		"targetVersion",
		"version",
	].sort();
	const currentKeys = [...legacyKeys, "binarySha256", "originalBinaryPresent"].sort();
	// Accept every historical shape. v2 briefly existed both with and without
	// helperPid, and v3/v4 added the detached-helper identity fields.
	const previousV2WithHelperKeys = [...currentKeys, "helperPid"].sort();
	const previousV3Keys = [...previousV2WithHelperKeys].sort();
	const previousV4Keys = [...previousV3Keys, "helperStartTimeUtc"].sort();
	const previousV5Keys = [
		"binaryName",
		"binarySha256",
		"helperPid",
		"helperStartTimeUtc",
		"installResourceNames",
		"kind",
		"operationId",
		"originalBinaryPresent",
		"originalResourceNames",
		"phase",
		"removeResourceNames",
		"targetVersion",
		"version",
	].sort();
	const currentV6Keys = [...previousV5Keys, "installedPathIdentities", "originalPathIdentities"].sort();
	const isLegacy = candidate.version === LEGACY_RELEASE_UPDATE_JOURNAL_VERSION;
	const isPreviousV5 = candidate.version === PREVIOUS_RELEASE_UPDATE_JOURNAL_VERSION;
	const isPreviousV4 = candidate.version === PREVIOUS_V4_RELEASE_UPDATE_JOURNAL_VERSION;
	const isPreviousV3 = candidate.version === PREVIOUS_V3_RELEASE_UPDATE_JOURNAL_VERSION;
	const isPreviousV2 = candidate.version === PREVIOUS_V2_RELEASE_UPDATE_JOURNAL_VERSION;
	const isCurrent = candidate.version === RELEASE_UPDATE_JOURNAL_VERSION;
	const hasPreviousV2HelperSchema =
		isPreviousV2 &&
		keys.length === previousV2WithHelperKeys.length &&
		keys.every((key, index) => key === previousV2WithHelperKeys[index]);
	const hasPreviousV3Schema =
		isPreviousV3 &&
		keys.length === previousV3Keys.length &&
		keys.every((key, index) => key === previousV3Keys[index]);
	const hasPreviousV4Schema =
		isPreviousV4 &&
		keys.length === previousV4Keys.length &&
		keys.every((key, index) => key === previousV4Keys[index]);
	const hasPreviousV5Schema =
		isPreviousV5 &&
		keys.length === previousV5Keys.length &&
		keys.every((key, index) => key === previousV5Keys[index]);
	const expectedKeys = isLegacy
		? legacyKeys
		: isPreviousV2
			? hasPreviousV2HelperSchema
				? previousV2WithHelperKeys
				: currentKeys
			: isPreviousV3
				? previousV3Keys
				: isPreviousV4
					? previousV4Keys
					: isPreviousV5
						? previousV5Keys
						: currentV6Keys;
	if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
		throw new Error("Update transaction journal has an unsupported schema");
	}
	if (!isLegacy && !isPreviousV2 && !isPreviousV3 && !isPreviousV4 && !isPreviousV5 && !isCurrent) {
		throw new Error("Update transaction journal has an unsupported version");
	}
	if (candidate.kind !== "resources" && candidate.kind !== "unix" && candidate.kind !== "windows") {
		throw new Error("Update transaction journal has an invalid kind");
	}
	if (typeof candidate.operationId !== "string" || !operationIdPattern.test(candidate.operationId)) {
		throw new Error("Update transaction journal has an unsafe operation id");
	}
	if (
		typeof candidate.phase !== "string" ||
		!transactionPhaseSet.has(candidate.phase as ReleaseUpdateTransactionPhase)
	) {
		throw new Error("Update transaction journal has an invalid phase");
	}
	if (candidate.targetVersion !== null && typeof candidate.targetVersion !== "string") {
		throw new Error("Update transaction journal has an invalid target version");
	}
	const installValues = isCurrent || isPreviousV5 ? candidate.installResourceNames : candidate.resourceNames;
	const removeValues = isCurrent || isPreviousV5 ? candidate.removeResourceNames : [];
	if (
		!Array.isArray(installValues) ||
		!Array.isArray(removeValues) ||
		!Array.isArray(candidate.originalResourceNames)
	) {
		throw new Error("Update transaction journal has invalid resource lists");
	}
	const installResourceNames = installValues as unknown[];
	const removeResourceNames = removeValues as unknown[];
	const originalResourceNames = candidate.originalResourceNames as unknown[];
	if (
		installResourceNames.some((name) => typeof name !== "string" || !isSafeUpdateResourceName(name)) ||
		new Set(installResourceNames).size !== installResourceNames.length ||
		removeResourceNames.some((name) => typeof name !== "string" || !isManagedReleaseResourceName(name)) ||
		new Set(removeResourceNames).size !== removeResourceNames.length ||
		removeResourceNames.some((name) => installResourceNames.includes(name)) ||
		originalResourceNames.some(
			(name) =>
				typeof name !== "string" || (!installResourceNames.includes(name) && !removeResourceNames.includes(name)),
		) ||
		new Set(originalResourceNames).size !== originalResourceNames.length
	) {
		throw new Error("Update transaction journal has unsafe resource names");
	}
	const originalBinaryPresent = isLegacy
		? candidate.kind === "resources"
			? null
			: true
		: candidate.originalBinaryPresent;
	const binarySha256 = isLegacy ? null : candidate.binarySha256;
	const helperPid =
		isCurrent || hasPreviousV5Schema || hasPreviousV4Schema || hasPreviousV3Schema || hasPreviousV2HelperSchema
			? candidate.helperPid
			: null;
	const helperStartTimeUtc =
		isCurrent || hasPreviousV5Schema || hasPreviousV4Schema ? candidate.helperStartTimeUtc : null;
	if (
		helperStartTimeUtc !== null &&
		(typeof helperStartTimeUtc !== "string" ||
			!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/.test(helperStartTimeUtc))
	) {
		throw new Error("Update transaction journal has an invalid helper start time");
	}
	if (helperStartTimeUtc !== null && helperPid === null) {
		throw new Error("Update transaction journal has a helper start time without a helper PID");
	}
	if (
		(isCurrent || hasPreviousV5Schema || hasPreviousV4Schema) &&
		(helperPid === null) !== (helperStartTimeUtc === null)
	) {
		throw new Error("Update transaction journal has an incomplete helper identity");
	}
	if (
		helperPid !== null &&
		(typeof helperPid !== "number" || !Number.isSafeInteger(helperPid) || helperPid <= 0 || helperPid > 0x7fffffff)
	) {
		throw new Error("Update transaction journal has an invalid helper PID");
	}
	if (candidate.kind !== "windows" && helperPid !== null) {
		throw new Error("Non-Windows update transaction contains a helper PID");
	}
	if (candidate.kind === "resources") {
		if (candidate.binaryName !== null) throw new Error("Resource transaction journal contains a binary name");
		if (originalBinaryPresent !== null || binarySha256 !== null) {
			throw new Error("Resource transaction journal contains binary state");
		}
	} else if (
		typeof candidate.binaryName !== "string" ||
		!isSafeArtifactBasename(candidate.binaryName) ||
		installResourceNames.includes(candidate.binaryName)
	) {
		throw new Error("Update transaction journal has an unsafe binary name");
	} else {
		if (typeof originalBinaryPresent !== "boolean") {
			throw new Error("Update transaction journal has invalid previous binary state");
		}
		if (binarySha256 !== null && (typeof binarySha256 !== "string" || !/^[0-9a-f]{64}$/.test(binarySha256))) {
			throw new Error("Update transaction journal has an invalid binary digest");
		}
		if (candidate.phase !== "staging" && originalBinaryPresent === false && binarySha256 === null) {
			throw new Error("Fresh install transaction journal has no binary digest");
		}
	}
	if (candidate.phase !== "staging" && installResourceNames.length === 0) {
		throw new Error("Prepared update transaction journal contains no resources");
	}
	const originalPathIdentities = isCurrent
		? parseReleaseUpdatePathIdentities(
				candidate.originalPathIdentities,
				"original",
				new Set([
					...(installResourceNames as string[]),
					...(removeResourceNames as string[]),
					...(candidate.kind === "resources" ? [] : [candidate.binaryName as string]),
				]),
				candidate.phase === "staging"
					? new Set()
					: new Set([
							...(originalResourceNames as string[]),
							...(candidate.kind !== "resources" && originalBinaryPresent === true
								? [candidate.binaryName as string]
								: []),
						]),
			)
		: null;
	const installedPathIdentities = isCurrent
		? parseReleaseUpdatePathIdentities(
				candidate.installedPathIdentities,
				"installed",
				new Set(installResourceNames as string[]),
				candidate.phase === "staging" ? new Set() : new Set(installResourceNames as string[]),
			)
		: null;
	return {
		version: candidate.version as ReleaseUpdateTransactionJournal["version"],
		operationId: candidate.operationId as string,
		kind: candidate.kind as ReleaseUpdateTransactionKind,
		binaryName: candidate.binaryName as string | null,
		originalBinaryPresent: originalBinaryPresent as boolean | null,
		binarySha256: binarySha256 as string | null,
		targetVersion: candidate.targetVersion as string | null,
		installResourceNames: installResourceNames as string[],
		removeResourceNames: removeResourceNames as string[],
		originalResourceNames: originalResourceNames as string[],
		originalPathIdentities,
		installedPathIdentities,
		phase: candidate.phase as ReleaseUpdateTransactionPhase,
		helperPid,
		helperStartTimeUtc,
	};
}

async function readJournalFile(path: string): Promise<ReleaseUpdateTransactionJournal> {
	const stats = await assertOwnedPath(path, { type: "file", privateFile: true });
	if (stats.size > RELEASE_UPDATE_JOURNAL_MAX_BYTES) throw new Error("Update transaction journal is too large");
	const content = await secureReadFile(path, {
		requireOwnerWritable: false,
		maxBytes: RELEASE_UPDATE_JOURNAL_MAX_BYTES,
	});
	return parseReleaseUpdateJournal(content.toString("utf8"));
}

function serializeReleaseUpdateJournal(journal: ReleaseUpdateTransactionJournal): Record<string, unknown> {
	const serialized: Record<string, unknown> = {
		version: journal.version,
		operationId: journal.operationId,
		kind: journal.kind,
		binaryName: journal.binaryName,
		targetVersion: journal.targetVersion,
		...(journal.version >= PREVIOUS_RELEASE_UPDATE_JOURNAL_VERSION
			? {
					installResourceNames: journal.installResourceNames,
					removeResourceNames: journal.removeResourceNames,
				}
			: { resourceNames: journal.installResourceNames }),
		originalResourceNames: journal.originalResourceNames,
		phase: journal.phase,
	};
	if (journal.version >= PREVIOUS_V2_RELEASE_UPDATE_JOURNAL_VERSION) {
		serialized.binarySha256 = journal.binarySha256;
		serialized.originalBinaryPresent = journal.originalBinaryPresent;
	}
	if (journal.version >= PREVIOUS_V3_RELEASE_UPDATE_JOURNAL_VERSION || journal.helperPid !== null) {
		serialized.helperPid = journal.helperPid;
	}
	if (journal.version >= PREVIOUS_V4_RELEASE_UPDATE_JOURNAL_VERSION) {
		serialized.helperStartTimeUtc = journal.helperStartTimeUtc;
	}
	if (journal.version >= RELEASE_UPDATE_JOURNAL_VERSION) {
		serialized.originalPathIdentities = journal.originalPathIdentities ?? [];
		serialized.installedPathIdentities = journal.installedPathIdentities ?? [];
	}
	return serialized;
}

async function writeReleaseUpdateJournal(
	installDirectory: string,
	journal: ReleaseUpdateTransactionJournal,
): Promise<void> {
	const serialized = serializeReleaseUpdateJournal(journal);
	parseReleaseUpdateJournal(JSON.stringify(serialized));
	await assertOwnedPath(installDirectory, { type: "directory" });
	const journalPath = join(installDirectory, RELEASE_UPDATE_JOURNAL_NAME);
	const tempPath = join(installDirectory, RELEASE_UPDATE_JOURNAL_TEMP_NAME);
	if (await ownedPathExists(tempPath)) {
		throw new Error(`Update transaction journal temporary file already exists: ${tempPath}`);
	}
	if (await ownedPathExists(journalPath)) {
		await assertOwnedPath(journalPath, { type: "file", privateFile: true });
	}
	const handle = await open(tempPath, "wx", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(serialized)}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await rename(tempPath, journalPath);
		await chmod(journalPath, 0o600);
		await syncDirectory(installDirectory);
	} catch (error) {
		await rm(tempPath, { force: true }).catch(() => undefined);
		throw error;
	}
}

async function removeOwnedPath(path: string, type?: "file" | "directory"): Promise<void> {
	if (!(await ownedPathExists(path, type))) return;
	await rm(path, { recursive: type === "directory", force: false });
}

async function cleanupTransactionArtifacts(
	installDirectory: string,
	journal: ReleaseUpdateTransactionJournal,
): Promise<void> {
	const paths = updateTransactionPaths(installDirectory, journal);
	await removeOwnedPath(paths.backupDirectory, "directory");
	await removeOwnedPath(paths.stagingDirectory, "directory");
	if (paths.scriptPath) await removeOwnedPath(paths.scriptPath, "file");
	await removeOwnedPath(paths.journalTempPath, "file");
	await removeOwnedPath(paths.journalPath, "file");
	await syncDirectory(installDirectory);
}

async function readPendingJournal(installDirectory: string): Promise<ReleaseUpdateTransactionJournal | undefined> {
	const journalPath = join(installDirectory, RELEASE_UPDATE_JOURNAL_NAME);
	const tempPath = join(installDirectory, RELEASE_UPDATE_JOURNAL_TEMP_NAME);
	const hasJournal = await ownedPathExists(journalPath);
	const hasTemp = await ownedPathExists(tempPath);
	if (!hasJournal && !hasTemp) return undefined;
	if (!hasJournal) {
		const tempJournal = await readJournalFile(tempPath);
		if (tempJournal.phase !== "staging") {
			throw new Error("Update transaction has only a non-staging temporary journal; refusing recovery");
		}
		await rename(tempPath, journalPath);
		await chmod(journalPath, 0o600);
		await syncDirectory(installDirectory);
		return tempJournal;
	}
	const journal = await readJournalFile(journalPath);
	if (hasTemp) {
		const temporaryJournal = await readJournalFile(tempPath);
		const sameNames = (left: readonly string[], right: readonly string[]) =>
			left.length === right.length && left.every((name, index) => name === right[index]);
		const sameIdentities = (left: ReleaseUpdatePathIdentity[] | null, right: ReleaseUpdatePathIdentity[] | null) =>
			JSON.stringify(left) === JSON.stringify(right);
		if (
			temporaryJournal.operationId !== journal.operationId ||
			temporaryJournal.kind !== journal.kind ||
			temporaryJournal.binaryName !== journal.binaryName ||
			temporaryJournal.originalBinaryPresent !== journal.originalBinaryPresent ||
			temporaryJournal.binarySha256 !== journal.binarySha256 ||
			temporaryJournal.helperPid !== journal.helperPid ||
			temporaryJournal.helperStartTimeUtc !== journal.helperStartTimeUtc ||
			temporaryJournal.targetVersion !== journal.targetVersion ||
			!sameNames(temporaryJournal.installResourceNames, journal.installResourceNames) ||
			!sameNames(temporaryJournal.removeResourceNames, journal.removeResourceNames) ||
			!sameNames(temporaryJournal.originalResourceNames, journal.originalResourceNames) ||
			!sameIdentities(temporaryJournal.originalPathIdentities, journal.originalPathIdentities) ||
			!sameIdentities(temporaryJournal.installedPathIdentities, journal.installedPathIdentities)
		) {
			throw new Error("Update transaction journal and temporary journal disagree; refusing recovery");
		}
		// The filesystem mutation starts only after the atomic rename returns. If
		// both files exist, the durable journal is therefore the last committed
		// intent and the same-operation temp file is safe to discard.
		await removeOwnedPath(tempPath, "file");
		await syncDirectory(installDirectory);
	}
	return journal;
}

function assertTransactionOptionPaths(
	installDirectory: string,
	operationId: string,
	kind: ReleaseUpdateTransactionKind,
	stagingDirectory: string,
	backupDirectory: string,
): void {
	const names = updateTransactionDirectoryNames(kind, operationId);
	assertPathIsDirectChild(installDirectory, stagingDirectory, names.stagingName);
	assertPathIsDirectChild(installDirectory, backupDirectory, names.backupName);
}

export async function initializeReleaseUpdateTransaction(
	options: InitializeReleaseUpdateTransactionOptions,
): Promise<void> {
	assertSafeOperationId(options.operationId);
	await assertOwnedPath(options.installDirectory, { type: "directory" });
	const binaryName = options.kind === "resources" ? null : options.binaryName;
	if (options.kind !== "resources" && (!binaryName || !isSafeArtifactBasename(binaryName))) {
		throw new Error("Update transaction requires a safe binary name");
	}
	if (options.kind !== "resources" && typeof options.originalBinaryPresent !== "boolean") {
		throw new Error("Update transaction requires previous binary state");
	}
	const journal: ReleaseUpdateTransactionJournal = {
		version: RELEASE_UPDATE_JOURNAL_VERSION,
		operationId: options.operationId,
		kind: options.kind,
		binaryName: binaryName ?? null,
		originalBinaryPresent: options.kind === "resources" ? null : (options.originalBinaryPresent as boolean),
		binarySha256: null,
		targetVersion: options.targetVersion ?? null,
		installResourceNames: [],
		removeResourceNames: [],
		originalResourceNames: [],
		originalPathIdentities: [],
		installedPathIdentities: [],
		phase: "staging",
		helperPid: null,
		helperStartTimeUtc: null,
	};
	const paths = updateTransactionPaths(options.installDirectory, journal);
	if (await readPendingJournal(options.installDirectory)) {
		throw new Error("Another update transaction journal already exists");
	}
	await assertOwnedPath(paths.stagingDirectory, { type: "directory" });
	if (await ownedPathExists(paths.backupDirectory)) {
		throw new Error(`Update backup path already exists: ${paths.backupDirectory}`);
	}
	await writeReleaseUpdateJournal(options.installDirectory, journal);
}

async function assertSafeResourceCandidate(path: string): Promise<boolean> {
	try {
		await assertOwnedPath(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

function rollbackQuarantinePrefix(name: string): string {
	const nameDigest = createHash("sha256").update(name, "utf8").digest("hex");
	return `.magenta-rollback-quarantine-${nameDigest}-`;
}

function rollbackQuarantinePath(backupDirectory: string, name: string): string {
	return join(backupDirectory, `${rollbackQuarantinePrefix(name)}${randomUUID().replaceAll("-", "")}`);
}

interface RollbackTreeEntry {
	path: string;
	type: "file" | "directory";
	mode: string;
	uid: string;
	gid: string;
	size: string;
	sha256?: string;
}

function sameStablePathStats(before: BigIntStats, after: BigIntStats): boolean {
	return (
		before.dev === after.dev &&
		before.ino === after.ino &&
		before.mode === after.mode &&
		before.uid === after.uid &&
		before.gid === after.gid &&
		before.size === after.size &&
		before.mtimeNs === after.mtimeNs &&
		before.ctimeNs === after.ctimeNs &&
		before.isFile() === after.isFile() &&
		before.isDirectory() === after.isDirectory()
	);
}

async function captureRollbackTree(root: string, syncFiles: boolean): Promise<RollbackTreeEntry[]> {
	const entries: RollbackTreeEntry[] = [];
	let totalBytes = 0n;
	const visit = async (path: string, relativePath: string, depth: number): Promise<void> => {
		if (depth > 128) throw new Error(`Rollback directory tree is too deep: ${root}`);
		if (entries.length >= MAX_RELEASE_ARCHIVE_ENTRY_COUNT) {
			throw new Error(`Rollback directory tree has too many entries: ${root}`);
		}
		await assertOwnedPath(path);
		const before = await lstat(path, { bigint: true });
		if (before.isSymbolicLink() || (!before.isFile() && !before.isDirectory())) {
			throw new Error(`Rollback directory tree contains an unsupported path: ${path}`);
		}
		const uid = currentUid();
		if (uid !== undefined && before.uid !== BigInt(uid)) {
			throw new Error(`Rollback directory tree contains a path not owned by the current user: ${path}`);
		}

		let sha256: string | undefined;
		if (before.isFile()) {
			totalBytes += before.size;
			if (totalBytes > BigInt(MAX_RELEASE_ARCHIVE_EXPANDED_BYTES)) {
				throw new Error(`Rollback directory tree exceeds the byte limit: ${root}`);
			}
			if (syncFiles) await syncFile(path);
			sha256 = await calculateFileSha256(path);
		} else {
			const childNames = await readdir(path);
			childNames.sort();
			for (const childName of childNames) {
				await visit(join(path, childName), relativePath ? `${relativePath}/${childName}` : childName, depth + 1);
			}
			if (syncFiles) await syncDirectory(path);
		}

		const after = await lstat(path, { bigint: true });
		if (!sameStablePathStats(before, after)) {
			throw new Error(`Rollback directory tree changed while it was being verified: ${path}`);
		}
		entries.push({
			path: relativePath,
			type: before.isFile() ? "file" : "directory",
			mode: (before.mode & 0o7777n).toString(),
			uid: before.uid.toString(),
			gid: before.gid.toString(),
			size: before.isFile() ? before.size.toString() : "0",
			...(sha256 ? { sha256 } : {}),
		});
	};

	await visit(root, "", 0);
	entries.sort((left, right) => left.path.localeCompare(right.path));
	return entries;
}

async function rollbackDirectoryTreesEqual(left: string, right: string): Promise<boolean> {
	const [leftTree, rightTree] = await Promise.all([
		captureRollbackTree(left, false),
		captureRollbackTree(right, true),
	]);
	return JSON.stringify(leftTree) === JSON.stringify(rightTree);
}

async function findRollbackClaim(
	backupDirectory: string,
	name: string,
	expectedIdentity?: ReleaseUpdatePathIdentity,
	expectedSha256?: string,
): Promise<string | undefined> {
	let names: string[];
	try {
		names = await readdir(backupDirectory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const prefix = rollbackQuarantinePrefix(name);
	const candidates = names.filter((candidate) => candidate.startsWith(prefix));
	if (candidates.length > 1) throw new Error(`Multiple rollback claims exist for ${name}`);
	const candidate = candidates[0];
	if (!candidate) return undefined;
	if (!expectedIdentity && !expectedSha256) {
		throw new Error(`Legacy rollback claim for ${name} cannot be identified safely`);
	}
	const candidatePath = join(backupDirectory, candidate);
	await assertOwnedPath(candidatePath);
	if (expectedIdentity) await assertPathIdentity(candidatePath, expectedIdentity);
	if (expectedSha256 && (await calculateFileSha256(candidatePath)) !== expectedSha256) {
		throw new Error(`Rollback claim digest changed: ${candidatePath}`);
	}
	return candidatePath;
}

/** Publish an original rollback object while retaining its backup until terminal intent is durable. */
async function publishRollbackPathWithoutOverwrite(
	sourcePath: string,
	destinationPath: string,
	expectedIdentity: ReleaseUpdatePathIdentity,
	options: RecoverReleaseUpdateTransactionOptions = {},
): Promise<void> {
	await assertPathIdentity(sourcePath, expectedIdentity);
	const source = await assertOwnedPath(sourcePath);
	if (source.isFile()) {
		await link(sourcePath, destinationPath);
		await syncFile(destinationPath);
		await assertPathIdentity(sourcePath, expectedIdentity);
		const [linkedSource, linkedDestination] = await Promise.all([
			lstat(sourcePath, { bigint: true }),
			lstat(destinationPath, { bigint: true }),
		]);
		if (linkedSource.dev !== linkedDestination.dev || linkedSource.ino !== linkedDestination.ino) {
			throw new Error(`Rollback link publication changed identity: ${destinationPath}`);
		}
	} else if (source.isDirectory()) {
		// Node has no cross-platform rename-without-replace for directories. cp's
		// exclusive root creation fails on a destination conflict. Keeping the source
		// lets recovery prove a completed copy or fail closed after a partial copy.
		await cp(sourcePath, destinationPath, {
			recursive: true,
			force: false,
			errorOnExist: true,
			preserveTimestamps: true,
		});
		await assertPathIdentity(sourcePath, expectedIdentity);
		if (!(await rollbackDirectoryTreesEqual(sourcePath, destinationPath))) {
			throw new Error(`Rollback directory publication does not match its retained backup: ${destinationPath}`);
		}
	} else {
		throw new Error(`Rollback source has an unsupported type: ${sourcePath}`);
	}
	await Promise.all([syncDirectory(dirname(sourcePath)), syncDirectory(dirname(destinationPath))]);
	await options.testAfterRollbackPublication?.(sourcePath, destinationPath);
}

async function rollbackPathWasPublished(
	backupPath: string,
	installedPath: string,
	originalIdentity: ReleaseUpdatePathIdentity,
): Promise<boolean> {
	await assertPathIdentity(backupPath, originalIdentity);
	const [backupStats, installedStats] = await Promise.all([
		lstat(backupPath, { bigint: true }),
		lstat(installedPath, { bigint: true }),
	]);
	if (backupStats.isFile() && installedStats.isFile()) {
		return backupStats.dev === installedStats.dev && backupStats.ino === installedStats.ino;
	}
	if (backupStats.isDirectory() && installedStats.isDirectory()) {
		const equal = await rollbackDirectoryTreesEqual(backupPath, installedPath);
		await assertPathIdentity(backupPath, originalIdentity);
		return equal;
	}
	return false;
}

async function pathMatchesIdentity(path: string, expected: ReleaseUpdatePathIdentity): Promise<boolean> {
	await assertOwnedPath(path);
	return samePathIdentity(expected, capturePathIdentity(expected.name, await lstat(path, { bigint: true })));
}

async function claimRollbackPath(
	path: string,
	backupDirectory: string,
	expectedIdentity: ReleaseUpdatePathIdentity,
	options: RecoverReleaseUpdateTransactionOptions,
	expectedSha256?: string,
): Promise<string> {
	const existingClaim = await findRollbackClaim(
		backupDirectory,
		expectedIdentity.name,
		expectedIdentity,
		expectedSha256,
	);
	if (existingClaim) {
		if (await assertSafeResourceCandidate(path)) {
			throw new Error(`Rollback path and claim both exist for ${expectedIdentity.name}`);
		}
		return existingClaim;
	}
	await assertPathIdentity(path, expectedIdentity);
	if (expectedSha256 && (await calculateFileSha256(path)) !== expectedSha256) {
		throw new Error(`Rollback candidate digest changed: ${path}`);
	}
	await options.testBeforeRollbackMutation?.(path);
	const quarantinePath = rollbackQuarantinePath(backupDirectory, expectedIdentity.name);
	await rename(path, quarantinePath);
	await Promise.all([syncDirectory(dirname(path)), syncDirectory(backupDirectory)]);
	await options.testAfterRollbackClaim?.(path, quarantinePath);
	try {
		await assertPathIdentity(quarantinePath, expectedIdentity);
		if (expectedSha256 && (await calculateFileSha256(quarantinePath)) !== expectedSha256) {
			throw new Error(`Rollback candidate digest changed after claim: ${path}`);
		}
	} catch (error) {
		let disposition = `preserved at ${quarantinePath}`;
		try {
			const actualIdentity = await captureOwnedPathIdentity(expectedIdentity.name, quarantinePath);
			await publishRollbackPathWithoutOverwrite(quarantinePath, path, actualIdentity);
			disposition = `restored to ${path} and retained at ${quarantinePath}`;
		} catch (restoreError) {
			disposition += ` (automatic restore failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)})`;
		}
		throw new Error(
			`Rollback candidate changed during the validation-to-mutation window and was ${disposition}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return quarantinePath;
}

async function rollbackResource(
	installDirectory: string,
	stagingDirectory: string,
	backupDirectory: string,
	resourceName: string,
	hadOriginal: boolean,
	originalIdentity: ReleaseUpdatePathIdentity | undefined,
	installedIdentity: ReleaseUpdatePathIdentity | undefined,
	phase: ReleaseUpdateTransactionPhase,
	options: RecoverReleaseUpdateTransactionOptions,
): Promise<void> {
	const installedPath = join(installDirectory, resourceName);
	const stagedPath = join(stagingDirectory, resourceName);
	const backupPath = join(backupDirectory, resourceName);
	const [installed, staged, backup] = await Promise.all([
		assertSafeResourceCandidate(installedPath),
		assertSafeResourceCandidate(stagedPath),
		assertSafeResourceCandidate(backupPath),
	]);

	if (hadOriginal) {
		if (backup) {
			const retainedOriginalIdentity =
				originalIdentity ?? (await captureOwnedPathIdentity(resourceName, backupPath));
			await assertPathIdentity(backupPath, retainedOriginalIdentity);
			const claimedInstalled = await findRollbackClaim(backupDirectory, resourceName, installedIdentity);
			const installedIsActivated =
				installed && installedIdentity ? await pathMatchesIdentity(installedPath, installedIdentity) : false;
			if (
				installed &&
				!installedIsActivated &&
				(await rollbackPathWasPublished(backupPath, installedPath, retainedOriginalIdentity))
			) {
				return;
			}
			if (staged && installed) throw new Error(`Ambiguous update recovery layout for ${resourceName}`);
			if (claimedInstalled && installed) throw new Error(`Rollback claim conflicts with ${resourceName}`);
			if (installed && installedIdentity && !installedIsActivated) {
				throw new Error(`Update transaction path identity changed: ${installedPath}`);
			}
			if (installed && !claimedInstalled) {
				await claimRollbackPath(
					installedPath,
					backupDirectory,
					installedIdentity ?? (await captureOwnedPathIdentity(resourceName, installedPath)),
					options,
				);
			}
			await publishRollbackPathWithoutOverwrite(backupPath, installedPath, retainedOriginalIdentity, options);
			return;
		}
		if (!installed || (!staged && phase !== "rolling_back")) {
			throw new Error(`Previous installed resource cannot be identified safely: ${resourceName}`);
		}
		// Windows publishes a rollback directory with an atomic move, so its named
		// backup is absent after publication.  A surviving claim still needs to be
		// validated before terminal cleanup can remove it.
		await findRollbackClaim(backupDirectory, resourceName, installedIdentity);
		if (originalIdentity) await assertPathIdentity(installedPath, originalIdentity);
		return;
	}

	if (backup) throw new Error(`Unexpected backup for previously absent resource: ${resourceName}`);
	const claimedInstalled = await findRollbackClaim(backupDirectory, resourceName, installedIdentity);
	if (claimedInstalled && installed) throw new Error(`Rollback claim conflicts with ${resourceName}`);
	if (staged && installed) throw new Error(`Ambiguous update recovery layout for ${resourceName}`);
	if (!staged && installed) {
		await claimRollbackPath(
			installedPath,
			backupDirectory,
			installedIdentity ?? (await captureOwnedPathIdentity(resourceName, installedPath)),
			options,
		);
		return;
	}
	if (!staged && !installed && !claimedInstalled && phase !== "rolling_back") {
		throw new Error(`New resource cannot be identified safely: ${resourceName}`);
	}
}

async function rollbackBinary(
	installDirectory: string,
	stagingDirectory: string,
	backupDirectory: string,
	binaryName: string,
	originalBinaryPresent: boolean,
	binarySha256: string | null,
	originalIdentity: ReleaseUpdatePathIdentity | undefined,
	phase: ReleaseUpdateTransactionPhase,
	options: RecoverReleaseUpdateTransactionOptions,
): Promise<void> {
	const currentBinary = join(installDirectory, binaryName);
	const stagedBinary = join(stagingDirectory, binaryName);
	const backupBinary = join(backupDirectory, binaryName);
	const [current, staged, backup] = await Promise.all([
		ownedPathExists(currentBinary, "file"),
		ownedPathExists(stagedBinary, "file"),
		ownedPathExists(backupBinary, "file"),
	]);
	if (!originalBinaryPresent) {
		if (backup) throw new Error("Fresh install transaction unexpectedly contains a binary backup");
		const claimedBinary = await findRollbackClaim(backupDirectory, binaryName, undefined, binarySha256 ?? undefined);
		if (claimedBinary && current) throw new Error("Fresh install binary and rollback claim both exist");
		if (staged && current) throw new Error("Ambiguous fresh install binary recovery layout");
		if (staged) return;
		if (current) {
			if (!binarySha256 || (await calculateFileSha256(currentBinary)) !== binarySha256) {
				throw new Error("Fresh install binary does not match the journal; refusing to remove it");
			}
			await claimRollbackPath(
				currentBinary,
				backupDirectory,
				await captureOwnedPathIdentity(binaryName, currentBinary),
				options,
				binarySha256,
			);
			await syncDirectory(installDirectory);
			return;
		}
		if (!claimedBinary && phase !== "rolling_back") {
			throw new Error("Fresh install binary cannot be identified safely");
		}
		return;
	}
	if (backup) {
		const retainedOriginalIdentity = originalIdentity ?? (await captureOwnedPathIdentity(binaryName, backupBinary));
		await assertPathIdentity(backupBinary, retainedOriginalIdentity);
		const claimedBinary = await findRollbackClaim(backupDirectory, binaryName, undefined, binarySha256 ?? undefined);
		if (current) {
			const [currentStats, backupStats] = await Promise.all([
				lstat(currentBinary, { bigint: true }),
				lstat(backupBinary, { bigint: true }),
			]);
			if (currentStats.dev === backupStats.dev && currentStats.ino === backupStats.ino) return;
			if (claimedBinary) throw new Error("Installed binary conflicts with its rollback claim");
			if (binarySha256 && (await calculateFileSha256(currentBinary)) !== binarySha256) {
				throw new Error("Installed binary changed before rollback");
			}
			await claimRollbackPath(
				currentBinary,
				backupDirectory,
				await captureOwnedPathIdentity(binaryName, currentBinary),
				options,
				binarySha256 ?? undefined,
			);
		}
		if (staged && !current && !claimedBinary) {
			// The binary backup can exist before the staged executable is activated.
			await publishRollbackPathWithoutOverwrite(backupBinary, currentBinary, retainedOriginalIdentity, options);
			return;
		}
		await publishRollbackPathWithoutOverwrite(backupBinary, currentBinary, retainedOriginalIdentity, options);
		await syncDirectory(installDirectory);
		return;
	}
	const claimedBinary = await findRollbackClaim(backupDirectory, binaryName, undefined, binarySha256 ?? undefined);
	if (!current || (!staged && phase !== "rolling_back")) {
		if (!current && claimedBinary) {
			throw new Error("Previous Magenta binary backup is missing while its rollback claim remains");
		}
		throw new Error("Previous Magenta binary cannot be identified safely");
	}
	if (originalIdentity) await assertPathIdentity(currentBinary, originalIdentity);
}

async function transactionLooksFullyActivated(
	installDirectory: string,
	journal: ReleaseUpdateTransactionJournal,
): Promise<boolean> {
	const paths = updateTransactionPaths(installDirectory, journal);
	for (const resourceName of journal.installResourceNames) {
		if (await assertSafeResourceCandidate(join(paths.stagingDirectory, resourceName))) return false;
		if (!(await assertSafeResourceCandidate(join(installDirectory, resourceName)))) return false;
		if (journal.installedPathIdentities !== null) {
			await assertPathIdentity(
				join(installDirectory, resourceName),
				requireInstalledPathIdentity(journal, resourceName),
			);
		}
	}
	for (const resourceName of journal.removeResourceNames) {
		if (await assertSafeResourceCandidate(join(paths.stagingDirectory, resourceName))) return false;
		if (await assertSafeResourceCandidate(join(installDirectory, resourceName))) return false;
	}
	if (journal.binaryName) {
		const installedBinary = join(installDirectory, journal.binaryName);
		if (await ownedPathExists(join(paths.stagingDirectory, journal.binaryName), "file")) return false;
		if (!(await ownedPathExists(installedBinary, "file"))) return false;
		if (journal.binarySha256 && (await calculateFileSha256(installedBinary)) !== journal.binarySha256) return false;
	}
	return true;
}

function defaultReleaseUpdateHelperIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but is not inspectable by this user.
		// Every other failure is treated as a dead PID; the journal remains
		// authoritative and the normal recovery checks still fail closed.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

const windowsProcessStartTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/;

export function getWindowsReleaseUpdateProcessStartTimeUtc(pid: number): string | undefined {
	if (process.platform !== "win32") return undefined;
	const safeEnvironment: NodeJS.ProcessEnv = {};
	for (const key of ["PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP", "USERPROFILE"]) {
		const value = process.env[key];
		if (value !== undefined) safeEnvironment[key] = value;
	}
	const command =
		`$process = Get-Process -Id ${pid} -ErrorAction Stop; ` +
		`$process.StartTime.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture)`;
	const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
		encoding: "utf8",
		env: safeEnvironment,
		maxBuffer: 16 * 1024,
		timeout: 5_000,
		windowsHide: true,
	});
	if (result.error || result.status !== 0) return undefined;
	const value = result.stdout.trim();
	return windowsProcessStartTimePattern.test(value) ? value : undefined;
}

async function windowsHelperIsAlive(
	journal: ReleaseUpdateTransactionJournal,
	options: RecoverReleaseUpdateTransactionOptions,
): Promise<boolean> {
	if (journal.kind !== "windows" || journal.helperPid === null) return false;
	const isAlive = options.helperProcessIsAlive ?? defaultReleaseUpdateHelperIsAlive;
	if (!(await isAlive(journal.helperPid))) return false;
	if (journal.helperStartTimeUtc === null) return true;
	// Windows transactions are only produced on Windows.  Keep deterministic
	// non-Windows recovery tests (and cross-platform forensic tooling) usable
	// when no OS-specific creation-time probe is available; the real Windows
	// path below always queries Get-Process.StartTime and fails closed on error.
	if (process.platform !== "win32" && options.helperProcessStartTimeUtc === undefined) return true;
	const startTimeProbe = options.helperProcessStartTimeUtc ?? getWindowsReleaseUpdateProcessStartTimeUtc;
	let observedStartTime: string | undefined;
	try {
		observedStartTime = await startTimeProbe(journal.helperPid);
	} catch (error) {
		throw new Error(
			`Unable to verify Windows update helper PID ${journal.helperPid} creation time: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (observedStartTime === undefined) {
		throw new Error(
			`Unable to verify Windows update helper PID ${journal.helperPid} creation time; refusing recovery`,
		);
	}
	return observedStartTime === journal.helperStartTimeUtc;
}

/** Recover or finish the one journal-owned transaction for an installation. Must be called under the install lock. */
export async function recoverInterruptedReleaseUpdateTransaction(
	installDirectory: string,
	options: RecoverReleaseUpdateTransactionOptions = {},
): Promise<boolean> {
	await assertOwnedPath(installDirectory, { type: "directory" });
	// Inspect both journal paths before readPendingJournal is allowed to promote
	// or discard a temporary file.  A live detached helper owns the prepared
	// transaction even though the parent process has already exited.
	const durableJournalPath = join(installDirectory, RELEASE_UPDATE_JOURNAL_NAME);
	const temporaryJournalPath = join(installDirectory, RELEASE_UPDATE_JOURNAL_TEMP_NAME);
	if (await ownedPathExists(durableJournalPath, "file")) {
		const durableJournal = await readJournalFile(durableJournalPath);
		if (await windowsHelperIsAlive(durableJournal, options)) {
			throw new Error(
				`Windows update transaction is owned by live helper PID ${durableJournal.helperPid}; refusing recovery while it is running`,
			);
		}
	}
	if (await ownedPathExists(temporaryJournalPath, "file")) {
		const temporaryJournal = await readJournalFile(temporaryJournalPath);
		if (await windowsHelperIsAlive(temporaryJournal, options)) {
			throw new Error(
				`Windows update transaction is owned by live helper PID ${temporaryJournal.helperPid}; refusing recovery while it is running`,
			);
		}
	}
	const journal = await readPendingJournal(installDirectory);
	if (!journal) return false;
	const paths = updateTransactionPaths(installDirectory, journal);
	assertPathIsDirectChild(installDirectory, paths.stagingDirectory, basename(paths.stagingDirectory));
	assertPathIsDirectChild(installDirectory, paths.backupDirectory, basename(paths.backupDirectory));
	if (await ownedPathExists(paths.stagingDirectory)) {
		await assertOwnedPath(paths.stagingDirectory, { type: "directory" });
	}
	if (await ownedPathExists(paths.backupDirectory)) {
		await assertOwnedPath(paths.backupDirectory, { type: "directory" });
	}

	if (journal.phase === "staging") {
		if (await ownedPathExists(paths.backupDirectory)) {
			throw new Error("Staging-only update journal unexpectedly has a backup directory");
		}
		await cleanupTransactionArtifacts(installDirectory, journal);
		return true;
	}
	if (journal.phase === "committed") {
		await cleanupTransactionArtifacts(installDirectory, journal);
		return true;
	}

	if (
		journal.targetVersion !== null &&
		options.runningVersion === journal.targetVersion &&
		(await transactionLooksFullyActivated(installDirectory, journal)) &&
		(await currentReleaseResourcesAreValid(installDirectory, journal.targetVersion))
	) {
		await writeReleaseUpdateJournal(installDirectory, { ...journal, phase: "committed" });
		await cleanupTransactionArtifacts(installDirectory, { ...journal, phase: "committed" });
		return true;
	}

	if (journal.phase !== "rolling_back") {
		journal.phase = "rolling_back";
		await writeReleaseUpdateJournal(installDirectory, journal);
	}
	if (journal.binaryName) {
		await rollbackBinary(
			installDirectory,
			paths.stagingDirectory,
			paths.backupDirectory,
			journal.binaryName,
			journal.originalBinaryPresent as boolean,
			journal.binarySha256,
			journal.originalPathIdentities === null || journal.originalBinaryPresent !== true
				? undefined
				: requireOriginalPathIdentity(journal, journal.binaryName),
			journal.phase,
			options,
		);
	}
	const originalResourceNames = new Set(journal.originalResourceNames);
	for (const resourceName of [...journal.installResourceNames, ...journal.removeResourceNames].reverse()) {
		const hadOriginal = originalResourceNames.has(resourceName);
		await rollbackResource(
			installDirectory,
			paths.stagingDirectory,
			paths.backupDirectory,
			resourceName,
			hadOriginal,
			journal.originalPathIdentities === null || !hadOriginal
				? undefined
				: requireOriginalPathIdentity(journal, resourceName),
			journal.installedPathIdentities === null || !journal.installResourceNames.includes(resourceName)
				? undefined
				: requireInstalledPathIdentity(journal, resourceName),
			journal.phase,
			options,
		);
	}
	await syncDirectory(installDirectory);
	await options.testBeforeRollbackTerminalJournal?.();
	const terminalJournal = { ...journal, phase: "committed" as const };
	await writeReleaseUpdateJournal(installDirectory, terminalJournal);
	await cleanupTransactionArtifacts(installDirectory, terminalJournal);
	return true;
}

export interface UnixUpdateTransactionOptions {
	currentBinary: string;
	/** Whether the target binary existed before this transaction. Defaults to true for self-update callers. */
	originalBinaryPresent?: boolean;
	operationId: string;
	stagingDirectory: string;
	backupDirectory: string;
	/** Top-level resources copied from staging into the installation. */
	resourceNames: readonly string[];
	/** Optional explicit remove-only set; marker ownership is added automatically. */
	removeResourceNames?: readonly string[];
	targetVersion?: string;
	verifyInstalled(): void | Promise<void>;
	fileSystem?: UpdateTransactionFileSystem;
	/** @internal Deterministic crash injection for transaction recovery tests. */
	testFaultInjector?(point: string): void;
}

export interface ResourceUpdateTransactionOptions {
	installDirectory: string;
	operationId: string;
	stagingDirectory: string;
	backupDirectory: string;
	/** Top-level resources copied from staging into the installation. */
	resourceNames: readonly string[];
	/** Optional explicit remove-only set; marker ownership is added automatically. */
	removeResourceNames?: readonly string[];
	targetVersion?: string;
	verifyInstalled(): void | Promise<void>;
	fileSystem?: UpdateTransactionFileSystem;
	/** @internal Deterministic crash injection for transaction recovery tests. */
	testFaultInjector?(point: string): void;
}

export class InjectedUpdateInterruption extends Error {}

function injectUpdateFault(options: { testFaultInjector?(point: string): void }, point: string): void {
	if (!options.testFaultInjector) return;
	try {
		options.testFaultInjector(point);
	} catch (error) {
		throw new InjectedUpdateInterruption(error instanceof Error ? error.message : String(error));
	}
}

async function prepareReleaseUpdateJournal(options: {
	installDirectory: string;
	operationId: string;
	kind: ReleaseUpdateTransactionKind;
	binaryName?: string;
	originalBinaryPresent?: boolean;
	binarySha256?: string;
	stagingDirectory: string;
	backupDirectory: string;
	resourceNames: readonly string[];
	removeResourceNames?: readonly string[];
	targetVersion?: string;
}): Promise<ReleaseUpdateTransactionJournal> {
	assertTransactionOptionPaths(
		options.installDirectory,
		options.operationId,
		options.kind,
		options.stagingDirectory,
		options.backupDirectory,
	);
	await assertOwnedPath(options.installDirectory, { type: "directory" });
	await assertOwnedPath(options.stagingDirectory, { type: "directory" });
	const installResourceNames = [...new Set(options.resourceNames)];
	if (installResourceNames.length === 0) throw new Error("Update transaction contains no resources");
	for (const resourceName of installResourceNames) {
		if (!isSafeUpdateResourceName(resourceName) || resourceName === options.binaryName) {
			throw new Error(`Unsafe update resource name: ${resourceName}`);
		}
		if (!(await assertSafeResourceCandidate(join(options.stagingDirectory, resourceName)))) {
			throw new Error(`Staged resource is missing: ${resourceName}`);
		}
	}
	const explicitRemoveResourceNames = [...new Set(options.removeResourceNames ?? [])];
	if (
		explicitRemoveResourceNames.some(
			(name) => !isManagedReleaseResourceName(name) || installResourceNames.includes(name),
		)
	) {
		throw new Error("Update transaction contains an unsafe or overlapping remove-only resource name");
	}
	// A valid ownership marker is the only durable proof that a top-level path
	// created by an older release may be retired. Invalid/legacy markers are
	// deliberately ignored so a repair can replace them without guessing.
	let markerResourceNames: readonly string[] = [];
	try {
		const marker = await readInstalledReleaseOwnership(options.installDirectory);
		markerResourceNames = marker.resourceNames ?? [];
	} catch {
		markerResourceNames = [];
	}
	const removeResourceNames = [
		...new Set([
			...explicitRemoveResourceNames,
			...markerResourceNames.filter(
				(name) => isManagedReleaseResourceName(name) && !installResourceNames.includes(name),
			),
		]),
	];
	if (removeResourceNames.some((name) => !isManagedReleaseResourceName(name))) {
		throw new Error("Update transaction contains an unsafe remove-only resource name");
	}

	let journal = await readPendingJournal(options.installDirectory);
	if (!journal) {
		await initializeReleaseUpdateTransaction({
			installDirectory: options.installDirectory,
			operationId: options.operationId,
			kind: options.kind,
			binaryName: options.binaryName,
			originalBinaryPresent: options.originalBinaryPresent,
			targetVersion: options.targetVersion,
		});
		journal = await readPendingJournal(options.installDirectory);
	}
	if (
		!journal ||
		journal.phase !== "staging" ||
		journal.operationId !== options.operationId ||
		journal.kind !== options.kind ||
		journal.binaryName !== (options.binaryName ?? null) ||
		journal.originalBinaryPresent !== (options.kind === "resources" ? null : options.originalBinaryPresent) ||
		journal.targetVersion !== (options.targetVersion ?? null) ||
		journal.helperPid !== null ||
		journal.helperStartTimeUtc !== null
	) {
		throw new Error("Update transaction journal does not match the staged update");
	}
	if (journal.version !== RELEASE_UPDATE_JOURNAL_VERSION && journal.phase !== "staging") {
		throw new Error("Legacy prepared update journal has no original path identities; recover it before retrying");
	}
	if (journal.version < PREVIOUS_RELEASE_UPDATE_JOURNAL_VERSION && removeResourceNames.length > 0) {
		throw new Error("Legacy update journal cannot represent remove-only resources; recover it first");
	}
	if (options.kind !== "resources") {
		const currentBinary = join(options.installDirectory, options.binaryName as string);
		const currentBinaryPresent = await ownedPathExists(currentBinary, "file");
		if (currentBinaryPresent !== options.originalBinaryPresent) {
			throw new Error("Installed binary no longer matches the transaction snapshot");
		}
		if (!options.binarySha256 || !/^[0-9a-f]{64}$/.test(options.binarySha256)) {
			throw new Error("Update transaction requires a verified binary digest");
		}
	}
	if (await ownedPathExists(options.backupDirectory)) {
		throw new Error(`Update backup path already exists: ${options.backupDirectory}`);
	}
	const originalResourceNames: string[] = [];
	for (const resourceName of [...installResourceNames, ...removeResourceNames]) {
		if (await assertSafeResourceCandidate(join(options.installDirectory, resourceName))) {
			originalResourceNames.push(resourceName);
		}
	}
	const originalPathIdentities: ReleaseUpdatePathIdentity[] = [];
	for (const resourceName of originalResourceNames) {
		originalPathIdentities.push(
			await captureOwnedPathIdentity(resourceName, join(options.installDirectory, resourceName)),
		);
	}
	if (options.kind !== "resources" && options.originalBinaryPresent) {
		originalPathIdentities.push(
			await captureOwnedPathIdentity(
				options.binaryName as string,
				join(options.installDirectory, options.binaryName as string),
			),
		);
	}
	const installedPathIdentities: ReleaseUpdatePathIdentity[] = [];
	for (const resourceName of installResourceNames) {
		installedPathIdentities.push(
			await captureOwnedPathIdentity(resourceName, join(options.stagingDirectory, resourceName)),
		);
	}
	journal = {
		...journal,
		version: RELEASE_UPDATE_JOURNAL_VERSION,
		binarySha256: options.kind === "resources" ? null : (options.binarySha256 ?? null),
		installResourceNames,
		removeResourceNames,
		originalResourceNames,
		originalPathIdentities,
		installedPathIdentities,
		phase: "prepared",
	};
	await writeReleaseUpdateJournal(options.installDirectory, journal);
	return journal;
}

export interface PrepareWindowsReleaseUpdateTransactionOptions {
	installDirectory: string;
	operationId: string;
	currentBinary: string;
	stagingDirectory: string;
	backupDirectory: string;
	/** Top-level resources copied from staging into the installation. */
	resourceNames: readonly string[];
	/** Marker-owned resources removed because the new release no longer ships them. */
	removeResourceNames?: readonly string[];
	targetVersion: string;
}

export interface BindWindowsReleaseUpdateHelperOptions {
	installDirectory: string;
	operationId: string;
	helperPid: number;
	helperStartTimeUtc: string;
}

/** Persist the Windows helper's complete write-ahead intent before the parent process releases the install lock. */
export async function prepareWindowsReleaseUpdateTransaction(
	options: PrepareWindowsReleaseUpdateTransactionOptions,
): Promise<{ removeResourceNames: string[] }> {
	if (resolve(dirname(options.currentBinary)) !== resolve(options.installDirectory)) {
		throw new Error("Windows update binary is outside the installation directory");
	}
	await assertOwnedPath(options.currentBinary, { type: "file" });
	const stagedBinary = join(options.stagingDirectory, basename(options.currentBinary));
	await assertOwnedPath(stagedBinary, { type: "file" });
	const journal = await prepareReleaseUpdateJournal({
		installDirectory: options.installDirectory,
		operationId: options.operationId,
		kind: "windows",
		binaryName: basename(options.currentBinary),
		originalBinaryPresent: true,
		binarySha256: await calculateFileSha256(stagedBinary),
		stagingDirectory: options.stagingDirectory,
		backupDirectory: options.backupDirectory,
		resourceNames: options.resourceNames,
		removeResourceNames: options.removeResourceNames,
		targetVersion: options.targetVersion,
	});
	return { removeResourceNames: journal.removeResourceNames };
}

/**
 * Bind a detached Windows helper to the prepared journal while the launching
 * process still owns the installation lock.  The helper cannot safely mutate
 * the transaction until this field is durably visible; a competing Magenta
 * process therefore defers recovery while the exact PID is alive.
 */
export async function bindWindowsReleaseUpdateHelper(options: BindWindowsReleaseUpdateHelperOptions): Promise<void> {
	assertSafeOperationId(options.operationId);
	if (!Number.isSafeInteger(options.helperPid) || options.helperPid <= 0 || options.helperPid > 0x7fffffff) {
		throw new Error("Windows update helper PID is invalid");
	}
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/.test(options.helperStartTimeUtc)) {
		throw new Error("Windows update helper start time is invalid");
	}
	const journal = await readPendingJournal(options.installDirectory);
	if (
		!journal ||
		journal.kind !== "windows" ||
		journal.operationId !== options.operationId ||
		journal.phase !== "prepared"
	) {
		throw new Error("Windows update journal is not the prepared transaction being launched");
	}
	if (journal.helperPid !== null && journal.helperPid !== options.helperPid) {
		throw new Error("Windows update journal is already bound to a different helper PID");
	}
	if (journal.helperStartTimeUtc !== null && journal.helperStartTimeUtc !== options.helperStartTimeUtc) {
		throw new Error("Windows update journal is already bound to a different helper identity");
	}
	if (journal.helperPid === options.helperPid && journal.helperStartTimeUtc === options.helperStartTimeUtc) return;
	await writeReleaseUpdateJournal(options.installDirectory, {
		...journal,
		helperPid: options.helperPid,
		helperStartTimeUtc: options.helperStartTimeUtc,
	});
}

async function completeVerifiedReleaseUpdate(
	installDirectory: string,
	journal: ReleaseUpdateTransactionJournal,
	beforeCleanup?: () => void,
): Promise<string[]> {
	await writeReleaseUpdateJournal(installDirectory, { ...journal, phase: "committed" });
	beforeCleanup?.();
	try {
		await cleanupTransactionArtifacts(installDirectory, { ...journal, phase: "committed" });
		return [];
	} catch (error) {
		return [
			`Verified update cleanup was deferred to the next startup: ${error instanceof Error ? error.message : String(error)}`,
		];
	}
}

async function rollbackFailedReleaseUpdate(
	installDirectory: string,
	error: unknown,
	label: "Resource update" | "Update",
): Promise<never> {
	const originalMessage = error instanceof Error ? error.message : String(error);
	try {
		await recoverInterruptedReleaseUpdateTransaction(installDirectory);
	} catch (rollbackError) {
		throw new Error(
			`${label} failed (${originalMessage}) and crash-safe rollback was incomplete. The journal and backup were preserved. ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
		);
	}
	throw new Error(
		label === "Resource update"
			? `Resource update failed and the previous resources were restored: ${originalMessage}`
			: `Update failed and the previous installation was restored: ${originalMessage}`,
	);
}

export async function applyResourceUpdateTransaction(options: ResourceUpdateTransactionOptions): Promise<string[]> {
	const fileSystem = options.fileSystem ?? NODE_UPDATE_TRANSACTION_FILE_SYSTEM;
	const journal = await prepareReleaseUpdateJournal({
		installDirectory: options.installDirectory,
		operationId: options.operationId,
		kind: "resources",
		stagingDirectory: options.stagingDirectory,
		backupDirectory: options.backupDirectory,
		resourceNames: options.resourceNames,
		removeResourceNames: options.removeResourceNames,
		targetVersion: options.targetVersion,
	});
	try {
		injectUpdateFault(options, "journal:prepared");
		await fileSystem.makeDirectory(options.backupDirectory);
		for (const resourceName of journal.originalResourceNames) {
			const originalIdentity = findOriginalPathIdentity(journal, resourceName);
			if (journal.originalPathIdentities !== null) {
				if (!originalIdentity)
					throw new Error(`Update transaction has no identity for original resource: ${resourceName}`);
				await assertPathIdentity(join(options.installDirectory, resourceName), originalIdentity);
			}
			await fileSystem.movePath(
				join(options.installDirectory, resourceName),
				join(options.backupDirectory, resourceName),
			);
			if (originalIdentity) {
				await assertPathIdentity(join(options.backupDirectory, resourceName), originalIdentity);
			}
			await syncDirectory(options.backupDirectory);
			await syncDirectory(options.installDirectory);
			injectUpdateFault(options, `resource-backup:${resourceName}`);
		}
		for (const resourceName of journal.installResourceNames) {
			const installedIdentity = requireInstalledPathIdentity(journal, resourceName);
			await assertPathIdentity(join(options.stagingDirectory, resourceName), installedIdentity);
			await fileSystem.movePath(
				join(options.stagingDirectory, resourceName),
				join(options.installDirectory, resourceName),
			);
			await assertPathIdentity(join(options.installDirectory, resourceName), installedIdentity);
			await syncDirectory(options.stagingDirectory);
			await syncDirectory(options.installDirectory);
			injectUpdateFault(options, `resource-install:${resourceName}`);
		}
		await options.verifyInstalled();
		injectUpdateFault(options, "verification:complete");
		const warnings = await completeVerifiedReleaseUpdate(options.installDirectory, journal, () =>
			injectUpdateFault(options, "journal:committed"),
		);
		return warnings;
	} catch (error) {
		if (error instanceof InjectedUpdateInterruption) throw error;
		return rollbackFailedReleaseUpdate(options.installDirectory, error, "Resource update");
	}
}

export async function applyUnixUpdateTransaction(options: UnixUpdateTransactionOptions): Promise<string[]> {
	const fileSystem = options.fileSystem ?? NODE_UPDATE_TRANSACTION_FILE_SYSTEM;
	const installDirectory = dirname(options.currentBinary);
	const binaryName = basename(options.currentBinary);
	assertTransactionOptionPaths(
		installDirectory,
		options.operationId,
		"unix",
		options.stagingDirectory,
		options.backupDirectory,
	);
	const stagedBinary = join(options.stagingDirectory, binaryName);
	const backupBinary = join(options.backupDirectory, binaryName);
	const originalBinaryPresent = options.originalBinaryPresent ?? true;
	if (originalBinaryPresent) {
		await assertOwnedPath(options.currentBinary, { type: "file" });
	} else if (await ownedPathExists(options.currentBinary)) {
		throw new Error("Fresh install target binary already exists");
	}
	await assertOwnedPath(stagedBinary, { type: "file" });
	const binarySha256 = await calculateFileSha256(stagedBinary);
	const journal = await prepareReleaseUpdateJournal({
		installDirectory,
		operationId: options.operationId,
		kind: "unix",
		binaryName,
		originalBinaryPresent,
		binarySha256,
		stagingDirectory: options.stagingDirectory,
		backupDirectory: options.backupDirectory,
		resourceNames: options.resourceNames,
		removeResourceNames: options.removeResourceNames,
		targetVersion: options.targetVersion,
	});

	try {
		injectUpdateFault(options, "journal:prepared");
		await fileSystem.makeDirectory(options.backupDirectory);
		for (const resourceName of journal.originalResourceNames) {
			const originalIdentity = findOriginalPathIdentity(journal, resourceName);
			if (journal.originalPathIdentities !== null) {
				if (!originalIdentity)
					throw new Error(`Update transaction has no identity for original resource: ${resourceName}`);
				await assertPathIdentity(join(installDirectory, resourceName), originalIdentity);
			}
			await fileSystem.movePath(join(installDirectory, resourceName), join(options.backupDirectory, resourceName));
			if (originalIdentity) {
				await assertPathIdentity(join(options.backupDirectory, resourceName), originalIdentity);
			}
			await syncDirectory(options.backupDirectory);
			await syncDirectory(installDirectory);
			injectUpdateFault(options, `resource-backup:${resourceName}`);
		}
		for (const resourceName of journal.installResourceNames) {
			const installedIdentity = requireInstalledPathIdentity(journal, resourceName);
			await assertPathIdentity(join(options.stagingDirectory, resourceName), installedIdentity);
			await fileSystem.movePath(join(options.stagingDirectory, resourceName), join(installDirectory, resourceName));
			await assertPathIdentity(join(installDirectory, resourceName), installedIdentity);
			await syncDirectory(options.stagingDirectory);
			await syncDirectory(installDirectory);
			injectUpdateFault(options, `resource-install:${resourceName}`);
		}

		if (originalBinaryPresent) {
			const originalBinaryIdentity = requireOriginalPathIdentity(journal, binaryName);
			await assertPathIdentity(options.currentBinary, originalBinaryIdentity);
			await link(options.currentBinary, backupBinary);
			await syncFile(backupBinary);
			await assertPathIdentity(backupBinary, originalBinaryIdentity);
			await syncDirectory(options.backupDirectory);
		}
		injectUpdateFault(options, "binary-backup:complete");
		if ((await calculateFileSha256(stagedBinary)) !== binarySha256) {
			throw new Error("Staged Magenta binary changed before activation");
		}
		// POSIX rename replaces an existing executable in one atomic step.
		await fileSystem.movePath(stagedBinary, options.currentBinary);
		await syncDirectory(options.stagingDirectory);
		await syncDirectory(installDirectory);
		injectUpdateFault(options, "binary-install:complete");
		await options.verifyInstalled();
		injectUpdateFault(options, "verification:complete");
		const warnings = await completeVerifiedReleaseUpdate(installDirectory, journal, () =>
			injectUpdateFault(options, "journal:committed"),
		);
		return warnings;
	} catch (error) {
		if (error instanceof InjectedUpdateInterruption) throw error;
		return rollbackFailedReleaseUpdate(installDirectory, error, "Update");
	}
}

export function quotePowerShellLiteral(value: string): string {
	if (/[\r\n\u0000]/.test(value)) throw new Error("PowerShell literal contains a control character");
	return `'${value.replaceAll("'", "''")}'`;
}

export interface WindowsUpdateScriptOptions {
	parentProcessId: number;
	/** Optional invariant UTC start time used to reject a reused parent PID. */
	parentProcessStartTimeUtc?: string;
	operationId: string;
	currentBinary: string;
	stagingDirectory: string;
	backupDirectory: string;
	/** Top-level resources copied from staging into the installation. */
	resourceNames: readonly string[];
	/** Marker-owned resources removed because the new release no longer ships them. */
	removeResourceNames?: readonly string[];
	targetVersion: string;
	scriptPath: string;
	errorLogPath: string;
}

export function buildWindowsUpdateScript(options: WindowsUpdateScriptOptions): string {
	const binaryName = basename(options.currentBinary);
	const installDirectory = dirname(options.currentBinary);
	assertSafeOperationId(options.operationId);
	if (
		options.parentProcessStartTimeUtc !== undefined &&
		!windowsProcessStartTimePattern.test(options.parentProcessStartTimeUtc)
	) {
		throw new Error("Windows parent process start time is invalid");
	}
	assertTransactionOptionPaths(
		installDirectory,
		options.operationId,
		"windows",
		options.stagingDirectory,
		options.backupDirectory,
	);
	const expectedScriptName = updateTransactionDirectoryNames("windows", options.operationId).scriptName as string;
	assertPathIsDirectChild(installDirectory, options.scriptPath, expectedScriptName);
	for (const resourceName of options.resourceNames) {
		if (!isSafeUpdateResourceName(resourceName) || resourceName === binaryName) {
			throw new Error(`Unsafe update resource name: ${resourceName}`);
		}
	}
	const removeResourceNames = [...new Set(options.removeResourceNames ?? [])];
	if (
		removeResourceNames.some((name) => !isManagedReleaseResourceName(name) || options.resourceNames.includes(name))
	) {
		throw new Error("Unsafe or overlapping remove-only resource name");
	}
	const resourceLines = options.resourceNames.map((name) => `    ${quotePowerShellLiteral(name)}`).join(",\n");
	const removeResourceLines = removeResourceNames.map((name) => `    ${quotePowerShellLiteral(name)}`).join(",\n");
	const managedResourceLines = [
		...RESOURCE_DIRECTORY_NAMES,
		...RESOURCE_FILE_NAMES,
		RELEASE_RESOURCE_MARKER_NAME,
		"_magenta",
	]
		.map((name) => `    ${quotePowerShellLiteral(name)}`)
		.join(",\n");
	const requiredDirectoryLines = RESOURCE_DIRECTORY_NAMES.map((name) => `    ${quotePowerShellLiteral(name)}`).join(
		",\n",
	);
	const requiredFileLines = RESOURCE_FILE_NAMES.map((name) => `    ${quotePowerShellLiteral(name)}`).join(",\n");
	const requiredPathLines = REQUIRED_RESOURCE_PATHS.map((name) => `    ${quotePowerShellLiteral(name)}`).join(",\n");

	return `$ErrorActionPreference = "Stop"
$parentProcessId = ${options.parentProcessId}
$parentProcessStartTimeUtc = ${options.parentProcessStartTimeUtc ? quotePowerShellLiteral(options.parentProcessStartTimeUtc) : "$null"}
$helperProcessId = $PID
$operationId = ${quotePowerShellLiteral(options.operationId)}
$installDirectory = ${quotePowerShellLiteral(installDirectory)}
$currentBinary = ${quotePowerShellLiteral(options.currentBinary)}
$binaryName = ${quotePowerShellLiteral(binaryName)}
$stagingDirectory = ${quotePowerShellLiteral(options.stagingDirectory)}
$backupDirectory = ${quotePowerShellLiteral(options.backupDirectory)}
$targetVersion = ${quotePowerShellLiteral(options.targetVersion)}
$scriptPath = ${quotePowerShellLiteral(options.scriptPath)}
$errorLogPath = ${quotePowerShellLiteral(options.errorLogPath)}
$lockDirectory = Join-Path $installDirectory ${quotePowerShellLiteral(RELEASE_INSTALL_LOCK_NAME)}
$journalPath = Join-Path $installDirectory ${quotePowerShellLiteral(RELEASE_UPDATE_JOURNAL_NAME)}
$journalTempPath = Join-Path $installDirectory ${quotePowerShellLiteral(RELEASE_UPDATE_JOURNAL_TEMP_NAME)}
$currentUserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
	$resourceNames = @(
${resourceLines}
)
$removeResourceNames = @(
${removeResourceLines}
)
	$transactionResourceNames = @($resourceNames + $removeResourceNames | Select-Object -Unique)
$managedResourceNames = @(
${managedResourceLines}
)
$requiredResourceDirectories = @(
${requiredDirectoryLines}
)
$requiredResourceFiles = @(
${requiredFileLines}
)
$requiredResourcePaths = @(
${requiredPathLines}
)
$movedOldResources = New-Object System.Collections.Generic.List[string]
$movedNewResources = New-Object System.Collections.Generic.List[string]
$movedOldBinary = $false
$movedNewBinary = $false
$lockAcquired = $false
$lockCreationTimeUtc = $null
$lockHeartbeatTimer = $null
$lockHeartbeatJob = $null
$lockHeartbeatSource = "magenta-update-lock-$operationId"
$nextForegroundHeartbeatUtc = [DateTime]::MinValue
$transactionSucceeded = $false
	$backupBinary = Join-Path $backupDirectory $binaryName
	$stagedBinary = Join-Path $stagingDirectory $binaryName

if ($null -eq ("Magenta.NativeFileIdentity" -as [type])) {
Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Magenta {
    public static class NativeFileIdentity {
        private const uint FileShareRead = 0x00000001;
        private const uint FileShareWrite = 0x00000002;
        private const uint FileShareDelete = 0x00000004;
        private const uint OpenExisting = 3;
        private const uint FileFlagBackupSemantics = 0x02000000;

        [StructLayout(LayoutKind.Sequential)]
        private struct ByHandleFileInformation {
            public uint FileAttributes;
            public uint CreationTimeLow;
            public uint CreationTimeHigh;
            public uint LastAccessTimeLow;
            public uint LastAccessTimeHigh;
            public uint LastWriteTimeLow;
            public uint LastWriteTimeHigh;
            public uint VolumeSerialNumber;
            public uint FileSizeHigh;
            public uint FileSizeLow;
            public uint NumberOfLinks;
            public uint FileIndexHigh;
            public uint FileIndexLow;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFile(
            string fileName,
            uint desiredAccess,
            uint shareMode,
            IntPtr securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetFileInformationByHandle(
            SafeFileHandle fileHandle,
            out ByHandleFileInformation information);

        public static string[] Get(string path) {
            using (SafeFileHandle handle = CreateFile(
                path,
                0,
                FileShareRead | FileShareWrite | FileShareDelete,
                IntPtr.Zero,
                OpenExisting,
                FileFlagBackupSemantics,
                IntPtr.Zero)) {
                if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
                ByHandleFileInformation information;
                if (!GetFileInformationByHandle(handle, out information)) {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
                ulong fileIndex = ((ulong)information.FileIndexHigh << 32) | information.FileIndexLow;
                return new[] {
                    information.VolumeSerialNumber.ToString(CultureInfo.InvariantCulture),
                    fileIndex.ToString(CultureInfo.InvariantCulture)
                };
            }
        }
    }
}
"@
}

function Convert-MagentaUtcToMilliseconds([DateTime]$value) {
    $epochTicks = [DateTime]::new(1970, 1, 1, 0, 0, 0, [DateTimeKind]::Utc).Ticks
    $ticksSinceEpoch = [double]($value.ToUniversalTime().Ticks - $epochTicks)
    return [string][long][Math]::Floor(($ticksSinceEpoch / 10000.0) + 0.5)
}

function Get-MagentaPathIdentity([string]$name, [string]$path) {
    $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Original update path is a reparse point: $name"
    }
	$nativeIdentity = [Magenta.NativeFileIdentity]::Get($path)
    $isDirectory = [bool]$item.PSIsContainer
    [pscustomobject]@{
        name = $name
        type = if ($isDirectory) { "directory" } else { "file" }
        device = [string]$nativeIdentity[0]
        inode = [string]$nativeIdentity[1]
        # Node's Windows mode bits are compatibility metadata; the native file
        # id, type, size, and timestamps provide the object binding below.
        size = if ($isDirectory) { "0" } else { [string][long]$item.Length }
        mode = if ($isDirectory) { "511" } else { "438" }
        birthtimeMs = Convert-MagentaUtcToMilliseconds $item.CreationTimeUtc
        mtimeMs = Convert-MagentaUtcToMilliseconds $item.LastWriteTimeUtc
    }
}

function Get-MagentaOriginalPathIdentity($journal, [string]$name) {
	foreach ($identity in @($journal.originalPathIdentities)) {
        if ($identity.name -ceq $name) { return $identity }
    }
    return $null
}

function Get-MagentaInstalledPathIdentity($journal, [string]$name) {
	foreach ($identity in @($journal.installedPathIdentities)) {
		if ($identity.name -ceq $name) { return $identity }
	}
	return $null
}

function Test-MagentaPathIdentity([string]$name, [string]$path, $expected) {
	if ($null -eq $expected) { throw "Update transaction has no identity for path: $name" }
	if (-not (Test-MagentaOwnedTransactionPath $path)) { throw "Update path is missing or unsafe: $name" }
	$actual = Get-MagentaPathIdentity $name $path
    foreach ($identityProperty in @("type", "device", "inode", "size", "birthtimeMs", "mtimeMs")) {
        if ([string]$actual.$identityProperty -cne [string]$expected.$identityProperty) {
            throw "Update transaction path identity changed: $path"
        }
    }
}

function Get-MagentaOwnerSid([string]$path) {
    try {
        $owner = (Get-Acl -LiteralPath $path -ErrorAction Stop).Owner
        try {
            return ([Security.Principal.NTAccount]$owner).Translate([Security.Principal.SecurityIdentifier]).Value
        } catch {
            return ([Security.Principal.SecurityIdentifier]$owner).Value
        }
    } catch {
        return $null
    }
}

function Test-MagentaOwnedItem($item) {
    return ($null -ne $item -and (Get-MagentaOwnerSid $item.FullName) -eq $currentUserSid)
}

function Test-MagentaResourceDirectory([string]$path) {
    $item = Get-Item -LiteralPath $path -ErrorAction SilentlyContinue
    return ($null -ne $item -and $item.PSIsContainer -and -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -and (Test-MagentaOwnedItem $item))
}

function Test-MagentaResourceFile([string]$path) {
    $item = Get-Item -LiteralPath $path -ErrorAction SilentlyContinue
    return ($null -ne $item -and -not $item.PSIsContainer -and -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -and (Test-MagentaOwnedItem $item))
}

function Test-MagentaOwnedTransactionPath([string]$path) {
    $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    return ($null -ne $item -and -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -and (Test-MagentaOwnedItem $item))
}

function Get-MagentaPlainDirectory([string]$path) {
    $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    if ($null -eq $item -or -not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not (Test-MagentaOwnedItem $item)) {
        return $null
    }
    return $item
}

function Test-MagentaDirectoryEmpty([string]$path) {
    return (@(Get-ChildItem -LiteralPath $path -Force -ErrorAction Stop).Count -eq 0)
}

function Try-Remove-MagentaStaleLock([DateTime]$staleCutoffUtc) {
    $first = Get-MagentaPlainDirectory $lockDirectory
    if ($null -eq $first -or $first.LastWriteTimeUtc -ge $staleCutoffUtc -or -not (Test-MagentaDirectoryEmpty $lockDirectory)) {
        return $false
    }
    $observedCreationUtc = $first.CreationTimeUtc
    $observedWriteUtc = $first.LastWriteTimeUtc
    Start-Sleep -Milliseconds 100
    $second = Get-MagentaPlainDirectory $lockDirectory
    if (
        $null -eq $second -or
        $second.CreationTimeUtc -ne $observedCreationUtc -or
        $second.LastWriteTimeUtc -ne $observedWriteUtc -or
        $second.LastWriteTimeUtc -ge $staleCutoffUtc -or
        -not (Test-MagentaDirectoryEmpty $lockDirectory)
    ) {
        return $false
    }
    try {
        [IO.Directory]::Delete($lockDirectory, $false)
        return $true
    } catch {
        return $false
    }
}

function Update-MagentaLockHeartbeat {
    if (-not $lockAcquired) { return }
	$nowUtc = [DateTime]::UtcNow
	if ($nowUtc -lt $nextForegroundHeartbeatUtc) { return }
	try {
		$lockInfo = Get-MagentaPlainDirectory $lockDirectory
		if (
			$null -eq $lockInfo -or
			$lockInfo.CreationTimeUtc -ne $lockCreationTimeUtc -or
			-not (Test-MagentaDirectoryEmpty $lockDirectory)
		) {
			throw "Magenta install/update lock ownership was lost."
		}
		[IO.Directory]::SetLastWriteTimeUtc($lockDirectory, $nowUtc)
		$refreshedLock = Get-MagentaPlainDirectory $lockDirectory
		if ($null -eq $refreshedLock -or $refreshedLock.CreationTimeUtc -ne $lockCreationTimeUtc) {
			throw "Magenta install/update lock changed during heartbeat."
		}
		$script:nextForegroundHeartbeatUtc = $nowUtc.AddSeconds(5)
	} catch {
		$heartbeatError = $_
		$script:lockAcquired = $false
		Stop-MagentaBackgroundHeartbeat
		throw $heartbeatError
	}
}

function Start-MagentaBackgroundHeartbeat {
	if (-not $lockAcquired) { throw "Cannot start heartbeat before acquiring the install/update lock." }
	$heartbeatData = @{
		Path = $lockDirectory
		CreationTicks = $lockCreationTimeUtc.Ticks
		OwnerSid = $currentUserSid
	}
	$script:lockHeartbeatTimer = New-Object Timers.Timer
	$script:lockHeartbeatTimer.Interval = 10000
	$script:lockHeartbeatTimer.AutoReset = $true
	$script:lockHeartbeatJob = Register-ObjectEvent -InputObject $script:lockHeartbeatTimer -EventName Elapsed -SourceIdentifier $lockHeartbeatSource -MessageData $heartbeatData -Action {
		$data = $event.MessageData
		try {
			$item = Get-Item -LiteralPath $data.Path -Force -ErrorAction Stop
			if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.CreationTimeUtc.Ticks -ne $data.CreationTicks) { return }
			$owner = (Get-Acl -LiteralPath $data.Path -ErrorAction Stop).Owner
			try {
				$ownerSid = ([Security.Principal.NTAccount]$owner).Translate([Security.Principal.SecurityIdentifier]).Value
			} catch {
				$ownerSid = ([Security.Principal.SecurityIdentifier]$owner).Value
			}
			if ($ownerSid -ne $data.OwnerSid -or @(Get-ChildItem -LiteralPath $data.Path -Force -ErrorAction Stop).Count -ne 0) { return }
			[IO.Directory]::SetLastWriteTimeUtc($data.Path, [DateTime]::UtcNow)
		} catch {
			# The foreground generation checks fail closed before further mutation.
		}
	}
	$script:lockHeartbeatTimer.Start()
}

function Stop-MagentaBackgroundHeartbeat {
	if ($null -ne $lockHeartbeatTimer) {
		$lockHeartbeatTimer.Stop()
	}
	Unregister-Event -SourceIdentifier $lockHeartbeatSource -ErrorAction SilentlyContinue
	if ($null -ne $lockHeartbeatJob) {
		Remove-Job -Job $lockHeartbeatJob -Force -ErrorAction SilentlyContinue
	}
	if ($null -ne $lockHeartbeatTimer) {
		$lockHeartbeatTimer.Dispose()
	}
	$script:lockHeartbeatTimer = $null
	$script:lockHeartbeatJob = $null
}

function Release-MagentaInstallLock {
    if (-not $lockAcquired) { return }
	Stop-MagentaBackgroundHeartbeat
	Start-Sleep -Milliseconds 150
	$lockInfo = Get-MagentaPlainDirectory $lockDirectory
    if ($null -eq $lockInfo) {
		$script:lockAcquired = $false
		throw "Magenta install/update lock disappeared before release."
    }
	if (
		$lockInfo.CreationTimeUtc -ne $lockCreationTimeUtc -or
		$lockInfo.LastWriteTimeUtc -lt [DateTime]::UtcNow.AddSeconds(-30) -or
		-not (Test-MagentaDirectoryEmpty $lockDirectory)
	) {
		throw "Refusing to release a replaced or non-empty Magenta install/update lock."
	}
	$observedWriteUtc = $lockInfo.LastWriteTimeUtc
	Start-Sleep -Milliseconds 100
	$verifiedLock = Get-MagentaPlainDirectory $lockDirectory
	if (
		$null -eq $verifiedLock -or
		$verifiedLock.CreationTimeUtc -ne $lockCreationTimeUtc -or
		$verifiedLock.LastWriteTimeUtc -ne $observedWriteUtc -or
		-not (Test-MagentaDirectoryEmpty $lockDirectory)
	) {
		throw "Magenta install/update lock changed during release."
	}
    [IO.Directory]::Delete($lockDirectory, $false)
	$script:lockAcquired = $false
}

function Assert-MagentaSafeTree([string]$path) {
	Update-MagentaLockHeartbeat
    $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) { return }
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Refusing to remove a reparse point from the update transaction: $path"
    }
	if (-not (Test-MagentaOwnedItem $item)) {
		throw "Refusing to remove a path not owned by the current user: $path"
	}
    if ($item.PSIsContainer) {
        foreach ($child in @(Get-ChildItem -LiteralPath $path -Force -ErrorAction Stop)) {
            Assert-MagentaSafeTree $child.FullName
        }
    }
}

function Remove-MagentaSafeTreeCore([string]$path) {
	Update-MagentaLockHeartbeat
    $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) { return }
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Refusing to remove a reparse point from the update transaction: $path"
    }
	if (-not (Test-MagentaOwnedItem $item)) {
		throw "Refusing to remove a path not owned by the current user: $path"
	}
    if ($item.PSIsContainer) {
        $creationTimeUtc = $item.CreationTimeUtc
        foreach ($child in @(Get-ChildItem -LiteralPath $path -Force -ErrorAction Stop)) {
            Remove-MagentaSafeTreeCore $child.FullName
        }
        $verified = Get-MagentaPlainDirectory $path
        if ($null -eq $verified -or $verified.CreationTimeUtc -ne $creationTimeUtc) {
            throw "Update transaction directory changed during cleanup: $path"
        }
        [IO.Directory]::Delete($path, $false)
        return
    }
    $verified = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    if ($verified.PSIsContainer -or ($verified.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not (Test-MagentaOwnedItem $verified)) {
        throw "Update transaction file changed during cleanup: $path"
    }
    [IO.File]::Delete($path)
}

function Remove-MagentaSafeTree([string]$path) {
    Assert-MagentaSafeTree $path
    Remove-MagentaSafeTreeCore $path
}

function Move-MagentaPathWithoutOverwrite([string]$sourcePath, [string]$destinationPath) {
	$sourceItem = Get-Item -LiteralPath $sourcePath -Force -ErrorAction Stop
	if ($sourceItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
		throw "Refusing to move a reparse point during update rollback: $sourcePath"
	}
	if (-not (Test-MagentaOwnedItem $sourceItem)) {
		throw "Refusing to move a rollback path not owned by the current user: $sourcePath"
	}
	if (Test-Path -LiteralPath $destinationPath) {
		throw "Refusing to overwrite a path during update rollback: $destinationPath"
	}
	if ($sourceItem.PSIsContainer) {
		[IO.Directory]::Move($sourcePath, $destinationPath)
	} else {
		[IO.File]::Move($sourcePath, $destinationPath)
	}
}

function Get-MagentaRollbackQuarantinePrefix([string]$name) {
	$sha256 = [Security.Cryptography.SHA256]::Create()
	try {
		$nameBytes = [Text.UTF8Encoding]::new($false).GetBytes($name)
		$nameDigest = [BitConverter]::ToString($sha256.ComputeHash($nameBytes)).Replace("-", "").ToLowerInvariant()
	} finally {
		$sha256.Dispose()
	}
	return ".magenta-rollback-quarantine-$nameDigest-"
}

function New-MagentaRollbackQuarantinePath([string]$name) {
	$prefix = Get-MagentaRollbackQuarantinePrefix $name
	for ($attempt = 0; $attempt -lt 16; $attempt++) {
		$candidate = Join-Path $backupDirectory ($prefix + [Guid]::NewGuid().ToString("N"))
		if (-not (Test-Path -LiteralPath $candidate -Force)) { return $candidate }
	}
	throw "Unable to allocate a unique rollback quarantine path."
}

function Move-MagentaRollbackCandidateToQuarantine(
	[string]$name,
	[string]$path,
	$expectedIdentity,
	[AllowNull()][string]$expectedSha256
) {
	Test-MagentaPathIdentity $name $path $expectedIdentity
	if ($null -ne $expectedSha256 -and (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant() -cne $expectedSha256) {
		throw "Rollback candidate digest changed before claim: $path"
	}
	$quarantinePath = New-MagentaRollbackQuarantinePath $name
	Move-MagentaPathWithoutOverwrite $path $quarantinePath
	try {
		Test-MagentaPathIdentity $name $quarantinePath $expectedIdentity
		if ($null -ne $expectedSha256 -and (Get-FileHash -Algorithm SHA256 -LiteralPath $quarantinePath).Hash.ToLowerInvariant() -cne $expectedSha256) {
			throw "Rollback candidate digest changed after claim: $path"
		}
	} catch {
		$validationError = $_
		$disposition = "preserved at $quarantinePath"
		try {
			Move-MagentaPathWithoutOverwrite $quarantinePath $path
			$disposition = "restored to $path"
		} catch {
			$disposition += " (automatic restore failed: $_)"
		}
		throw ("Rollback candidate changed during the validation-to-mutation window and was " + $disposition + ": " + $validationError)
	}
	return $quarantinePath
}

function Move-MagentaValidatedRollbackPath(
	[string]$name,
	[string]$sourcePath,
	[string]$destinationPath,
	$expectedIdentity
) {
	Test-MagentaPathIdentity $name $sourcePath $expectedIdentity
	Move-MagentaPathWithoutOverwrite $sourcePath $destinationPath
	try {
		Test-MagentaPathIdentity $name $destinationPath $expectedIdentity
	} catch {
		$validationError = $_
		$disposition = "preserved at $destinationPath"
		try {
			Move-MagentaPathWithoutOverwrite $destinationPath $sourcePath
			$disposition = "restored to $sourcePath"
		} catch {
			$disposition += " (automatic restore failed: $_)"
		}
		throw ("Rollback source changed during the validation-to-publication window and was " + $disposition + ": " + $validationError)
	}
}

function Test-MagentaStringArraysEqual($left, $right) {
	$leftValues = @($left)
	$rightValues = @($right)
	if ($leftValues.Count -ne $rightValues.Count) { return $false }
	for ($index = 0; $index -lt $leftValues.Count; $index++) {
		if ([string]$leftValues[$index] -cne [string]$rightValues[$index]) { return $false }
	}
	return $true
}

function Set-MagentaVerificationEnvironment {
	$allowedEnvironmentNames = @(
		"PATH", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
		"TEMP", "TMP", "TMPDIR", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "OS",
		"LANG", "LC_ALL", "LC_CTYPE", "TERM", "TERM_PROGRAM", "COLORTERM", "NO_COLOR",
		"XDG_RUNTIME_DIR", "PSModulePath", "PSHOME", "PI_PACKAGE_DIR", "PI_OFFLINE", "PI_SKIP_VERSION_CHECK"
	)
	foreach ($environmentName in @([Environment]::GetEnvironmentVariables().Keys)) {
		if ($allowedEnvironmentNames -notcontains [string]$environmentName) {
			Remove-Item -LiteralPath "Env:$environmentName" -ErrorAction SilentlyContinue
		}
	}
	$env:PI_PACKAGE_DIR = $installDirectory
	$env:PI_OFFLINE = "1"
	$env:PI_SKIP_VERSION_CHECK = "1"
}

function Read-MagentaValidatedJournal([string]$path, [AllowNull()][string]$expectedPhase, [bool]$validateOriginalLayout) {
	if (-not (Test-MagentaResourceFile $path)) { throw "Update transaction journal is missing or unsafe: $path" }
	$journalItem = Get-Item -LiteralPath $path -Force -ErrorAction Stop
	if ($journalItem.Length -gt 65536) { throw "Update transaction journal is too large: $path" }
	try {
		$journal = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
	} catch {
		throw "Update transaction journal is not valid JSON: $path"
	}
	$expectedProperties = @("binaryName", "binarySha256", "helperPid", "helperStartTimeUtc", "installResourceNames", "installedPathIdentities", "kind", "operationId", "originalBinaryPresent", "originalPathIdentities", "originalResourceNames", "phase", "removeResourceNames", "targetVersion", "version") | Sort-Object
	$actualProperties = @($journal.PSObject.Properties.Name | Sort-Object)
	if ($actualProperties.Count -ne $expectedProperties.Count -or @(Compare-Object $expectedProperties $actualProperties -CaseSensitive).Count -ne 0) {
		throw "Update transaction journal has an unsupported schema: $path"
	}
	if (-not ($journal.version -is [System.Int32]) -and -not ($journal.version -is [System.Int64])) {
		throw "Update transaction journal version has an invalid type: $path"
	}
	if (-not ($journal.helperPid -is [System.Int32]) -and -not ($journal.helperPid -is [System.Int64])) {
		throw "Windows update journal helper PID has an invalid type: $path"
	}
	if ($journal.helperPid -le 0 -or $journal.helperPid -gt 2147483647 -or $journal.helperPid -ne $helperProcessId) {
		throw "Windows update journal helper PID does not identify this helper: $path"
	}
	if (-not ($journal.helperStartTimeUtc -is [string]) -or $journal.helperStartTimeUtc -cnotmatch '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{7}Z$') {
		throw "Windows update journal helper start time has an invalid type or format: $path"
	}
	$actualHelperStartTimeUtc = (Get-Process -Id $helperProcessId -ErrorAction Stop).StartTime.ToUniversalTime().ToString("o", [Globalization.CultureInfo]::InvariantCulture)
	if ($journal.helperStartTimeUtc -cne $actualHelperStartTimeUtc) {
		throw "Windows update journal helper start time does not identify this helper: $path"
	}
	foreach ($stringProperty in @("operationId", "kind", "binaryName", "targetVersion", "phase")) {
		if (-not ($journal.$stringProperty -is [string])) {
			throw "Update transaction journal property $stringProperty has an invalid type: $path"
		}
	}
	if (-not ($journal.installResourceNames -is [System.Array]) -or -not ($journal.removeResourceNames -is [System.Array]) -or -not ($journal.originalResourceNames -is [System.Array]) -or -not ($journal.originalPathIdentities -is [System.Array]) -or -not ($journal.installedPathIdentities -is [System.Array])) {
		throw "Update transaction journal resource and identity lists must be arrays: $path"
	}
	if (-not ($journal.originalBinaryPresent -is [bool]) -or -not $journal.originalBinaryPresent) {
		throw "Windows update journal has invalid previous binary state: $path"
	}
	if (-not ($journal.binarySha256 -is [string]) -or $journal.binarySha256 -cnotmatch '^[0-9a-f]{64}$') {
		throw "Windows update journal has an invalid binary digest: $path"
	}
	foreach ($resourceValue in @($journal.installResourceNames) + @($journal.removeResourceNames) + @($journal.originalResourceNames)) {
		if (-not ($resourceValue -is [string])) {
			throw "Update transaction journal resource names must be strings: $path"
		}
	}
	foreach ($removeName in @($journal.removeResourceNames)) {
		if ($resourceNames -contains $removeName -or (($managedResourceNames -notcontains $removeName) -and $removeName -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*\\.wasm$')) {
			throw "Update transaction journal has an invalid remove-only resource list: $path"
		}
	}
	if (
		$journal.version -ne ${RELEASE_UPDATE_JOURNAL_VERSION} -or
		$journal.operationId -cne $operationId -or
		$journal.kind -cne "windows" -or
		$journal.binaryName -cne $binaryName -or
		$journal.targetVersion -cne $targetVersion -or
		@("prepared", "rolling_back", "committed") -cnotcontains $journal.phase
	) {
		throw "Update transaction journal identity is invalid: $path"
	}
	if ($null -ne $expectedPhase -and $journal.phase -cne $expectedPhase) {
		throw "Update transaction journal phase is invalid: $path"
	}
	if (-not (Test-MagentaStringArraysEqual @($journal.installResourceNames) $resourceNames)) {
		throw "Update transaction journal resource list does not match this helper: $path"
	}
	if (-not (Test-MagentaStringArraysEqual @($journal.removeResourceNames) $removeResourceNames)) {
		throw "Update transaction journal remove-only resource list does not match this helper: $path"
	}
	$originalNames = @($journal.originalResourceNames)
	$seenOriginalNames = @{}
	foreach ($originalName in $originalNames) {
		if ($seenOriginalNames.ContainsKey($originalName) -or $transactionResourceNames -cnotcontains $originalName) {
			throw "Update transaction journal has an invalid original resource list: $path"
		}
		$seenOriginalNames[$originalName] = $true
	}
	$expectedIdentityProperties = @("birthtimeMs", "device", "inode", "mode", "mtimeMs", "name", "size", "type") | Sort-Object
	$seenIdentityNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
	foreach ($identity in @($journal.originalPathIdentities)) {
		if ($null -eq $identity -or $identity -isnot [pscustomobject]) {
			throw "Update transaction journal contains an invalid original path identity: $path"
		}
		$actualIdentityProperties = @($identity.PSObject.Properties.Name | Sort-Object)
		if ($actualIdentityProperties.Count -ne $expectedIdentityProperties.Count -or @(Compare-Object $expectedIdentityProperties $actualIdentityProperties -CaseSensitive).Count -ne 0) {
			throw "Update transaction journal has an unsupported original path identity schema: $path"
		}
		if (-not ($identity.name -is [string]) -or -not ($identity.type -is [string])) {
			throw "Update transaction journal original path identity names and types must be strings: $path"
		}
		if (@("file", "directory") -cnotcontains $identity.type) {
			throw "Update transaction journal has an invalid original path identity type: $path"
		}
		foreach ($numericIdentityProperty in @("device", "inode", "size", "mode", "birthtimeMs", "mtimeMs")) {
			if (-not ($identity.$numericIdentityProperty -is [string]) -or $identity.$numericIdentityProperty -cnotmatch '^[0-9]+$') {
				throw "Update transaction journal original path identity metadata is invalid: $path"
			}
		}
		if (-not $seenIdentityNames.Add($identity.name)) {
			throw "Update transaction journal has duplicate original path identities: $path"
		}
		if ($identity.name -cne $binaryName -and $transactionResourceNames -cnotcontains $identity.name) {
			throw "Update transaction journal has an unexpected original path identity: $path"
		}
	}
	$expectedIdentityNames = @($originalNames) + @($binaryName)
	if ($seenIdentityNames.Count -ne $expectedIdentityNames.Count) {
		throw "Update transaction journal original path identities do not match its original paths: $path"
	}
	foreach ($expectedIdentityName in $expectedIdentityNames) {
		if (-not $seenIdentityNames.Contains($expectedIdentityName)) {
			throw "Update transaction journal original path identities do not match its original paths: $path"
		}
	}
	$seenInstalledIdentityNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
	foreach ($identity in @($journal.installedPathIdentities)) {
		if ($null -eq $identity -or $identity -isnot [pscustomobject]) {
			throw "Update transaction journal contains an invalid installed path identity: $path"
		}
		$actualIdentityProperties = @($identity.PSObject.Properties.Name | Sort-Object)
		if ($actualIdentityProperties.Count -ne $expectedIdentityProperties.Count -or @(Compare-Object $expectedIdentityProperties $actualIdentityProperties -CaseSensitive).Count -ne 0) {
			throw "Update transaction journal has an unsupported installed path identity schema: $path"
		}
		if (-not ($identity.name -is [string]) -or -not ($identity.type -is [string]) -or @("file", "directory") -cnotcontains $identity.type) {
			throw "Update transaction journal installed path identity name or type is invalid: $path"
		}
		foreach ($numericIdentityProperty in @("device", "inode", "size", "mode", "birthtimeMs", "mtimeMs")) {
			if (-not ($identity.$numericIdentityProperty -is [string]) -or $identity.$numericIdentityProperty -cnotmatch '^[0-9]+$') {
				throw "Update transaction journal installed path identity metadata is invalid: $path"
			}
		}
		if (-not $seenInstalledIdentityNames.Add($identity.name) -or $resourceNames -cnotcontains $identity.name) {
			throw "Update transaction journal has an unexpected or duplicate installed path identity: $path"
		}
	}
	$expectedInstalledIdentityNames = @($resourceNames)
	if ($seenInstalledIdentityNames.Count -ne $expectedInstalledIdentityNames.Count) {
		throw "Update transaction journal installed path identities do not match its installed paths: $path"
	}
	foreach ($expectedIdentityName in $expectedInstalledIdentityNames) {
		if (-not $seenInstalledIdentityNames.Contains($expectedIdentityName)) {
			throw "Update transaction journal installed path identities do not match its installed paths: $path"
		}
	}
	if ($validateOriginalLayout) {
		if (-not (Test-MagentaResourceFile $stagedBinary)) {
			throw "Staged binary is missing or unsafe: $stagedBinary"
		}
		if ((Get-FileHash -Algorithm SHA256 -LiteralPath $stagedBinary).Hash.ToLowerInvariant() -cne $journal.binarySha256) {
			throw "Staged binary no longer matches the update journal: $path"
		}
		$actualOriginalNames = New-Object System.Collections.Generic.List[string]
		foreach ($resourceName in $transactionResourceNames) {
			$installedPath = Join-Path $installDirectory $resourceName
			if (Test-Path -LiteralPath $installedPath) {
				if (-not (Test-MagentaOwnedTransactionPath $installedPath)) {
					throw "Installed resource snapshot is unsafe: $resourceName"
				}
				$actualOriginalNames.Add($resourceName)
			}
		}
		if (-not (Test-MagentaStringArraysEqual $originalNames $actualOriginalNames)) {
			throw "Installed resources no longer match the journal snapshot."
		}
		foreach ($identity in @($journal.originalPathIdentities)) {
			$identityPath = if ($identity.name -ceq $binaryName) { $currentBinary } else { Join-Path $installDirectory $identity.name }
			Test-MagentaPathIdentity $identity.name $identityPath $identity
		}
		foreach ($identity in @($journal.installedPathIdentities)) {
			$identityPath = Join-Path $stagingDirectory $identity.name
			Test-MagentaPathIdentity $identity.name $identityPath $identity
		}
	}
	return $journal
}

function Write-MagentaUpdateJournalPhase([string]$phase) {
	if (@("rolling_back", "committed") -cnotcontains $phase) { throw "Unsupported update journal transition: $phase" }
    if (Test-Path -LiteralPath $journalTempPath) { throw "Update transaction journal temporary file already exists." }
	$expectedPhase = if ($phase -ceq "rolling_back") { "prepared" } else { "rolling_back" }
	$journal = Read-MagentaValidatedJournal $journalPath $expectedPhase $false
    $journal.phase = $phase
    $journalJson = $journal | ConvertTo-Json -Compress -Depth 5
	$journalBytes = (New-Object Text.UTF8Encoding($false)).GetBytes($journalJson + [Environment]::NewLine)
	$journalStream = [IO.FileStream]::new(
		$journalTempPath,
		[IO.FileMode]::CreateNew,
		[IO.FileAccess]::Write,
		[IO.FileShare]::None,
		4096,
		[IO.FileOptions]::WriteThrough
	)
	try {
		$journalStream.Write($journalBytes, 0, $journalBytes.Length)
		$journalStream.Flush($true)
	} finally {
		$journalStream.Dispose()
	}
    $journalAcl = Get-Acl -LiteralPath $journalPath
    Set-Acl -LiteralPath $journalTempPath -AclObject $journalAcl
    [IO.File]::Replace($journalTempPath, $journalPath, $null, $true)
}

while ($true) {
    $parentProcess = Get-Process -Id $parentProcessId -ErrorAction SilentlyContinue
    if ($null -eq $parentProcess) { break }
    if ($null -ne $parentProcessStartTimeUtc) {
        try {
            $observedParentStartTimeUtc = $parentProcess.StartTime.ToUniversalTime().ToString("o", [Globalization.CultureInfo]::InvariantCulture)
            if ($observedParentStartTimeUtc -cne $parentProcessStartTimeUtc) { break }
        } catch {
            # Keep waiting while the original parent is still present; a
            # transient process-query failure must not release the transaction.
        }
    }
    Start-Sleep -Milliseconds 250
}

try {
    $lockDeadline = [DateTime]::UtcNow.AddMinutes(10)
    while (-not $lockAcquired) {
		$fatalLockInitializationError = $null
		$createdThisAttempt = $false
        try {
            New-Item -ItemType Directory -Path $lockDirectory -ErrorAction Stop | Out-Null
			$createdThisAttempt = $true
			$createdLock = Get-MagentaPlainDirectory $lockDirectory
			if ($null -eq $createdLock -or -not (Test-MagentaDirectoryEmpty $lockDirectory)) {
				throw "New Magenta install/update lock is not a plain empty directory."
			}
			$lockCreationTimeUtc = $createdLock.CreationTimeUtc
			[IO.Directory]::SetLastWriteTimeUtc($lockDirectory, [DateTime]::UtcNow)
			$refreshedCreatedLock = Get-MagentaPlainDirectory $lockDirectory
			if ($null -eq $refreshedCreatedLock -or $refreshedCreatedLock.CreationTimeUtc -ne $lockCreationTimeUtc) {
				throw "New Magenta install/update lock changed during initialization."
			}
            $lockAcquired = $true
			$nextForegroundHeartbeatUtc = [DateTime]::UtcNow.AddSeconds(5)
			try {
				Start-MagentaBackgroundHeartbeat
			} catch {
				$fatalLockInitializationError = $_
				Stop-MagentaBackgroundHeartbeat
				$lockAcquired = $false
				$ownedCreatedLock = Get-MagentaPlainDirectory $lockDirectory
				if ($null -ne $ownedCreatedLock -and $ownedCreatedLock.CreationTimeUtc -eq $lockCreationTimeUtc -and (Test-MagentaDirectoryEmpty $lockDirectory)) {
					[IO.Directory]::Delete($lockDirectory, $false)
				}
				throw
			}
        } catch {
			if ($null -ne $fatalLockInitializationError) { throw $fatalLockInitializationError }
			if ($createdThisAttempt) {
				Stop-MagentaBackgroundHeartbeat
				$lockAcquired = $false
				$ownedCreatedLock = Get-MagentaPlainDirectory $lockDirectory
				if ($null -ne $ownedCreatedLock -and $null -ne $lockCreationTimeUtc -and $ownedCreatedLock.CreationTimeUtc -eq $lockCreationTimeUtc -and (Test-MagentaDirectoryEmpty $lockDirectory)) {
					[IO.Directory]::Delete($lockDirectory, $false)
				}
				throw
			}
			if (Try-Remove-MagentaStaleLock ([DateTime]::UtcNow.AddMinutes(-15))) {
                continue
            }
            if ([DateTime]::UtcNow -ge $lockDeadline) {
                throw "Timed out waiting for another Magenta install/update transaction."
            }
            Start-Sleep -Milliseconds 250
        }
    }

	Update-MagentaLockHeartbeat
	$initialJournal = Read-MagentaValidatedJournal $journalPath "prepared" $true
	if ($null -eq (Get-MagentaPlainDirectory $stagingDirectory)) {
		throw "Update staging directory is missing, reparse-backed, or not owned by the current user."
	}
	if (Test-Path -LiteralPath $backupDirectory) {
		throw "Update backup directory already exists before activation."
	}

	if (-not (Test-MagentaResourceFile $currentBinary)) { throw "Current binary is missing or unsafe: $currentBinary" }
	Set-MagentaVerificationEnvironment
	Update-MagentaLockHeartbeat
	$currentVersionOutput = @(& $currentBinary --version 2>&1)
	Update-MagentaLockHeartbeat
    $currentVersionExitCode = $LASTEXITCODE
    $currentInstalledVersion = (($currentVersionOutput | ForEach-Object { "$_" }) -join [Environment]::NewLine).Trim()
    $currentInstalledVersionObject = $null
    if ($currentVersionExitCode -eq 0) {
        try {
            $currentInstalledVersionObject = [version]$currentInstalledVersion
        } catch {
            # A non-numeric development version cannot suppress a verified release update.
        }
    }
    if ($null -ne $currentInstalledVersionObject -and $currentInstalledVersionObject -ge [version]$targetVersion) {
        $currentResourcesValid = $true
        foreach ($resourceDirectory in $requiredResourceDirectories) {
            if (-not (Test-MagentaResourceDirectory (Join-Path $installDirectory $resourceDirectory))) {
                $currentResourcesValid = $false
                break
            }
        }
        if ($currentResourcesValid) {
            foreach ($resourceFile in $requiredResourceFiles) {
                if (-not (Test-MagentaResourceFile (Join-Path $installDirectory $resourceFile))) {
                    $currentResourcesValid = $false
                    break
                }
            }
        }
        if ($currentResourcesValid) {
            foreach ($resourcePath in $requiredResourcePaths) {
                if (-not (Test-MagentaResourceFile (Join-Path $installDirectory $resourcePath))) {
                    $currentResourcesValid = $false
                    break
                }
            }
        }
        $resourceMarkerPath = Join-Path $installDirectory ${quotePowerShellLiteral(RELEASE_RESOURCE_MARKER_NAME)}
        if ($currentResourcesValid -and (Test-MagentaResourceFile $resourceMarkerPath)) {
            try {
                $resourceMarker = Get-Content -LiteralPath $resourceMarkerPath -Raw | ConvertFrom-Json
                $currentResourcesValid = ("$($resourceMarker.version)" -eq $currentInstalledVersion)
            } catch {
                $currentResourcesValid = $false
            }
        } else {
            $currentResourcesValid = $false
        }

        if ($currentResourcesValid) {
            $transactionSucceeded = $true
        } elseif ($currentInstalledVersionObject -gt [version]$targetVersion) {
            throw "A newer Magenta $currentInstalledVersion is installed, but its runtime resources are incomplete; refusing to overwrite it with older $targetVersion. Restart Magenta with network access to repair the installed release."
        }
    }

    if (-not $transactionSucceeded) {
	if (-not (Test-MagentaResourceFile $stagedBinary)) { throw "Staged binary is missing or unsafe: $stagedBinary" }
	    foreach ($resourceName in $resourceNames) {
        $stagedPath = Join-Path $stagingDirectory $resourceName
		if (-not (Test-MagentaOwnedTransactionPath $stagedPath)) { throw "Staged resource is missing or unsafe: $resourceName" }
    }
    New-Item -ItemType Directory -Path $backupDirectory | Out-Null
	if ($null -eq (Get-MagentaPlainDirectory $backupDirectory)) { throw "New update backup directory is unsafe." }

	foreach ($resourceName in $transactionResourceNames) {
		Update-MagentaLockHeartbeat
		$installedPath = Join-Path $installDirectory $resourceName
		$backupPath = Join-Path $backupDirectory $resourceName
		if (Test-Path -LiteralPath $installedPath) {
			if (-not (Test-MagentaOwnedTransactionPath $installedPath)) { throw "Installed resource is unsafe: $resourceName" }
			$originalIdentity = Get-MagentaOriginalPathIdentity $initialJournal $resourceName
			if ($null -eq $originalIdentity) { throw "Unexpected installed resource appeared after transaction prepare: $resourceName" }
			Test-MagentaPathIdentity $resourceName $installedPath $originalIdentity
			Move-Item -LiteralPath $installedPath -Destination $backupPath
			$movedOldResources.Add($resourceName)
			Test-MagentaPathIdentity $resourceName $backupPath $originalIdentity
		}
	}

    foreach ($resourceName in $resourceNames) {
		Update-MagentaLockHeartbeat
        $stagedPath = Join-Path $stagingDirectory $resourceName
        $installedPath = Join-Path $installDirectory $resourceName
		if (Test-Path -LiteralPath $stagedPath) {
			$installedIdentity = Get-MagentaInstalledPathIdentity $initialJournal $resourceName
			Test-MagentaPathIdentity $resourceName $stagedPath $installedIdentity
			Move-Item -LiteralPath $stagedPath -Destination $installedPath
			$movedNewResources.Add($resourceName)
			Test-MagentaPathIdentity $resourceName $installedPath $installedIdentity
        }
    }

	# File.Replace atomically installs the staged executable and creates its rollback copy.
	Update-MagentaLockHeartbeat
	if (-not (Test-MagentaResourceFile $currentBinary) -or -not (Test-MagentaResourceFile $stagedBinary)) {
		throw "Binary paths changed before atomic replacement."
	}
	$originalBinaryIdentity = Get-MagentaOriginalPathIdentity $initialJournal $binaryName
	Test-MagentaPathIdentity $binaryName $currentBinary $originalBinaryIdentity
	if ((Get-FileHash -Algorithm SHA256 -LiteralPath $stagedBinary).Hash.ToLowerInvariant() -cne $initialJournal.binarySha256) {
		throw "Staged binary changed before atomic replacement."
	}
	[IO.File]::Replace($stagedBinary, $currentBinary, $backupBinary, $true)
	$movedOldBinary = $true
	$movedNewBinary = $true
	Test-MagentaPathIdentity $binaryName $backupBinary $originalBinaryIdentity

	Update-MagentaLockHeartbeat
    $versionOutput = @(& $currentBinary --version 2>&1)
	Update-MagentaLockHeartbeat
    $versionExitCode = $LASTEXITCODE
    $installedVersion = (($versionOutput | ForEach-Object { "$_" }) -join [Environment]::NewLine).Trim()
    if ($versionExitCode -ne 0 -or $installedVersion -ne $targetVersion) {
        throw "Installed binary verification failed. Expected $targetVersion, got $installedVersion (exit $versionExitCode)."
    }
	Write-MagentaUpdateJournalPhase "committed"
    $transactionSucceeded = $true
    }
} catch {
	$installError = $_
	$rollbackErrors = New-Object System.Collections.Generic.List[string]
	$rollbackIntentPersisted = $false
	if ($lockAcquired) {
		try {
			if (Test-Path -LiteralPath $journalTempPath) {
				$tempJournal = Read-MagentaValidatedJournal $journalTempPath $null $false
				Remove-MagentaSafeTree $journalTempPath
			}
			Write-MagentaUpdateJournalPhase "rolling_back"
			$rollbackIntentPersisted = $true
		} catch {
			$rollbackErrors.Add("persist rollback intent: $_")
		}
	} else {
		$rollbackErrors.Add("install/update lock was not acquired; transaction left for the lock owner")
	}

		if ($rollbackIntentPersisted) {
			if ($movedOldBinary) {
				try {
				if (-not (Test-MagentaResourceFile $backupBinary) -or -not (Test-MagentaResourceFile $currentBinary)) {
					throw "Binary rollback paths are missing or unsafe."
				}
				$originalBinaryIdentity = Get-MagentaOriginalPathIdentity $initialJournal $binaryName
				Test-MagentaPathIdentity $binaryName $backupBinary $originalBinaryIdentity
					if ((Get-FileHash -Algorithm SHA256 -LiteralPath $currentBinary).Hash.ToLowerInvariant() -cne $initialJournal.binarySha256) {
						throw "Installed binary changed before rollback."
					}
					$installedBinaryIdentity = Get-MagentaPathIdentity $binaryName $currentBinary
					$claimedBinary = Move-MagentaRollbackCandidateToQuarantine $binaryName $currentBinary $installedBinaryIdentity $initialJournal.binarySha256
					try {
						Move-MagentaValidatedRollbackPath $binaryName $backupBinary $currentBinary $originalBinaryIdentity
					} catch {
						$publicationError = $_
						$disposition = "preserved at $claimedBinary"
						try {
							Move-MagentaPathWithoutOverwrite $claimedBinary $currentBinary
							$disposition = "restored to $currentBinary"
						} catch {
							$disposition += " (automatic restore failed: $_)"
						}
						throw ("Old binary publication failed; the claimed binary was " + $disposition + ": " + $publicationError)
					}
					Remove-MagentaSafeTree $claimedBinary
				} catch { $rollbackErrors.Add("restore old binary: $_") }
			}
			for ($index = $movedNewResources.Count - 1; $index -ge 0; $index--) {
			$resourceName = $movedNewResources[$index]
			try {
					$installedPath = Join-Path $installDirectory $resourceName
					$installedIdentity = Get-MagentaInstalledPathIdentity $initialJournal $resourceName
					$claimedResource = Move-MagentaRollbackCandidateToQuarantine $resourceName $installedPath $installedIdentity $null
					Remove-MagentaSafeTree $claimedResource
				} catch { $rollbackErrors.Add("remove new $($resourceName): $_") }
			}
		for ($index = $movedOldResources.Count - 1; $index -ge 0; $index--) {
			$resourceName = $movedOldResources[$index]
			try {
				$backupPath = Join-Path $backupDirectory $resourceName
				$installedPath = Join-Path $installDirectory $resourceName
				Assert-MagentaSafeTree $backupPath
					if (-not (Test-MagentaOwnedTransactionPath $backupPath)) { throw "Backup resource changed before restore." }
					$originalIdentity = Get-MagentaOriginalPathIdentity $initialJournal $resourceName
					Move-MagentaValidatedRollbackPath $resourceName $backupPath $installedPath $originalIdentity
				} catch { $rollbackErrors.Add("restore old $($resourceName): $_") }
		}
    }
	if ($rollbackIntentPersisted -and $rollbackErrors.Count -eq 0) {
		try {
			# A terminal journal makes a crash during artifact cleanup replay as cleanup
			# only; no restored path is reclassified as an activated update object.
			Write-MagentaUpdateJournalPhase "committed"
		} catch {
			$rollbackErrors.Add("persist completed rollback: $_")
		}
	}

    $failureMessage = "Update failed: $installError"
    if ($rollbackErrors.Count -gt 0) {
        $failureMessage += [Environment]::NewLine + "Rollback was incomplete. Backup preserved at $backupDirectory." + [Environment]::NewLine + ($rollbackErrors -join [Environment]::NewLine)
    } else {
		Remove-MagentaSafeTree $backupDirectory
		Remove-MagentaSafeTree $stagingDirectory
		Remove-MagentaSafeTree $journalTempPath
		Remove-MagentaSafeTree $journalPath
        $failureMessage += [Environment]::NewLine + "The previous installation was restored."
    }
    Set-Content -LiteralPath $errorLogPath -Value $failureMessage -Encoding UTF8
} finally {
	try {
		if ($transactionSucceeded) {
			Remove-MagentaSafeTree $backupDirectory
			Remove-MagentaSafeTree $stagingDirectory
			Remove-MagentaSafeTree $journalTempPath
			Remove-MagentaSafeTree $journalPath
			Remove-MagentaSafeTree $errorLogPath
		}
	} finally {
		Release-MagentaInstallLock
    }
}

Remove-MagentaSafeTree $scriptPath
if ($transactionSucceeded) { exit 0 }
exit 1
`;
}
