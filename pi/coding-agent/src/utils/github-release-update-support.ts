import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

export const RELEASE_RESOURCES_ASSET_NAME = "magenta-resources-universal.tar.gz";
export const RELEASE_CHECKSUMS_ASSET_NAME = "SHA256SUMS";
export const RELEASE_RESOURCE_MARKER_NAME = "magenta-release.json";
export const RELEASE_INSTALL_LOCK_NAME = ".magenta-install-update.lock";

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

export const REQUIRED_RESOURCE_PATHS = [
	"theme/dark.json",
	"tools/read/read.toml",
	"skills/paper-analysis/pi/SKILL.md",
	"photon_rs_bg.wasm",
] as const;

export interface ReleaseAssetDescriptor {
	name: string;
	browser_download_url: string;
}

export interface ReleaseAssetDownload {
	name: string;
	downloadUrl: string;
}

export interface ReleaseAssetPlan {
	binary: ReleaseAssetDownload;
	resources: ReleaseAssetDownload;
	checksums: ReleaseAssetDownload;
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
		const downloadUrl = matches[0]?.browser_download_url;
		if (!downloadUrl) {
			throw new Error(`Release asset has no download URL: ${name}`);
		}
		return { name, downloadUrl };
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
		for (const requiredPath of REQUIRED_RESOURCE_PATHS) {
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
		await mkdir(path);
	},
	async movePath(source, destination) {
		await rename(source, destination);
	},
	async removePath(path) {
		await rm(path, { recursive: true, force: true });
	},
};

export interface UnixUpdateTransactionOptions {
	currentBinary: string;
	stagingDirectory: string;
	backupDirectory: string;
	resourceNames: readonly string[];
	verifyInstalled(): void | Promise<void>;
	fileSystem?: UpdateTransactionFileSystem;
}

