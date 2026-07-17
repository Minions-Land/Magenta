import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKIPPED_DIRECTORIES = new Set([".git", ".magenta", "build", "coverage", "dist", "node_modules"]);
const TEST_DIRECTORY_NAMES = new Set(["__tests__", "test", "tests"]);
const TYPESCRIPT_EXTENSION = /\.(?:[cm]?ts|tsx)$/u;
const TEST_FILE_SUFFIX = /\.(?:test|spec)\.(?:[cm]?ts|tsx)$/u;

const REAL_HOME_CREDENTIAL_PATTERNS = [
	{
		name: "an OS home-directory helper in a file that references auth.json",
		pattern:
			/(?:["'](?:node:)?os["'][\s\S]*?\b(?:homedir|userInfo)\b|\b(?:homedir|userInfo)\b[\s\S]*?["'](?:node:)?os["']|\b(?:homedir|userInfo)\s*\([^)]*\))/iu,
		requiresAuthJson: true,
	},
	{
		name: "a HOME or USERPROFILE path in a file that references auth.json",
		pattern:
			/(?:process\.)?env(?:\[\s*["'](?:HOME|USERPROFILE)["']\s*\]|\.(?:HOME|USERPROFILE))|\$(?:HOME|USERPROFILE)/iu,
		requiresAuthJson: true,
	},
	{
		name: "a literal real-home auth.json path",
		pattern: /~[\\/]\.(?:magenta|pi)[\\/](?:agent[\\/])?auth\.json/iu,
		requiresAuthJson: false,
	},
];

export function findRealHomeCredentialPatterns(source) {
	const findings = [];
	for (const { name, pattern, requiresAuthJson } of REAL_HOME_CREDENTIAL_PATTERNS) {
		if (requiresAuthJson && !/auth\.json/iu.test(source)) continue;
		const match = pattern.exec(source);
		if (!match) continue;
		findings.push({
			line: source.slice(0, match.index).split("\n").length,
			message: name,
		});
	}
	return findings;
}

function isTestTypeScript(relativePath) {
	if (!TYPESCRIPT_EXTENSION.test(relativePath)) return false;
	if (TEST_FILE_SUFFIX.test(relativePath)) return true;
	return relativePath.split(sep).some((segment) => TEST_DIRECTORY_NAMES.has(segment));
}

async function scanDirectory(root, directory = root) {
	const findings = [];
	const entries = await readdir(directory, { withFileTypes: true });
	for (const entry of entries) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (!SKIPPED_DIRECTORIES.has(entry.name)) findings.push(...(await scanDirectory(root, path)));
			continue;
		}
		if (!entry.isFile()) continue;
		const relativePath = relative(root, path);
		if (!isTestTypeScript(relativePath)) continue;
		const source = await readFile(path, "utf8");
		for (const finding of findRealHomeCredentialPatterns(source)) {
			findings.push(`${relativePath}:${finding.line}: ${finding.message}`);
		}
	}
	return findings;
}

test("scanner rejects real-home auth.json access patterns", () => {
	const source = [
		'import { homedir as getHome } from "node:os";',
		'import { writeFileSync } from "node:fs";',
		'const authPath = join(getHome(), ".magenta", "agent", "auth.json");',
		'writeFileSync(authPath, "fixture-credential");',
	].join("\n");
	assert.notDeepEqual(findRealHomeCredentialPatterns(source), []);
	assert.notDeepEqual(
		findRealHomeCredentialPatterns('readFileSync(join(process.env.HOME, ".pi", "agent", "auth.json"));'),
		[],
	);
});

test("scanner allows environment credentials and isolated auth fixtures", () => {
	const source = [
		"const token = process.env.ANTHROPIC_OAUTH_TOKEN;",
		'const authPath = join(tmpdir(), "test-run", "auth.json");',
		"const storage = AuthStorage.create(authPath);",
	].join("\n");
	assert.deepEqual(findRealHomeCredentialPatterns(source), []);
});

test("repository tests do not access persistent real-home credentials", async () => {
	const findings = await scanDirectory(REPOSITORY_ROOT);
	assert.deepEqual(
		findings,
		[],
		`Test code must use environment variables or isolated temporary credentials:\n${findings.join("\n")}`,
	);
});
