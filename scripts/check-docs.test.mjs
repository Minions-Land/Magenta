import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkDocs, githubSlug, scanMarkdown } from "./check-docs.mjs";

async function fixture(files) {
	const parent = await mkdtemp(join(tmpdir(), "magenta-docs-check-"));
	const root = join(parent, "repo");
	await mkdir(root);
	await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { build: "true" } }));
	for (const [path, content] of Object.entries(files)) {
		const target = join(root, path);
		await mkdir(join(target, ".."), { recursive: true });
		await writeFile(target, content);
	}
	return {
		parent,
		root,
		async cleanup() {
			await rm(parent, { force: true, recursive: true });
		},
	};
}

test("GitHub-style slugs remove punctuation and suffix duplicates", () => {
	assert.equal(githubSlug("Hello, `world`!"), "hello-world");
	const { anchors } = scanMarkdown("# Hello, world!\n\n# Hello, world!\n");
	assert.deepEqual([...anchors], ["hello-world", "hello-world-1"]);
});

test("validates file, fragment, directory, reference, and current asset links", async () => {
	const env = await fixture({
		"docs/README.md": [
			"# Guide",
			"",
			"[Details](./details.md#hello-world)",
			"[Duplicate](./details.md#hello-world-1)",
			"[Directory](./area#area)",
			"[External](https://example.com/path#missing)",
			"[Reference][details]",
			"[details]: ./details.md",
			"",
			"```mermaid",
			"flowchart LR",
			"  A --> B",
			"```",
			"",
			"Current assets: magenta-macos-arm64, magenta-linux-x64, magenta-windows-x64.exe.",
		].join("\n"),
		"docs/details.md": "# Hello, world!\n\n# Hello, world!\n",
		"docs/area/README.md": "# Area\n",
	});
	try {
		const result = await checkDocs(env.root, { entries: ["docs"] });
		assert.deepEqual(result.errors, []);
	} finally {
		await env.cleanup();
	}
});

test("reports missing files and Markdown anchors", async () => {
	const env = await fixture({
		"docs/README.md": "# Guide\n\n[Missing](./missing.md)\n[Anchor](./target.md#absent)\n",
		"docs/target.md": "# Present\n",
	});
	try {
		const result = await checkDocs(env.root, { entries: ["docs"] });
		assert.deepEqual(
			result.errors.map((error) => error.code),
			["link", "link"],
		);
	} finally {
		await env.cleanup();
	}
});

test("rejects repository-escaping local links", async () => {
	const env = await fixture({ "docs/README.md": "# Guide\n\n[Outside](../../outside.md)\n" });
	await writeFile(join(env.parent, "outside.md"), "# Outside\n");
	try {
		const result = await checkDocs(env.root, { entries: ["docs"] });
		assert.equal(result.errors[0]?.code, "link");
		assert.match(result.errors[0]?.message ?? "", /escapes the repository/u);
	} finally {
		await env.cleanup();
	}
});

test("reports an unterminated Mermaid fence but ignores links inside code", async () => {
	const env = await fixture({
		"docs/README.md": "# Guide\n\n```mermaid\nflowchart LR\n  A[\"[not a link](missing.md)\"] --> B\n",
	});
	try {
		const result = await checkDocs(env.root, { entries: ["docs"] });
		assert.deepEqual(result.errors.map((error) => error.code), ["mermaid-fence"]);
	} finally {
		await env.cleanup();
	}
});

test("rejects deleted docs, placeholders, old assets, versions, sizes, and unknown npm scripts", async () => {
	const env = await fixture({
		"docs/README.md": [
			"# Guide",
			"See FINAL_ANSWER.md at https://github.com/yourusername/repo.",
			"Download magenta-resources.tar.gz for v1.2.3; the binary is 73MB.",
			"Run `npm run imaginary`.",
		].join("\n"),
	});
	try {
		const result = await checkDocs(env.root, { entries: ["docs"] });
		assert.deepEqual(
			new Set(result.errors.map((error) => error.code)),
			new Set(["deleted-doc", "placeholder", "legacy-asset", "hardcoded-version", "binary-size", "npm-script"]),
		);
	} finally {
		await env.cleanup();
	}
});
