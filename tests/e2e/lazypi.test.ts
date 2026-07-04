import { expect, test } from "@playwright/test";
import { exec } from "child_process";
import { dirname, join } from "path";
import { promisify } from "util";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const execAsync = promisify(exec);
const repoRoot = join(__dirname, "../..");

async function pathExists(path: string): Promise<boolean> {
	const { stdout } = await execAsync(`[ -e "${path}" ] && echo EXISTS || echo NONE`);
	return stdout.trim() === "EXISTS";
}

test.describe("Extension Retirement", () => {
	test("removes the bundled harness extension registry", async () => {
		expect(await pathExists(join(repoRoot, "harness/extensions"))).toBe(false);
	});

	test("keeps migrated Pi UX features in Pi core/TUI", async () => {
		const expectedPaths = [
			"pi/coding-agent/src/core/background-events.ts",
			"pi/coding-agent/src/core/side-chat.ts",
			"pi/coding-agent/src/core/image-tokens.ts",
			"pi/coding-agent/src/core/command-aliases.ts",
			"pi/coding-agent/src/modes/interactive/components/events-overlay.ts",
			"pi/coding-agent/src/modes/interactive/components/side-chat-overlay.ts",
			"pi/coding-agent/src/modes/interactive/components/tool-execution-group.ts",
		];

		for (const relativePath of expectedPaths) {
			expect(await pathExists(join(repoRoot, relativePath)), relativePath).toBe(true);
		}
	});

	test("keeps reusable tools in Harness tools", async () => {
		const expectedPaths = [
			"harness/tools/todo/todo.toml",
			"harness/tools/todo/pi/todo.ts",
			"harness/tools/ssh/ssh.toml",
			"harness/tools/ssh/magenta/ssh.ts",
		];

		for (const relativePath of expectedPaths) {
			expect(await pathExists(join(repoRoot, relativePath)), relativePath).toBe(true);
		}
	});

	test("does not keep retired built-in extensions in source", async () => {
		const retiredNames = [
			"background-events",
			"command-aliases.ts",
			"local-credential-bridge.ts",
			"side-chat.ts",
			"ssh.ts",
			"todo.ts",
			"ui-optimize",
		];

		for (const name of retiredNames) {
			const { stdout } = await execAsync(`find "${join(repoRoot, "harness")}" -path "*/extensions/*" -name "${name}" 2>/dev/null || true`);
			expect(stdout.trim(), name).toBe("");
		}
	});
});
