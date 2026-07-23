import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { ensureSecureExecutableCacheDirectory } from "./atomic-executable.ts";

let configuredCacheRoot: string | undefined;

/** Bind embedded helper materialization to the host application's configured state root. */
export function configureEmbeddedHelperCacheRoot(cacheRoot: string): void {
	const normalized = resolve(cacheRoot);
	if (!isAbsolute(cacheRoot) || normalized !== cacheRoot) {
		throw new Error("Embedded helper cache root must be an absolute normalized path");
	}
	configuredCacheRoot = normalized;
}

/** Create and bind a private helper cache below an existing owner-controlled root. */
export function prepareEmbeddedHelperCacheRoot(cacheRoot: string, trustedRoot: string): void {
	const normalizedCacheRoot = resolve(cacheRoot);
	const normalizedTrustedRoot = resolve(trustedRoot);
	if (!isAbsolute(cacheRoot) || normalizedCacheRoot !== cacheRoot) {
		throw new Error("Embedded helper cache root must be an absolute normalized path");
	}
	if (!isAbsolute(trustedRoot) || normalizedTrustedRoot !== trustedRoot) {
		throw new Error("Embedded helper trusted root must be an absolute normalized path");
	}
	ensureSecureExecutableCacheDirectory(normalizedCacheRoot, normalizedTrustedRoot);
	configuredCacheRoot = normalizedCacheRoot;
}

export function getEmbeddedHelperCacheRoot(): string {
	return configuredCacheRoot ?? join(homedir(), ".magenta", "cache");
}

export function getEmbeddedHelperTrustedRoot(): string {
	return dirname(getEmbeddedHelperCacheRoot());
}
