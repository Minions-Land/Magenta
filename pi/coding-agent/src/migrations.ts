/**
 * One-time migrations that run on startup.
 */

import {
	cleanupEmptyOrphanMultiagentRegistries,
	DurableMultiagentRegistry,
	MessageStore,
	migrateLegacyMessageStore,
	secureAtomicWriteFileSync,
	secureReadFileSync,
	withSecureFileLockSync,
} from "@magenta/harness";
import chalk from "chalk";
import { randomUUID } from "crypto";
import type { Dirent } from "fs";
import {
	closeSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
} from "fs";
import { homedir } from "os";
import { basename, dirname, join } from "path";
import {
	CONFIG_DIR_NAME,
	ENV_AGENT_DIR,
	ENV_PEER_MESSAGE_DB,
	getAgentDir,
	getBinDir,
	getPeerMessageDbPath,
	getSessionsDir,
} from "./config.ts";
import { migrateKeybindingsConfig } from "./core/keybindings.ts";

const MIGRATION_GUIDE_URL =
	"https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/CHANGELOG.md#extensions-migration";
const EXTENSIONS_DOC_URL =
	"https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md";
const LEGACY_JSON_STATE_MAX_BYTES = 8 * 1024 * 1024;

export interface LegacyAgentDirMigrationOptions {
	oldAgentDir?: string;
	newAgentDir?: string;
	envAgentDir?: string;
	configDirName?: string;
}

/**
 * Copy the old upstream default ~/.pi/agent to the current branded default.
 *
 * This is deliberately non-destructive: it never deletes or renames ~/.pi/agent, never runs when
 * the user explicitly overrides the agent dir, and never overwrites an existing destination.
 */
export function migrateLegacyPiAgentDirToCurrentConfigDir(options: LegacyAgentDirMigrationOptions = {}): boolean {
	const configDirName = options.configDirName ?? CONFIG_DIR_NAME;
	const envAgentDir = "envAgentDir" in options ? options.envAgentDir : process.env[ENV_AGENT_DIR];
	if (envAgentDir || configDirName === ".pi") return false;

	const oldAgentDir = options.oldAgentDir ?? join(homedir(), ".pi", "agent");
	const newAgentDir = options.newAgentDir ?? getAgentDir();
	if (!existsSync(oldAgentDir) || existsSync(newAgentDir)) return false;

	try {
		mkdirSync(dirname(newAgentDir), { recursive: true });
		return withSecureFileLockSync(newAgentDir, () => {
			if (existsSync(newAgentDir)) return false;
			const sourceStats = lstatSync(oldAgentDir);
			if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink()) return false;
			const stagingDir = join(
				dirname(newAgentDir),
				`.${basename(newAgentDir)}.migration-${process.pid}-${randomUUID()}`,
			);
			try {
				cpSync(oldAgentDir, stagingDir, {
					recursive: true,
					errorOnExist: true,
					force: false,
					preserveTimestamps: true,
				});
				if (existsSync(newAgentDir)) return false;
				renameSync(stagingDir, newAgentDir);
				return true;
			} finally {
				rmSync(stagingDir, { recursive: true, force: true });
			}
		});
	} catch (err) {
		console.log(
			chalk.yellow(
				`Warning: Could not copy legacy ~/.pi/agent to ~/${configDirName}/agent: ${
					err instanceof Error ? err.message : err
				}`,
			),
		);
		return false;
	}
}

/**
 * Migrate legacy oauth.json and settings.json apiKeys to auth.json.
 *
 * @returns Array of provider names that were migrated
 */
