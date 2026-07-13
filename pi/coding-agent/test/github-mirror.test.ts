import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _clearMirrorCache, resolveGitHubUrl } from "../src/utils/github-mirror.ts";

const ENV_KEY = "MAGENTA_GITHUB_MIRROR";

describe("resolveGitHubUrl", () => {
	const original = process.env[ENV_KEY];

	beforeEach(() => {
		delete process.env[ENV_KEY];
		_clearMirrorCache();
	});

	afterEach(() => {
		if (original === undefined) {
			delete process.env[ENV_KEY];
		} else {
			process.env[ENV_KEY] = original;
		}
		_clearMirrorCache();
	});

	it("returns the URL unchanged when no mirror is configured", () => {
		const url = "https://github.com/owner/repo/releases/download/v1.0.0/asset.tar.gz";
		expect(resolveGitHubUrl(url)).toBe(url);
	});

	it("treats an empty/whitespace mirror as unset", () => {
		process.env[ENV_KEY] = "   ";
		_clearMirrorCache();
		const url = "https://api.github.com/repos/owner/repo/releases/latest";
		expect(resolveGitHubUrl(url)).toBe(url);
	});

	it("prepends the mirror prefix to github.com download URLs", () => {
		process.env[ENV_KEY] = "https://ghproxy.net";
		_clearMirrorCache();
		const url = "https://github.com/owner/repo/releases/download/v1.0.0/asset.tar.gz";
		expect(resolveGitHubUrl(url)).toBe(`https://ghproxy.net/${url}`);
	});

	it("prepends the mirror prefix to api.github.com URLs", () => {
		process.env[ENV_KEY] = "https://ghproxy.net";
		_clearMirrorCache();
		const url = "https://api.github.com/repos/owner/repo/releases/latest";
		expect(resolveGitHubUrl(url)).toBe(`https://ghproxy.net/${url}`);
	});

	it("normalizes trailing slashes on the mirror prefix", () => {
		process.env[ENV_KEY] = "https://ghproxy.net///";
		_clearMirrorCache();
		const url = "https://github.com/owner/repo/archive.tar.gz";
		expect(resolveGitHubUrl(url)).toBe(`https://ghproxy.net/${url}`);
	});
});
