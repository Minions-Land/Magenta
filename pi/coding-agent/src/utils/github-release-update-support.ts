import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, type FileHandle, link, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

export const RELEASE_RESOURCES_ASSET_NAME = "magenta-resources-universal.tar.gz";
export const RELEASE_CHECKSUMS_ASSET_NAME = "SHA256SUMS";
export const RELEASE_RESOURCE_MARKER_NAME = "magenta-release.json";
export const RELEASE_INSTALL_LOCK_NAME = ".magenta-install-update.lock";
export const RELEASE_UPDATE_JOURNAL_NAME = ".magenta-install-update.json";
const RELEASE_UPDATE_JOURNAL_TEMP_NAME = `${RELEASE_UPDATE_JOURNAL_NAME}.tmp`;
const RELEASE_UPDATE_JOURNAL_VERSION = 1;

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

export function parseReleaseArchive(archiveBytes: Uint8Array): ReleaseArchiveEntry[] {
	let tarBytes: Buffer;
	try {
		tarBytes = gunzipSync(archiveBytes);
	} catch {
		throw new Error("Runtime resource archive is not a valid gzip stream");
	}

	const entries: ReleaseArchiveEntry[] = [];
	const globalPax = new Map<string, string>();
	let localPax = new Map<string, string>();
	let longPath: string | undefined;
	let longLinkPath: string | undefined;
	let offset = 0;

	while (offset + 512 <= tarBytes.length) {
		const header = tarBytes.subarray(offset, offset + 512);
		if (isZeroBlock(header)) {
			for (const byte of tarBytes.subarray(offset)) {
				if (byte !== 0) throw new Error("Unexpected data after tar end marker");
			}
			break;
		}

		verifyTarHeaderChecksum(header);
		const size = parseTarNumber(header.subarray(124, 136), "entry size");
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
		await ensureReleaseResourceVersion(stagingDirectory, expectedVersion);
	}
}