export function migrateAuthToAuthJson(): string[] {
	const agentDir = getAgentDir();
	const authPath = join(agentDir, "auth.json");
	const oauthPath = join(agentDir, "oauth.json");
	const settingsPath = join(agentDir, "settings.json");

	// Skip if auth.json already exists
	if (existsSync(authPath)) return [];

	const migrated: Record<string, unknown> = {};
	const providers: string[] = [];
	let oauthWasRead = false;
	let settingsWithoutApiKeys: Record<string, unknown> | undefined;

	// Migrate oauth.json
	if (existsSync(oauthPath)) {
		try {
			const oauth = JSON.parse(
				secureReadFileSync(oauthPath, { maxBytes: LEGACY_JSON_STATE_MAX_BYTES }).toString("utf-8"),
			);
			for (const [provider, cred] of Object.entries(oauth)) {
				migrated[provider] = { type: "oauth", ...(cred as object) };
				providers.push(provider);
			}
			oauthWasRead = true;
		} catch {
			// Skip on error
		}
	}

	// Migrate settings.json apiKeys
	if (existsSync(settingsPath)) {
		try {
			const content = secureReadFileSync(settingsPath, { maxBytes: LEGACY_JSON_STATE_MAX_BYTES }).toString("utf-8");
			const settings = JSON.parse(content);
			if (settings.apiKeys && typeof settings.apiKeys === "object") {
				for (const [provider, key] of Object.entries(settings.apiKeys)) {
					if (!migrated[provider] && typeof key === "string") {
						migrated[provider] = { type: "api_key", key };
						providers.push(provider);
					}
				}
				delete settings.apiKeys;
				settingsWithoutApiKeys = settings;
			}
		} catch {
			// Skip on error
		}
	}

	if (Object.keys(migrated).length > 0) {
		secureAtomicWriteFileSync(authPath, `${JSON.stringify(migrated, null, 2)}\n`, {
			mode: 0o600,
			maxBytes: LEGACY_JSON_STATE_MAX_BYTES,
		});

		// Retire legacy sources only after auth.json is durable. Cleanup failures
		// leave duplicate credentials, never a credential-less installation.
		if (oauthWasRead) {
			try {
				renameSync(oauthPath, `${oauthPath}.migrated`);
			} catch {
				// The durable auth.json is authoritative; retrying cleanup is optional.
			}
		}
		if (settingsWithoutApiKeys) {
			try {
				secureAtomicWriteFileSync(settingsPath, `${JSON.stringify(settingsWithoutApiKeys, null, 2)}\n`, {
					mode: 0o600,
					maxBytes: LEGACY_JSON_STATE_MAX_BYTES,
				});
			} catch {
				// Preserve the legacy copy when it cannot be replaced safely.
			}
		}
	}

	return providers;
}

/**
 * Migrate sessions from ~/.pi/agent/*.jsonl to proper session directories.
 *
 * Bug in v0.30.0: Sessions were saved to ~/.pi/agent/ instead of
 * ~/.pi/agent/sessions/<encoded-cwd>/. This migration moves them
 * to the correct location based on the cwd in their session header.
 *
 * See: https://github.com/earendil-works/pi-mono/issues/320
 */
export function migrateSessionsFromAgentRoot(): void {
	const agentDir = getAgentDir();

	// Find all .jsonl files directly in agentDir (not in subdirectories)
	let files: string[];
	try {
		files = readdirSync(agentDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => join(agentDir, f));
	} catch {
		return;
	}

	if (files.length === 0) return;

	for (const file of files) {
		try {
			// Read first line to get session header
			const content = readFileSync(file, "utf8");
			const firstLine = content.split("\n")[0];
			if (!firstLine?.trim()) continue;

			const header = JSON.parse(firstLine);
			if (header.type !== "session" || !header.cwd) continue;

			const cwd: string = header.cwd;

			// Compute the correct session directory (same encoding as session-manager.ts)
			const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
			const correctDir = join(agentDir, "sessions", safePath);

			// Create directory if needed
			if (!existsSync(correctDir)) {
				mkdirSync(correctDir, { recursive: true });
			}

			// Move the file
			const fileName = file.split("/").pop() || file.split("\\").pop();
			const newPath = join(correctDir, fileName!);

			if (existsSync(newPath)) continue; // Skip if target exists

			renameSync(file, newPath);
		} catch {
			// Skip files that can't be migrated
		}
	}
}

/**
 * Migrate commands/ to prompts/ if needed.
 * Works for both regular directories and symlinks.
 */
function migrateCommandsToPrompts(baseDir: string, label: string): boolean {
	const commandsDir = join(baseDir, "commands");
	const promptsDir = join(baseDir, "prompts");

	if (existsSync(commandsDir) && !existsSync(promptsDir)) {
		try {
			renameSync(commandsDir, promptsDir);
			console.log(chalk.green(`Migrated ${label} commands/ → prompts/`));
			return true;
		} catch (err) {
			console.log(
				chalk.yellow(
					`Warning: Could not migrate ${label} commands/ to prompts/: ${err instanceof Error ? err.message : err}`,
				),
			);
		}
	}
	return false;
}