async function cleanupUpdatePaths(
	fileSystem: UpdateTransactionFileSystem,
	paths: readonly string[],
): Promise<string[]> {
	const errors: string[] = [];
	for (const path of paths) {
		try {
			await fileSystem.removePath(path);
		} catch (error) {
			errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return errors;
}

export interface ResourceUpdateTransactionOptions {
	installDirectory: string;
	stagingDirectory: string;
	backupDirectory: string;
	resourceNames: readonly string[];
	verifyInstalled(): void | Promise<void>;
	fileSystem?: UpdateTransactionFileSystem;
}

export async function applyResourceUpdateTransaction(options: ResourceUpdateTransactionOptions): Promise<string[]> {
	const fileSystem = options.fileSystem ?? NODE_UPDATE_TRANSACTION_FILE_SYSTEM;
	const resourceNames = [...new Set(options.resourceNames)];
	for (const resourceName of resourceNames) {
		if (!isSafeArtifactBasename(resourceName)) {
			throw new Error(`Unsafe update resource name: ${resourceName}`);
		}
		if (!(await fileSystem.pathExists(join(options.stagingDirectory, resourceName)))) {
			throw new Error(`Staged resource is missing: ${resourceName}`);
		}
	}

	await fileSystem.makeDirectory(options.backupDirectory);
	const movedOldResources: string[] = [];
	const movedNewResources: string[] = [];

	try {
		for (const resourceName of resourceNames) {
			const installedPath = join(options.installDirectory, resourceName);
			if (await fileSystem.pathExists(installedPath)) {
				await fileSystem.movePath(installedPath, join(options.backupDirectory, resourceName));
				movedOldResources.push(resourceName);
			}
		}
		for (const resourceName of resourceNames) {
			await fileSystem.movePath(
				join(options.stagingDirectory, resourceName),
				join(options.installDirectory, resourceName),
			);
			movedNewResources.push(resourceName);
		}
		await options.verifyInstalled();
	} catch (error) {
		const rollbackErrors: string[] = [];
		const attempt = async (label: string, operation: () => Promise<void>): Promise<void> => {
			try {
				await operation();
			} catch (rollbackError) {
				rollbackErrors.push(
					`${label}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
				);
			}
		};

		for (const resourceName of [...movedNewResources].reverse()) {
			await attempt(`remove new ${resourceName}`, () =>
				fileSystem.removePath(join(options.installDirectory, resourceName)),
			);
		}
		for (const resourceName of [...movedOldResources].reverse()) {
			await attempt(`restore old ${resourceName}`, () =>
				fileSystem.movePath(
					join(options.backupDirectory, resourceName),
					join(options.installDirectory, resourceName),
				),
			);
		}

		const originalMessage = error instanceof Error ? error.message : String(error);
		if (rollbackErrors.length > 0) {
			throw new Error(
				`Resource update failed (${originalMessage}) and rollback was incomplete. Backup preserved at ${options.backupDirectory}. ${rollbackErrors.join("; ")}`,
			);
		}
		await cleanupUpdatePaths(fileSystem, [options.backupDirectory, options.stagingDirectory]);
		throw new Error(`Resource update failed and the previous resources were restored: ${originalMessage}`);
	}

	return cleanupUpdatePaths(fileSystem, [options.backupDirectory, options.stagingDirectory]);
}

export async function applyUnixUpdateTransaction(options: UnixUpdateTransactionOptions): Promise<string[]> {
	const fileSystem = options.fileSystem ?? NODE_UPDATE_TRANSACTION_FILE_SYSTEM;
	const installDirectory = dirname(options.currentBinary);
	const binaryName = basename(options.currentBinary);
	const stagedBinary = join(options.stagingDirectory, binaryName);
	const backupBinary = join(options.backupDirectory, binaryName);
	const resourceNames = [...new Set(options.resourceNames)];

	for (const resourceName of resourceNames) {
		if (!isSafeArtifactBasename(resourceName) || resourceName === binaryName) {
			throw new Error(`Unsafe update resource name: ${resourceName}`);
		}
	}
	if (!(await fileSystem.pathExists(stagedBinary))) throw new Error(`Staged binary is missing: ${stagedBinary}`);
	if (!(await fileSystem.pathExists(options.currentBinary))) {
		throw new Error(`Current binary is missing: ${options.currentBinary}`);
	}
	for (const resourceName of resourceNames) {
		if (!(await fileSystem.pathExists(join(options.stagingDirectory, resourceName)))) {
			throw new Error(`Staged resource is missing: ${resourceName}`);
		}
	}

	await fileSystem.makeDirectory(options.backupDirectory);
	const movedOldResources: string[] = [];
	const movedNewResources: string[] = [];
	let movedOldBinary = false;
	let movedNewBinary = false;

	try {
		for (const resourceName of resourceNames) {
			const installedPath = join(installDirectory, resourceName);
			if (await fileSystem.pathExists(installedPath)) {
				await fileSystem.movePath(installedPath, join(options.backupDirectory, resourceName));
				movedOldResources.push(resourceName);
			}
		}
		for (const resourceName of resourceNames) {
			const stagedPath = join(options.stagingDirectory, resourceName);
			if (await fileSystem.pathExists(stagedPath)) {
				await fileSystem.movePath(stagedPath, join(installDirectory, resourceName));
				movedNewResources.push(resourceName);
			}
		}

		await fileSystem.movePath(options.currentBinary, backupBinary);
		movedOldBinary = true;
		await fileSystem.movePath(stagedBinary, options.currentBinary);
		movedNewBinary = true;
		await options.verifyInstalled();
	} catch (error) {
		const rollbackErrors: string[] = [];
		const attempt = async (label: string, operation: () => Promise<void>): Promise<void> => {
			try {
				await operation();
			} catch (rollbackError) {
				rollbackErrors.push(
					`${label}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
				);
			}
		};

		if (movedNewBinary) {
			await attempt("remove new binary", () => fileSystem.removePath(options.currentBinary));
		}
		if (movedOldBinary) {
			await attempt("restore old binary", () => fileSystem.movePath(backupBinary, options.currentBinary));
		}
		for (const resourceName of [...movedNewResources].reverse()) {
			await attempt(`remove new ${resourceName}`, () => fileSystem.removePath(join(installDirectory, resourceName)));
		}
		for (const resourceName of [...movedOldResources].reverse()) {
			await attempt(`restore old ${resourceName}`, () =>
				fileSystem.movePath(join(options.backupDirectory, resourceName), join(installDirectory, resourceName)),
			);
		}

		const originalMessage = error instanceof Error ? error.message : String(error);
		if (rollbackErrors.length > 0) {
			throw new Error(
				`Update failed (${originalMessage}) and rollback was incomplete. Backup preserved at ${options.backupDirectory}. ${rollbackErrors.join("; ")}`,
			);
		}
		await cleanupUpdatePaths(fileSystem, [options.backupDirectory, options.stagingDirectory]);
		throw new Error(`Update failed and the previous installation was restored: ${originalMessage}`);
	}

	return cleanupUpdatePaths(fileSystem, [options.backupDirectory, options.stagingDirectory]);
}

export function quotePowerShellLiteral(value: string): string {
	if (/[\r\n\u0000]/.test(value)) throw new Error("PowerShell literal contains a control character");
	return `'${value.replaceAll("'", "''")}'`;
}

export interface WindowsUpdateScriptOptions {
	parentProcessId: number;
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
	for (const resourceName of options.resourceNames) {
		if (!isSafeArtifactBasename(resourceName) || resourceName === binaryName) {
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
$installDirectory = ${quotePowerShellLiteral(installDirectory)}
$currentBinary = ${quotePowerShellLiteral(options.currentBinary)}
$binaryName = ${quotePowerShellLiteral(binaryName)}
$stagingDirectory = ${quotePowerShellLiteral(options.stagingDirectory)}
$backupDirectory = ${quotePowerShellLiteral(options.backupDirectory)}
$targetVersion = ${quotePowerShellLiteral(options.targetVersion)}
$scriptPath = ${quotePowerShellLiteral(options.scriptPath)}
$errorLogPath = ${quotePowerShellLiteral(options.errorLogPath)}
$lockDirectory = Join-Path $installDirectory ${quotePowerShellLiteral(RELEASE_INSTALL_LOCK_NAME)}
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
$transactionSucceeded = $false
$backupBinary = Join-Path $backupDirectory $binaryName
$stagedBinary = Join-Path $stagingDirectory $binaryName

function Test-MagentaResourceDirectory([string]$path) {
    $item = Get-Item -LiteralPath $path -ErrorAction SilentlyContinue
    return ($null -ne $item -and $item.PSIsContainer -and -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint))
}

function Test-MagentaResourceFile([string]$path) {
    $item = Get-Item -LiteralPath $path -ErrorAction SilentlyContinue
    return ($null -ne $item -and -not $item.PSIsContainer -and -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint))
}

while (Get-Process -Id $parentProcessId -ErrorAction SilentlyContinue) {
    Start-Sleep -Milliseconds 250
}

try {
    $lockDeadline = [DateTime]::UtcNow.AddMinutes(10)
    while (-not $lockAcquired) {
        try {
            New-Item -ItemType Directory -Path $lockDirectory -ErrorAction Stop | Out-Null
            $lockAcquired = $true
        } catch {
            $lockInfo = Get-Item -LiteralPath $lockDirectory -ErrorAction SilentlyContinue
            if ($lockInfo -and $lockInfo.LastWriteTimeUtc -lt [DateTime]::UtcNow.AddMinutes(-15)) {
                Remove-Item -LiteralPath $lockDirectory -Recurse -Force -ErrorAction SilentlyContinue
                continue
            }
            if ([DateTime]::UtcNow -ge $lockDeadline) {
                throw "Timed out waiting for another Magenta install/update transaction."
            }
            Start-Sleep -Milliseconds 250
        }
    }

    if (-not (Test-Path -LiteralPath $currentBinary -PathType Leaf)) { throw "Current binary is missing: $currentBinary" }
    $env:PI_PACKAGE_DIR = $installDirectory
    $currentVersionOutput = @(& $currentBinary --version 2>&1)
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
    if (-not (Test-Path -LiteralPath $stagedBinary -PathType Leaf)) { throw "Staged binary is missing: $stagedBinary" }
    foreach ($resourceName in $resourceNames) {
        $stagedPath = Join-Path $stagingDirectory $resourceName
        if (-not (Test-Path -LiteralPath $stagedPath)) { throw "Staged resource is missing: $resourceName" }
    }
    New-Item -ItemType Directory -Path $backupDirectory | Out-Null

    foreach ($resourceName in $resourceNames) {
        $installedPath = Join-Path $installDirectory $resourceName
        $backupPath = Join-Path $backupDirectory $resourceName
        if (Test-Path -LiteralPath $installedPath) {
            Move-Item -LiteralPath $installedPath -Destination $backupPath
            $movedOldResources.Add($resourceName)
        }
    }

    foreach ($resourceName in $resourceNames) {
        $stagedPath = Join-Path $stagingDirectory $resourceName
        $installedPath = Join-Path $installDirectory $resourceName
        if (Test-Path -LiteralPath $stagedPath) {
            Move-Item -LiteralPath $stagedPath -Destination $installedPath
            $movedNewResources.Add($resourceName)
        }
    }

    Move-Item -LiteralPath $currentBinary -Destination $backupBinary
    $movedOldBinary = $true
    Move-Item -LiteralPath $stagedBinary -Destination $currentBinary
    $movedNewBinary = $true

    $versionOutput = @(& $currentBinary --version 2>&1)
    $versionExitCode = $LASTEXITCODE
    $installedVersion = (($versionOutput | ForEach-Object { "$_" }) -join [Environment]::NewLine).Trim()
    if ($versionExitCode -ne 0 -or $installedVersion -ne $targetVersion) {
        throw "Installed binary verification failed. Expected $targetVersion, got $installedVersion (exit $versionExitCode)."
    }
    $transactionSucceeded = $true
    }
} catch {
    $installError = $_
    $rollbackErrors = New-Object System.Collections.Generic.List[string]

    if ($movedNewBinary -and (Test-Path -LiteralPath $currentBinary)) {
        try { Remove-Item -LiteralPath $currentBinary -Force } catch { $rollbackErrors.Add("remove new binary: $_") }
    }
    if ($movedOldBinary) {
        try {
            Move-Item -LiteralPath $backupBinary -Destination $currentBinary
        } catch { $rollbackErrors.Add("restore old binary: $_") }
    }
    for ($index = $movedNewResources.Count - 1; $index -ge 0; $index--) {
        $resourceName = $movedNewResources[$index]
        try {
            $installedPath = Join-Path $installDirectory $resourceName
            if (Test-Path -LiteralPath $installedPath) { Remove-Item -LiteralPath $installedPath -Recurse -Force }
        } catch { $rollbackErrors.Add("remove new $($resourceName): $_") }
    }
    for ($index = $movedOldResources.Count - 1; $index -ge 0; $index--) {
        $resourceName = $movedOldResources[$index]
        try {
            $backupPath = Join-Path $backupDirectory $resourceName
            $installedPath = Join-Path $installDirectory $resourceName
            Move-Item -LiteralPath $backupPath -Destination $installedPath
        } catch { $rollbackErrors.Add("restore old $($resourceName): $_") }
    }

    $failureMessage = "Update failed: $installError"
    if ($rollbackErrors.Count -gt 0) {
        $failureMessage += [Environment]::NewLine + "Rollback was incomplete. Backup preserved at $backupDirectory." + [Environment]::NewLine + ($rollbackErrors -join [Environment]::NewLine)
    } else {
        Remove-Item -LiteralPath $backupDirectory -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $stagingDirectory -Recurse -Force -ErrorAction SilentlyContinue
        $failureMessage += [Environment]::NewLine + "The previous installation was restored."
    }
    Set-Content -LiteralPath $errorLogPath -Value $failureMessage -Encoding UTF8
} finally {
    if ($lockAcquired) {
        Remove-Item -LiteralPath $lockDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
}

if ($transactionSucceeded) {
    Remove-Item -LiteralPath $backupDirectory -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stagingDirectory -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $errorLogPath -Force -ErrorAction SilentlyContinue
}

Remove-Item -LiteralPath $scriptPath -Force -ErrorAction SilentlyContinue
if ($transactionSucceeded) { exit 0 }
exit 1
`;
}
