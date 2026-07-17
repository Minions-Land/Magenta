import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SESSION_FIXTURE_DIRECTORY = join(REPOSITORY_ROOT, "pi/coding-agent/test/fixtures");

const CREDENTIAL_FIELDS = new Set([
	"accesstoken",
	"apikey",
	"auth",
	"authentication",
	"authorization",
	"credentials",
	"idtoken",
	"oauthtoken",
	"password",
	"refreshtoken",
	"secret",
	"token",
]);

const FORBIDDEN_STRING_PATTERNS = [
	{ label: "macOS home path", pattern: /\/Users\//u },
	{
		label: "home configuration path",
		pattern: /(?:~[\\/]|(?:\/home\/[^/\s]+|\/root|[A-Za-z]:\\Users\\[^\\\s]+)[\\/])\.(?:pi|magenta)(?:[\\/]|$)/iu,
	},
	{ label: "thinking signature", pattern: /thinkingSignature/iu },
	{ label: "captured upstream identity", pattern: /(?:badlogic|mariozechner|pi-mono)/iu },
	{ label: "captured tool identifier", pattern: /toolu_[A-Za-z0-9]+/u },
	{ label: "captured stack trace", pattern: /(?:^|\n)\s*at\s+(?:async\s+)?[\w.[\]<>]+\s*\(/u },
	{ label: "push or publish command", pattern: /\b(?:git\s+push|(?:npm|pnpm|yarn)\s+publish)\b/iu },
];

function normalizedFieldName(field) {
	return field.replaceAll(/[^a-z0-9]/giu, "").toLowerCase();
}

function inspectValue(value, location, violations) {
	if (typeof value === "string") {
		for (const { label, pattern } of FORBIDDEN_STRING_PATTERNS) {
			if (pattern.test(value)) violations.push(`${location}: ${label}`);
		}
		return;
	}
	if (Array.isArray(value)) {
		value.forEach((item, index) => inspectValue(item, `${location}[${index}]`, violations));
		return;
	}
	if (value === null || typeof value !== "object") return;

	for (const [field, child] of Object.entries(value)) {
		const normalized = normalizedFieldName(field);
		if (normalized === "thinkingsignature") {
			violations.push(`${location}.${field}: thinking signature field`);
		} else if (CREDENTIAL_FIELDS.has(normalized)) {
			violations.push(`${location}.${field}: credential field`);
		}
		inspectValue(child, `${location}.${field}`, violations);
	}
}

export function checkSessionFixture(content, source = "<fixture>") {
	const violations = [];
	for (const [index, line] of content.split(/\r?\n/u).entries()) {
		if (!line.trim()) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			violations.push(`${source}:${index + 1}: invalid JSON`);
			continue;
		}
		inspectValue(entry, `${source}:${index + 1}`, violations);
	}
	return violations;
}

test("coding-agent JSONL fixtures contain no captured transcript data", () => {
	const fixtureNames = readdirSync(SESSION_FIXTURE_DIRECTORY)
		.filter((name) => name.endsWith(".jsonl"))
		.sort();
	assert.ok(fixtureNames.length > 0, "expected at least one coding-agent JSONL fixture");

	const violations = fixtureNames.flatMap((name) => {
		const path = join(SESSION_FIXTURE_DIRECTORY, name);
		return checkSessionFixture(readFileSync(path, "utf8"), name);
	});
	assert.deepEqual(violations, []);
});

test("fixture guard rejects paths, secrets, signatures, and captured markers", () => {
	const unsafeEntries = [
		{ type: "session", cwd: "/Users/example/work/project", apiKey: "synthetic-secret" },
		{ type: "message", message: { role: "user", content: "Read ~/.magenta/config.json" } },
		{ type: "message", message: { role: "assistant", thinkingSignature: "opaque" } },
		{ type: "message", message: { role: "toolResult", content: "at syntheticCall (/tmp/tool.js:1:1)" } },
		{ type: "message", message: { role: "user", content: "Captured from badlogic/pi-mono" } },
		{ type: "message", message: { role: "assistant", content: "Run git push origin main" } },
	];
	const violations = checkSessionFixture(unsafeEntries.map((entry) => JSON.stringify(entry)).join("\n"));
	const report = violations.join("\n");

	assert.match(report, /macOS home path/u);
	assert.match(report, /home configuration path/u);
	assert.match(report, /credential field/u);
	assert.match(report, /thinking signature field/u);
	assert.match(report, /captured stack trace/u);
	assert.match(report, /captured upstream identity/u);
	assert.match(report, /push or publish command/u);
});

test("fixture guard allows legitimate synthetic usage metadata", () => {
	const fixture = [
		{
			type: "session",
			id: "00000000-0000-4000-8000-000000000001",
			cwd: "/workspace/synthetic-project",
		},
		{
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Synthetic token accounting metadata." }],
				usage: { input: 100, output: 25, cacheRead: 10, cacheWrite: 0, totalTokens: 135 },
			},
		},
		{ type: "compaction", tokensBefore: 90000, summary: "Synthetic summary." },
	];

	assert.deepEqual(checkSessionFixture(fixture.map((entry) => JSON.stringify(entry)).join("\n")), []);
});