function migrateKeybindingsConfigFile(): void {
	const configPath = join(getAgentDir(), "keybindings.json");
	if (!existsSync(configPath)) return;

	try {
		const parsed = JSON.parse(
			secureReadFileSync(configPath, { maxBytes: LEGACY_JSON_STATE_MAX_BYTES }).toString("utf-8"),
		) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return;
		}
		const { config, migrated } = migrateKeybindingsConfig(parsed as Record<string, unknown>);
		if (!migrated) return;
		secureAtomicWriteFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
			mode: 0o600,
			maxBytes: LEGACY_JSON_STATE_MAX_BYTES,
		});
	} catch {
		// Ignore malformed files during migration
	}
}

/**
 * Move fd/rg binaries from tools/ to bin/ if they exist.
 */
function migrateToolsToBin(): void {
	const agentDir = getAgentDir();
	const toolsDir = join(agentDir, "tools");
	const binDir = getBinDir();

	if (!existsSync(toolsDir)) return;

	const binaries = ["fd", "rg", "fd.exe", "rg.exe"];
	let movedAny = false;

	for (const bin of binaries) {
		const oldPath = join(toolsDir, bin);
		const newPath = join(binDir, bin);

		if (existsSync(oldPath)) {
			if (!existsSync(binDir)) {
				mkdirSync(binDir, { recursive: true });
			}
			if (!existsSync(newPath)) {
				try {
					renameSync(oldPath, newPath);
					movedAny = true;
				} catch {
					// Ignore errors
				}
			} else {
				// Target exists, just delete the old one
				try {
					rmSync?.(oldPath, { force: true });
				} catch {
					// Ignore
				}
			}
		}
	}

	if (movedAny) {
		console.log(chalk.green(`Migrated managed binaries tools/ → bin/`));
	}
}

function migrateLegacyPeerMessageStore(): void {
	// An explicit mailbox path is an ownership boundary, not a request to import
	// state from the default branded directory.
	if (process.env[ENV_PEER_MESSAGE_DB]) return;
	try {
		migrateLegacyMessageStore(join(getAgentDir(), "messages.db"), getPeerMessageDbPath());
	} catch {
		// A damaged, locked, or conflicting legacy store must not block startup.
		// The source remains untouched so a later run or manual repair can retry.
	}
}

const PRESENCE_SESSION_HEADER_BYTES = 64 * 1024;

type PresenceMaintenanceOptions = {
	/** Optional project-specific Session directory selected by the CLI. */
	sessionDir?: string;
	/** Optional retention override used by tests and controlled maintenance jobs. */
	retentionMs?: number;
	/** Test/maintenance clock override. */
	nowMs?: number;
};

/**
 * Read only the first JSONL record needed to prove a persisted Session id.
 * Session files are append-only and can be arbitrarily large; a full read here
 * would turn every startup into an unbounded disk scan. A long or malformed
 * header is treated as an unsafe scan and aborts GC for this startup.
 */
function readSessionHeaderId(filePath: string): string | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(filePath, "r");
		const buffer = Buffer.allocUnsafe(PRESENCE_SESSION_HEADER_BYTES);
		const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
		const text = buffer.subarray(0, bytesRead).toString("utf8");
		const newline = text.indexOf("\n");
		if (newline < 0 && bytesRead === buffer.length) return undefined;
		const firstLine = (newline < 0 ? text : text.slice(0, newline)).replace(/\r$/, "").trim();
		if (!firstLine) return undefined;
		const parsed = JSON.parse(firstLine) as { type?: unknown; id?: unknown };
		if (parsed.type !== "session" || typeof parsed.id !== "string" || parsed.id.length === 0) return undefined;
		return parsed.id;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// A failed close is still an unsafe scan; the caller already skips GC.
			}
		}
	}
}

