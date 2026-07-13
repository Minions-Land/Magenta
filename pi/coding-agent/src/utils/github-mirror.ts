/**
 * GitHub mirror/proxy support for downloads in restricted network environments.
 *
 * Set MAGENTA_GITHUB_MIRROR to a proxy URL prefix (e.g., https://ghproxy.net)
 * to rewrite all GitHub URLs through that mirror. When unset, URLs are returned
 * unchanged.
 *
 * Examples:
 *   MAGENTA_GITHUB_MIRROR=https://ghproxy.net
 *   → https://github.com/... becomes https://ghproxy.net/https://github.com/...
 *   → https://api.github.com/... becomes https://ghproxy.net/https://api.github.com/...
 */

const GITHUB_MIRROR_ENV = "MAGENTA_GITHUB_MIRROR";

let cachedMirrorPrefix: string | null | undefined;

/**
 * Get the configured GitHub mirror prefix, if any.
 * Returns null when no mirror is configured.
 * Trailing slashes are normalized away.
 */
function getGitHubMirrorPrefix(): string | null {
	if (cachedMirrorPrefix !== undefined) {
		return cachedMirrorPrefix;
	}

	const mirror = process.env[GITHUB_MIRROR_ENV];
	if (!mirror || mirror.trim() === "") {
		cachedMirrorPrefix = null;
		return null;
	}

	// Normalize: remove trailing slashes
	cachedMirrorPrefix = mirror.replace(/\/+$/, "");
	return cachedMirrorPrefix;
}

/**
 * Resolve a GitHub URL, optionally rewriting it through the configured mirror.
 *
 * When MAGENTA_GITHUB_MIRROR is unset, returns the original URL unchanged.
 * When set, prepends the mirror prefix: `${mirror}/${originalUrl}`.
 *
 * @param url - Original GitHub URL (api.github.com or github.com)
 * @returns Resolved URL (original or mirrored)
 */
export function resolveGitHubUrl(url: string): string {
	const mirror = getGitHubMirrorPrefix();
	if (!mirror) {
		return url;
	}
	return `${mirror}/${url}`;
}

/**
 * Clear the cached mirror prefix (for testing).
 * @internal
 */
export function _clearMirrorCache(): void {
	cachedMirrorPrefix = undefined;
}