export async function ensureReleaseResourceVersion(resourceDirectory: string, expectedVersion: string): Promise<void> {
	const markerPath = join(resourceDirectory, RELEASE_RESOURCE_MARKER_NAME);
	try {
		await lstat(markerPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		await writeFile(markerPath, `${JSON.stringify({ version: expectedVersion })}\n`, {
			encoding: "utf8",
			flag: "wx",
		});
		return;
	}
	await assertReleaseResourceVersion(resourceDirectory, expectedVersion);
}

export async function assertReleaseResourceVersion(resourceDirectory: string, expectedVersion: string): Promise<void> {
	const markerPath = join(resourceDirectory, RELEASE_RESOURCE_MARKER_NAME);
	await assertRegularFile(markerPath, RELEASE_RESOURCE_MARKER_NAME);
	let marker: unknown;
	try {
		marker = JSON.parse(await readFile(markerPath, "utf8"));
	} catch {
		throw new Error(`Runtime resource marker is invalid: ${markerPath}`);
	}
	if (
		typeof marker !== "object" ||
		marker === null ||
		!("version" in marker) ||
		(marker as { version?: unknown }).version !== expectedVersion
	) {
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

interface ReleaseUpdateTransactionJournal {
	version: typeof RELEASE_UPDATE_JOURNAL_VERSION;
	operationId: string;
	kind: ReleaseUpdateTransactionKind;
	binaryName: string | null;
	targetVersion: string | null;
	resourceNames: string[];
	originalResourceNames: string[];
	phase: ReleaseUpdateTransactionPhase;
}

export interface InitializeReleaseUpdateTransactionOptions {
	installDirectory: string;
	operationId: string;
	kind: ReleaseUpdateTransactionKind;
	binaryName?: string;
	targetVersion?: string;
}

export interface RecoverReleaseUpdateTransactionOptions {
	/** The version of the currently running binary, used only to finish a fully switched transaction. */
	runningVersion?: string;
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
	const keys = Object.keys(candidate).sort();
	const expectedKeys = [
		"binaryName",
		"kind",
		"operationId",
		"originalResourceNames",
		"phase",
		"resourceNames",
		"targetVersion",
		"version",
	].sort();
	if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
		throw new Error("Update transaction journal has an unsupported schema");
	}
	if (candidate.version !== RELEASE_UPDATE_JOURNAL_VERSION) {
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
	if (!Array.isArray(candidate.resourceNames) || !Array.isArray(candidate.originalResourceNames)) {
		throw new Error("Update transaction journal has invalid resource lists");
	}
	const resourceNames = candidate.resourceNames as unknown[];
	const originalResourceNames = candidate.originalResourceNames as unknown[];
	if (
		resourceNames.some((name) => typeof name !== "string" || !isSafeUpdateResourceName(name)) ||
		new Set(resourceNames).size !== resourceNames.length ||
		originalResourceNames.some((name) => typeof name !== "string" || !resourceNames.includes(name)) ||
		new Set(originalResourceNames).size !== originalResourceNames.length
	) {
		throw new Error("Update transaction journal has unsafe resource names");
	}
	if (candidate.kind === "resources") {
		if (candidate.binaryName !== null) throw new Error("Resource transaction journal contains a binary name");
	} else if (
		typeof candidate.binaryName !== "string" ||
		!isSafeArtifactBasename(candidate.binaryName) ||
		resourceNames.includes(candidate.binaryName)
	) {
		throw new Error("Update transaction journal has an unsafe binary name");
	}
	if (candidate.phase !== "staging" && resourceNames.length === 0) {
		throw new Error("Prepared update transaction journal contains no resources");
	}
	return candidate as unknown as ReleaseUpdateTransactionJournal;
}

async function readJournalFile(path: string): Promise<ReleaseUpdateTransactionJournal> {
	const stats = await assertOwnedPath(path, { type: "file", privateFile: true });
	if (stats.size > 64 * 1024) throw new Error("Update transaction journal is too large");
	return parseReleaseUpdateJournal(await readFile(path, "utf8"));
}

async function writeReleaseUpdateJournal(
	installDirectory: string,
	journal: ReleaseUpdateTransactionJournal,
): Promise<void> {
	parseReleaseUpdateJournal(JSON.stringify(journal));
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
		await handle.writeFile(`${JSON.stringify(journal)}\n`, "utf8");
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
		if (
			temporaryJournal.operationId !== journal.operationId ||
			temporaryJournal.kind !== journal.kind ||
			temporaryJournal.binaryName !== journal.binaryName ||
			temporaryJournal.targetVersion !== journal.targetVersion
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
	const journal: ReleaseUpdateTransactionJournal = {
		version: RELEASE_UPDATE_JOURNAL_VERSION,
		operationId: options.operationId,
		kind: options.kind,
		binaryName: binaryName ?? null,
		targetVersion: options.targetVersion ?? null,
		resourceNames: [],
		originalResourceNames: [],
		phase: "staging",
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

async function rollbackResource(
	installDirectory: string,
	stagingDirectory: string,
	backupDirectory: string,
	resourceName: string,
	hadOriginal: boolean,
	phase: ReleaseUpdateTransactionPhase,
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
			if (staged && installed) {
				throw new Error(`Ambiguous update recovery layout for ${resourceName}`);
			}
			if (installed) await rm(installedPath, { recursive: true, force: false });
			await rename(backupPath, installedPath);
			return;
		}
		if (!installed || (!staged && phase !== "rolling_back")) {
			throw new Error(`Previous installed resource cannot be identified safely: ${resourceName}`);
		}
		return;
	}

	if (backup) throw new Error(`Unexpected backup for previously absent resource: ${resourceName}`);
	if (staged && installed) throw new Error(`Ambiguous update recovery layout for ${resourceName}`);
	if (!staged && installed) {
		await rm(installedPath, { recursive: true, force: false });
		return;
	}
	if (!staged && !installed && phase !== "rolling_back") {
		throw new Error(`New resource cannot be identified safely: ${resourceName}`);
	}
}

async function rollbackBinary(
	installDirectory: string,
	stagingDirectory: string,
	backupDirectory: string,
	binaryName: string,
	phase: ReleaseUpdateTransactionPhase,
): Promise<void> {
	const currentBinary = join(installDirectory, binaryName);
	const stagedBinary = join(stagingDirectory, binaryName);
	const backupBinary = join(backupDirectory, binaryName);
	const [current, staged, backup] = await Promise.all([
		ownedPathExists(currentBinary, "file"),
		ownedPathExists(stagedBinary, "file"),
		ownedPathExists(backupBinary, "file"),
	]);
	if (backup) {
		if (staged) {
			if (!current) throw new Error("Current binary disappeared before atomic replacement");
			const [currentStats, backupStats] = await Promise.all([lstat(currentBinary), lstat(backupBinary)]);
			if (currentStats.dev !== backupStats.dev || currentStats.ino !== backupStats.ino) {
				throw new Error("Current and backup binaries do not share the expected pre-replacement identity");
			}
			return;
		}
		await rename(backupBinary, currentBinary);
		await syncDirectory(installDirectory);
		return;
	}
	if (!current || (!staged && phase !== "rolling_back")) {
		throw new Error("Previous Magenta binary cannot be identified safely");
	}
}

async function transactionLooksFullyActivated(
	installDirectory: string,
	journal: ReleaseUpdateTransactionJournal,
): Promise<boolean> {
	const paths = updateTransactionPaths(installDirectory, journal);
	for (const resourceName of journal.resourceNames) {
		if (await assertSafeResourceCandidate(join(paths.stagingDirectory, resourceName))) return false;
		if (!(await assertSafeResourceCandidate(join(installDirectory, resourceName)))) return false;
	}
	if (journal.binaryName) {
		if (await ownedPathExists(join(paths.stagingDirectory, journal.binaryName), "file")) return false;
		if (!(await ownedPathExists(join(installDirectory, journal.binaryName), "file"))) return false;
	}
	return true;
}

/** Recover or finish the one journal-owned transaction for an installation. Must be called under the install lock. */
export async function recoverInterruptedReleaseUpdateTransaction(
	installDirectory: string,
	options: RecoverReleaseUpdateTransactionOptions = {},
): Promise<boolean> {
	await assertOwnedPath(installDirectory, { type: "directory" });
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
			journal.phase,
		);
	}
	const originalResourceNames = new Set(journal.originalResourceNames);
	for (const resourceName of [...journal.resourceNames].reverse()) {
		await rollbackResource(
			installDirectory,
			paths.stagingDirectory,
			paths.backupDirectory,
			resourceName,
			originalResourceNames.has(resourceName),
			journal.phase,
		);
	}
	await syncDirectory(installDirectory);
	await cleanupTransactionArtifacts(installDirectory, journal);
	return true;
}

export interface UnixUpdateTransactionOptions {
	currentBinary: string;
	operationId: string;
	stagingDirectory: string;
	backupDirectory: string;
	resourceNames: readonly string[];
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
	resourceNames: readonly string[];
	targetVersion?: string;
	verifyInstalled(): void | Promise<void>;
	fileSystem?: UpdateTransactionFileSystem;
	/** @internal Deterministic crash injection for transaction recovery tests. */
	testFaultInjector?(point: string): void;
}

class InjectedUpdateInterruption extends Error {}

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
	stagingDirectory: string;
	backupDirectory: string;
	resourceNames: readonly string[];
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
	const resourceNames = [...new Set(options.resourceNames)];
	if (resourceNames.length === 0) throw new Error("Update transaction contains no resources");
	for (const resourceName of resourceNames) {
		if (!isSafeUpdateResourceName(resourceName) || resourceName === options.binaryName) {
			throw new Error(`Unsafe update resource name: ${resourceName}`);
		}
		if (!(await assertSafeResourceCandidate(join(options.stagingDirectory, resourceName)))) {
			throw new Error(`Staged resource is missing: ${resourceName}`);
		}
	}

	let journal = await readPendingJournal(options.installDirectory);
	if (!journal) {
		await initializeReleaseUpdateTransaction({
			installDirectory: options.installDirectory,
			operationId: options.operationId,
			kind: options.kind,
			binaryName: options.binaryName,
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
		journal.targetVersion !== (options.targetVersion ?? null)
	) {
		throw new Error("Update transaction journal does not match the staged update");
	}
	if (await ownedPathExists(options.backupDirectory)) {
		throw new Error(`Update backup path already exists: ${options.backupDirectory}`);
	}
	const originalResourceNames: string[] = [];
	for (const resourceName of resourceNames) {
		if (await assertSafeResourceCandidate(join(options.installDirectory, resourceName))) {
			originalResourceNames.push(resourceName);
		}
	}
	journal = {
		...journal,
		resourceNames,
		originalResourceNames,
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
	resourceNames: readonly string[];
	targetVersion: string;
}

/** Persist the Windows helper's complete write-ahead intent before the parent process releases the install lock. */
export async function prepareWindowsReleaseUpdateTransaction(
	options: PrepareWindowsReleaseUpdateTransactionOptions,
): Promise<void> {
	if (resolve(dirname(options.currentBinary)) !== resolve(options.installDirectory)) {
		throw new Error("Windows update binary is outside the installation directory");
	}
	await assertOwnedPath(options.currentBinary, { type: "file" });
	await assertOwnedPath(join(options.stagingDirectory, basename(options.currentBinary)), { type: "file" });
	await prepareReleaseUpdateJournal({
		installDirectory: options.installDirectory,
		operationId: options.operationId,
		kind: "windows",
		binaryName: basename(options.currentBinary),
		stagingDirectory: options.stagingDirectory,
		backupDirectory: options.backupDirectory,
		resourceNames: options.resourceNames,
		targetVersion: options.targetVersion,
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
		targetVersion: options.targetVersion,
	});
	try {
		injectUpdateFault(options, "journal:prepared");
		await fileSystem.makeDirectory(options.backupDirectory);
		for (const resourceName of journal.originalResourceNames) {
			await fileSystem.movePath(
				join(options.installDirectory, resourceName),
				join(options.backupDirectory, resourceName),
			);
			await syncDirectory(options.backupDirectory);
			await syncDirectory(options.installDirectory);
			injectUpdateFault(options, `resource-backup:${resourceName}`);
		}
		for (const resourceName of journal.resourceNames) {
			await fileSystem.movePath(
				join(options.stagingDirectory, resourceName),
				join(options.installDirectory, resourceName),
			);
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
	await assertOwnedPath(options.currentBinary, { type: "file" });
	await assertOwnedPath(stagedBinary, { type: "file" });
	const journal = await prepareReleaseUpdateJournal({
		installDirectory,
		operationId: options.operationId,
		kind: "unix",
		binaryName,
		stagingDirectory: options.stagingDirectory,
		backupDirectory: options.backupDirectory,
		resourceNames: options.resourceNames,
		targetVersion: options.targetVersion,
	});

	try {
		injectUpdateFault(options, "journal:prepared");
		await fileSystem.makeDirectory(options.backupDirectory);
		for (const resourceName of journal.originalResourceNames) {
			await fileSystem.movePath(join(installDirectory, resourceName), join(options.backupDirectory, resourceName));
			await syncDirectory(options.backupDirectory);
			await syncDirectory(installDirectory);
			injectUpdateFault(options, `resource-backup:${resourceName}`);
		}
		for (const resourceName of journal.resourceNames) {
			await fileSystem.movePath(join(options.stagingDirectory, resourceName), join(installDirectory, resourceName));
			await syncDirectory(options.stagingDirectory);
			await syncDirectory(installDirectory);
			injectUpdateFault(options, `resource-install:${resourceName}`);
		}

		await link(options.currentBinary, backupBinary);
		await syncFile(backupBinary);
		await syncDirectory(options.backupDirectory);
		injectUpdateFault(options, "binary-backup:complete");
		// POSIX rename replaces the executable in one atomic step; currentBinary is never absent.
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
	operationId: string;
	currentBinary: string;
	stagingDirectory: string;
	backupDirectory: string;
	resourceNames: readonly string[];
	targetVersion: string;
	scriptPath: string;
	errorLogPath: string;
}

export function buildWindowsUpdateScript(options: WindowsUpdateScriptOptions): string {
	const binaryName = basename(options.currentBinary);
	const installDirectory = dirname(options.currentBinary);
	assertSafeOperationId(options.operationId);
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
	const resourceLines = options.resourceNames.map((name) => `    ${quotePowerShellLiteral(name)}`).join(",\n");
	const requiredDirectoryLines = RESOURCE_DIRECTORY_NAMES.map((name) => `    ${quotePowerShellLiteral(name)}`).join(
		",\n",
	);
	const requiredFileLines = RESOURCE_FILE_NAMES.map((name) => `    ${quotePowerShellLiteral(name)}`).join(",\n");
	const requiredPathLines = REQUIRED_RESOURCE_PATHS.map((name) => `    ${quotePowerShellLiteral(name)}`).join(",\n");

	return `$ErrorActionPreference = "Stop"
$parentProcessId = ${options.parentProcessId}
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

function Test-MagentaStringArraysEqual($left, $right) {
	$leftValues = @($left)
	$rightValues = @($right)
	if ($leftValues.Count -ne $rightValues.Count) { return $false }
	for ($index = 0; $index -lt $leftValues.Count; $index++) {
		if ([string]$leftValues[$index] -cne [string]$rightValues[$index]) { return $false }
	}
	return $true
}

function Read-MagentaValidatedJournal([string]$path, [AllowNull()][string]$expectedPhase, [bool]$validateOriginalLayout) {
	if (-not (Test-MagentaResourceFile $path)) { throw "Update transaction journal is missing or unsafe: $path" }
	try {
		$journal = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
	} catch {
		throw "Update transaction journal is not valid JSON: $path"
	}
	$expectedProperties = @("binaryName", "kind", "operationId", "originalResourceNames", "phase", "resourceNames", "targetVersion", "version") | Sort-Object
	$actualProperties = @($journal.PSObject.Properties.Name | Sort-Object)
	if ($actualProperties.Count -ne $expectedProperties.Count -or @(Compare-Object $expectedProperties $actualProperties -CaseSensitive).Count -ne 0) {
		throw "Update transaction journal has an unsupported schema: $path"
	}
	if (-not ($journal.version -is [System.Int32]) -and -not ($journal.version -is [System.Int64])) {
		throw "Update transaction journal version has an invalid type: $path"
	}
	foreach ($stringProperty in @("operationId", "kind", "binaryName", "targetVersion", "phase")) {
		if (-not ($journal.$stringProperty -is [string])) {
			throw "Update transaction journal property $stringProperty has an invalid type: $path"
		}
	}
	if (-not ($journal.resourceNames -is [System.Array]) -or -not ($journal.originalResourceNames -is [System.Array])) {
		throw "Update transaction journal resource lists must be arrays: $path"
	}
	foreach ($resourceValue in @($journal.resourceNames) + @($journal.originalResourceNames)) {
		if (-not ($resourceValue -is [string])) {
			throw "Update transaction journal resource names must be strings: $path"
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
	if (-not (Test-MagentaStringArraysEqual @($journal.resourceNames) $resourceNames)) {
		throw "Update transaction journal resource list does not match this helper: $path"
	}
	$originalNames = @($journal.originalResourceNames)
	$seenOriginalNames = @{}
	foreach ($originalName in $originalNames) {
		if ($seenOriginalNames.ContainsKey($originalName) -or $resourceNames -cnotcontains $originalName) {
			throw "Update transaction journal has an invalid original resource list: $path"
		}
		$seenOriginalNames[$originalName] = $true
	}
	if ($validateOriginalLayout) {
		$actualOriginalNames = New-Object System.Collections.Generic.List[string]
		foreach ($resourceName in $resourceNames) {
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
	}
	return $journal
}

function Write-MagentaUpdateJournalPhase([string]$phase) {
	if (@("rolling_back", "committed") -cnotcontains $phase) { throw "Unsupported update journal transition: $phase" }
    if (Test-Path -LiteralPath $journalTempPath) { throw "Update transaction journal temporary file already exists." }
	$journal = Read-MagentaValidatedJournal $journalPath "prepared" $false
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

while (Get-Process -Id $parentProcessId -ErrorAction SilentlyContinue) {
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
    $env:PI_PACKAGE_DIR = $installDirectory
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

    foreach ($resourceName in $resourceNames) {
		Update-MagentaLockHeartbeat
        $installedPath = Join-Path $installDirectory $resourceName
        $backupPath = Join-Path $backupDirectory $resourceName
        if (Test-Path -LiteralPath $installedPath) {
			if (-not (Test-MagentaOwnedTransactionPath $installedPath)) { throw "Installed resource is unsafe: $resourceName" }
            Move-Item -LiteralPath $installedPath -Destination $backupPath
            $movedOldResources.Add($resourceName)
        }
    }

    foreach ($resourceName in $resourceNames) {
		Update-MagentaLockHeartbeat
        $stagedPath = Join-Path $stagingDirectory $resourceName
        $installedPath = Join-Path $installDirectory $resourceName
        if (Test-Path -LiteralPath $stagedPath) {
			if (-not (Test-MagentaOwnedTransactionPath $stagedPath)) { throw "Staged resource changed before activation: $resourceName" }
            Move-Item -LiteralPath $stagedPath -Destination $installedPath
            $movedNewResources.Add($resourceName)
        }
    }

	# File.Replace atomically installs the staged executable and creates its rollback copy.
	Update-MagentaLockHeartbeat
	if (-not (Test-MagentaResourceFile $currentBinary) -or -not (Test-MagentaResourceFile $stagedBinary)) {
		throw "Binary paths changed before atomic replacement."
	}
    [IO.File]::Replace($stagedBinary, $currentBinary, $backupBinary, $true)
	$movedOldBinary = $true
    $movedNewBinary = $true

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
				[IO.File]::Replace($backupBinary, $currentBinary, $null, $true)
			} catch { $rollbackErrors.Add("restore old binary: $_") }
		}
		for ($index = $movedNewResources.Count - 1; $index -ge 0; $index--) {
			$resourceName = $movedNewResources[$index]
			try {
				$installedPath = Join-Path $installDirectory $resourceName
				Remove-MagentaSafeTree $installedPath
			} catch { $rollbackErrors.Add("remove new $($resourceName): $_") }
		}
		for ($index = $movedOldResources.Count - 1; $index -ge 0; $index--) {
			$resourceName = $movedOldResources[$index]
			try {
				$backupPath = Join-Path $backupDirectory $resourceName
				$installedPath = Join-Path $installDirectory $resourceName
				Assert-MagentaSafeTree $backupPath
				if (-not (Test-MagentaOwnedTransactionPath $backupPath)) { throw "Backup resource changed before restore." }
				Move-Item -LiteralPath $backupPath -Destination $installedPath
			} catch { $rollbackErrors.Add("restore old $($resourceName): $_") }
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