/** Collect valid Session ids from one root without following symlinks. */
function collectSessionIds(root: string): Set<string> | undefined {
	const ids = new Set<string>();
	const visit = (directory: string, depth: number): boolean => {
		let directoryStat: ReturnType<typeof lstatSync>;
		try {
			directoryStat = lstatSync(directory);
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ENOENT";
		}
		if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) return false;
		let entries: Dirent[];
		try {
			entries = readdirSync(directory, { withFileTypes: true });
		} catch {
			return false;
		}
		for (const entry of entries) {
			const entryPath = join(directory, entry.name);
			if (entry.isSymbolicLink()) return false;
			if (entry.isDirectory()) {
				// The shipped layout is root/<encoded-cwd>/*.jsonl. A bounded
				// depth still handles custom nested layouts without following an
				// accidental recursive tree forever.
				if (depth >= 3 || !visit(entryPath, depth + 1)) return false;
				continue;
			}
			if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
			const id = readSessionHeaderId(entryPath);
			if (!id) return false;
			ids.add(id);
		}
		return true;
	};
	return visit(root, 0) ? ids : undefined;
}

/** Read registry references through the durable registry parser, failing closed on any bad file. */
function collectRegistrySessionIds(agentDir: string): Set<string> | undefined {
	const registryDir = join(agentDir, "multiagent");
	let directoryStat: ReturnType<typeof lstatSync>;
	try {
		directoryStat = lstatSync(registryDir);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? new Set<string>() : undefined;
	}
	if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) return undefined;
	let entries: Dirent[];
	try {
		entries = readdirSync(registryDir, { withFileTypes: true });
	} catch {
		return undefined;
	}
	const ids = new Set<string>();
	for (const entry of entries) {
		if (!entry.name.endsWith(".json")) continue;
		if (entry.isSymbolicLink() || !entry.isFile()) return undefined;
		const path = join(registryDir, entry.name);
		try {
			const raw = JSON.parse(readFileSync(path, "utf8")) as {
				schemaVersion?: unknown;
				parentSessionId?: unknown;
			};
			if (raw.schemaVersion !== 1 || typeof raw.parentSessionId !== "string" || raw.parentSessionId.length === 0) {
				return undefined;
			}
			const registry = new DurableMultiagentRegistry(path, raw.parentSessionId);
			for (const record of registry.list()) ids.add(record.sessionId);
		} catch {
			return undefined;
		}
	}
	return ids;
}

function collectPersistedSessionIds(options: PresenceMaintenanceOptions): Set<string> | undefined {
	const roots = new Set([getSessionsDir(), options.sessionDir].filter((value): value is string => Boolean(value)));
	const sessionIds = new Set<string>();
	for (const root of roots) {
		const ids = collectSessionIds(root);
		if (ids === undefined) return undefined;
		for (const id of ids) sessionIds.add(id);
	}
	return sessionIds;
}

/**
 * Run one conservative orphan-presence pass after startup paths are known.
 * Scanning is read-only and happens once; a missing or malformed Session or
 * registry tree returns zero without opening the mailbox for mutation.
 */
export function runPresenceOrphanMaintenance(options: PresenceMaintenanceOptions = {}): number {
	const sessionIds = collectPersistedSessionIds(options);
	if (sessionIds === undefined) return 0;
	return purgeOrphanPresence(sessionIds, options);
}

function purgeOrphanPresence(sessionIds: Set<string>, options: PresenceMaintenanceOptions): number {
	const registryIds = collectRegistrySessionIds(getAgentDir());
	if (registryIds === undefined) return 0;
	let store: MessageStore | undefined;
	try {
		store = new MessageStore(getPeerMessageDbPath());
		return store.purgeOrphanPresence({
			sessionIds,
			registrySessionIds: registryIds,
			retentionMs: options.retentionMs,
			nowMs: options.nowMs,
		});
	} catch {
		return 0;
	} finally {
		store?.close();
	}
}

/** Remove only old, strictly empty registries after a complete Session scan. */
export async function runEmptyRegistryOrphanMaintenance(options: PresenceMaintenanceOptions = {}): Promise<number> {
	const sessionIds = collectPersistedSessionIds(options);
	if (sessionIds === undefined) return 0;
	return cleanupEmptyRegistries(sessionIds, options);
}

async function cleanupEmptyRegistries(sessionIds: Set<string>, options: PresenceMaintenanceOptions): Promise<number> {
	try {
		const result = await cleanupEmptyOrphanMultiagentRegistries({
			registryDir: join(getAgentDir(), "multiagent"),
			liveParentSessionIds: sessionIds,
			maxAgeMs: options.retentionMs,
			now: options.nowMs,
		});
		return result.deletedFiles;
	} catch {
		return 0;
	}
}

