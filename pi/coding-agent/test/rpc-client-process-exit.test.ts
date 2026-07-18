import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

const tempDirs: string[] = [];

function writeChildScript(contents: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-rpc-client-exit-"));
	tempDirs.push(dir);
	const path = join(dir, "child.mjs");
	writeFileSync(path, contents);
	return path;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("RpcClient child process failures", () => {
	test("rejects an in-flight request when the child process exits", async () => {
		const client = new RpcClient({
			cliPath: writeChildScript(`
process.stdin.once("data", () => {
	process.exit(43);
});
process.stdin.resume();
`),
			readyTimeoutMs: 100,
		});

		await client.start();

		await expect(client.getCommands()).rejects.toThrow(/Agent process exited \(code=43 signal=null\)/);
	});

	test("uses the graceful shutdown command before falling back to signals", async () => {
		const childScript = writeChildScript("");
		const markerPath = `${childScript}.shutdown`;
		writeFileSync(
			childScript,
			`import { writeFileSync } from "node:fs";
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	while (buffer.includes("\\n")) {
		const newline = buffer.indexOf("\\n");
		const line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		if (!line) continue;
		const command = JSON.parse(line);
		if (command.type === "shutdown") {
			writeFileSync(${JSON.stringify(markerPath)}, "shutdown");
			process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: "shutdown", success: true }) + "\\n");
			setTimeout(() => process.exit(0), 10);
		}
	}
});
process.stdin.resume();
`,
		);
		const client = new RpcClient({ cliPath: childScript, readyTimeoutMs: 100 });

		await client.start();
		await client.stop();

		expect(existsSync(markerPath)).toBe(true);
	});

	test("waits for runtime_manifest before start() resolves, or times out gracefully", async () => {
		const childScript = writeChildScript("");
		writeFileSync(
			childScript,
			`setTimeout(() => {
	process.stdout.write(JSON.stringify({ type: "runtime_manifest", protocolVersion: 1 }) + "\\n");
}, 50);
process.stdin.on("data", () => process.exit(0));
process.stdin.resume();
`,
		);
		const client = new RpcClient({ cliPath: childScript, readyTimeoutMs: 200 });

		const start = Date.now();
		await client.start();
		const elapsed = Date.now() - start;

		expect(elapsed).toBeGreaterThanOrEqual(50);
		// Process startup is contended in the full parallel suite; this remains a
		// bounded readiness check rather than a scheduler-latency assertion.
		expect(elapsed).toBeLessThan(1000);
		await client.stop();
	});

	test("sendExtensionUIResponse writes to stdin without awaiting acknowledgment", async () => {
		const childScript = writeChildScript("");
		const outputPath = `${childScript}.received`;
		writeFileSync(
			childScript,
			`import { writeFileSync, appendFileSync } from "node:fs";
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	while (buffer.includes("\\n")) {
		const newline = buffer.indexOf("\\n");
		const line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		if (!line) continue;
		const parsed = JSON.parse(line);
		if (parsed.type === "shutdown") {
			process.stdout.write(JSON.stringify({ id: parsed.id, type: "response", command: "shutdown", success: true }) + "\\n");
			setTimeout(() => process.exit(0), 10);
			continue;
		}
		appendFileSync(${JSON.stringify(outputPath)}, line + "\\n");
	}
});
setTimeout(() => {
	process.stdout.write(JSON.stringify({ type: "runtime_manifest", protocolVersion: 1 }) + "\\n");
}, 10);
process.stdin.resume();
`,
		);
		const client = new RpcClient({ cliPath: childScript });

		await client.start();
		client.sendExtensionUIResponse({ type: "extension_ui_response", id: "ui-123", confirmed: true });
		await new Promise((resolve) => setTimeout(resolve, 50));
		await client.stop();

		const received = readFileSync(outputPath, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		expect(received).toContainEqual({ type: "extension_ui_response", id: "ui-123", confirmed: true });
	});
});