/** Run one startup scan and share its proven Session set across both GC passes. */
export async function runStartupOrphanMaintenance(
	options: PresenceMaintenanceOptions = {},
): Promise<{ deletedPresence: number; deletedRegistries: number }> {
	const sessionIds = collectPersistedSessionIds(options);
	if (sessionIds === undefined) return { deletedPresence: 0, deletedRegistries: 0 };
	const deletedPresence = purgeOrphanPresence(sessionIds, options);
	const deletedRegistries = await cleanupEmptyRegistries(sessionIds, options);
	return { deletedPresence, deletedRegistries };
}

/**
 * Check for deprecated hooks/ and tools/ directories.
 * Note: tools/ may contain fd/rg binaries extracted by pi, so only warn if it has other files.
 */
function checkDeprecatedExtensionDirs(baseDir: string, label: string): string[] {
	const hooksDir = join(baseDir, "hooks");
	const toolsDir = join(baseDir, "tools");
	const warnings: string[] = [];

	if (existsSync(hooksDir)) {
		warnings.push(`${label} hooks/ directory found. Hooks have been renamed to extensions.`);
	}

	if (existsSync(toolsDir)) {
		// Check if tools/ contains anything other than fd/rg (which are auto-extracted binaries)
		try {
			const entries = readdirSync(toolsDir);
			const customTools = entries.filter((e) => {
				const lower = e.toLowerCase();
				return (
					lower !== "fd" && lower !== "rg" && lower !== "fd.exe" && lower !== "rg.exe" && !e.startsWith(".") // Ignore .DS_Store and other hidden files
				);
			});
			if (customTools.length > 0) {
				warnings.push(
					`${label} tools/ directory contains custom tools. Custom tools have been merged into extensions.`,
				);
			}
		} catch {
			// Ignore read errors
		}
	}

	return warnings;
}

/**
 * Run extension system migrations (commands→prompts) and collect warnings about deprecated directories.
 */
function migrateExtensionSystem(cwd: string): string[] {
	const agentDir = getAgentDir();
	const projectDir = join(cwd, CONFIG_DIR_NAME);

	// Migrate commands/ to prompts/
	migrateCommandsToPrompts(agentDir, "Global");
	migrateCommandsToPrompts(projectDir, "Project");

	// Check for deprecated directories
	const warnings = [
		...checkDeprecatedExtensionDirs(agentDir, "Global"),
		...checkDeprecatedExtensionDirs(projectDir, "Project"),
	];

	return warnings;
}

/**
 * Print deprecation warnings and wait for keypress.
 */
export async function showDeprecationWarnings(warnings: string[]): Promise<void> {
	if (warnings.length === 0) return;

	for (const warning of warnings) {
		console.log(chalk.yellow(`Warning: ${warning}`));
	}
	console.log(chalk.yellow(`\nMove your extensions to the extensions/ directory.`));
	console.log(chalk.yellow(`Migration guide: ${MIGRATION_GUIDE_URL}`));
	console.log(chalk.yellow(`Documentation: ${EXTENSIONS_DOC_URL}`));
	console.log(chalk.dim(`\nPress any key to continue...`));

	await new Promise<void>((resolve) => {
		process.stdin.setRawMode?.(true);
		process.stdin.resume();
		process.stdin.once("data", () => {
			process.stdin.setRawMode?.(false);
			process.stdin.pause();
			resolve();
		});
	});
	console.log();
}

/**
 * Run all migrations. Called once on startup.
 *
 * @returns Object with migration results and deprecation warnings
 */
export function runMigrations(cwd: string): {
	migratedAuthProviders: string[];
	deprecationWarnings: string[];
} {
	migrateLegacyPiAgentDirToCurrentConfigDir();
	const migratedAuthProviders = migrateAuthToAuthJson();
	migrateSessionsFromAgentRoot();
	migrateToolsToBin();
	migrateLegacyPeerMessageStore();
	migrateKeybindingsConfigFile();
	const deprecationWarnings = migrateExtensionSystem(cwd);
	return { migratedAuthProviders, deprecationWarnings };
}
