import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { HcpClientbuildsession, type SshToolOperations } from "@magenta/harness";
import { afterEach, describe, expect, it } from "vitest";
import { processFileArguments } from "../src/cli/file-processor.ts";
import { HcpClientassembletools } from "../src/core/HcpClienttools.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

function createTinyBmp1x1Red24bpp(): Buffer {
	const buffer = Buffer.alloc(58);
	buffer.write("BM", 0, "ascii");
	buffer.writeUInt32LE(buffer.length, 2);
	buffer.writeUInt32LE(54, 10);
	buffer.writeUInt32LE(40, 14);
	buffer.writeInt32LE(1, 18);
	buffer.writeInt32LE(1, 22);
	buffer.writeUInt16LE(1, 26);
	buffer.writeUInt16LE(24, 28);
	buffer.writeUInt32LE(4, 34);
	buffer[56] = 0xff;
	return buffer;
}

function expectPng(data: string): void {
	expect(Buffer.from(data, "base64").subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
}

function createSshOperations(files: Map<string, Buffer>): SshToolOperations {
	return {
		read: {
			access: async () => {},
			readFile: async (path) => files.get(path) ?? Buffer.from("missing"),
			// Current SSH file detection filters image/bmp to null; the coding layer
			// must recover it from the remote byte abstraction.
			detectImageMimeType: async () => null,
		},
		bash: { exec: async () => ({ exitCode: 0 }) },
		edit: {
			access: async () => {},
			readFile: async () => Buffer.alloc(0),
			writeFile: async () => {},
		},
		write: { mkdir: async () => {}, writeFile: async () => {} },
	};
}

function findImage(result: Awaited<ReturnType<AgentTool["execute"]>>) {
	return result.content.find((part) => part.type === "image");
}

describe("BMP disk images", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("converts valid local BMP files and treats malformed BMP signatures as text", async () => {
		const root = join(tmpdir(), `pi-bmp-local-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		roots.push(root);
		const validPath = join(root, "valid.bmp");
		const malformedPath = join(root, "malformed.bmp");
		writeFileSync(validPath, createTinyBmp1x1Red24bpp());
		writeFileSync(malformedPath, "BM malformed, not a bitmap");

		const valid = await processFileArguments([validPath]);
		expect(valid.images).toHaveLength(1);
		expect(valid.images[0]?.mimeType).toBe("image/png");
		expectPng(valid.images[0]?.data ?? "");
		expect(valid.text).toContain("[Image converted from image/bmp to image/png.]");
		const validWithoutResize = await processFileArguments([validPath], { autoResizeImages: false });
		expect(validWithoutResize.images[0]?.mimeType).toBe("image/png");
		expectPng(validWithoutResize.images[0]?.data ?? "");

		const malformed = await processFileArguments([malformedPath]);
		expect(malformed.images).toHaveLength(0);
		expect(malformed.text).toContain("BM malformed, not a bitmap");
	});

	it("converts valid BMP bytes and rejects malformed BMP bytes through SSH/HCP read operations", async () => {
		const root = join(tmpdir(), `pi-bmp-ssh-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		roots.push(root);
		const validPath = join(root, "valid.bmp");
		const malformedPath = join(root, "malformed.bmp");
		const files = new Map([
			[validPath, createTinyBmp1x1Red24bpp()],
			[malformedPath, Buffer.from("BM malformed remote file")],
		]);
		const settingsManager = SettingsManager.create(root, agentDir);
		settingsManager.setImageAutoResize(false);
		const { hcp } = await HcpClientbuildsession({ repoRoot: root });
		await HcpClientassembletools({
			hcp,
			cwd: root,
			settingsManager,
			sshOperations: createSshOperations(files),
		});
		const read = hcp.resolveInstance<AgentTool>("tool:read")!;

		const valid = await read.execute("bmp-valid", { path: validPath });
		const image = findImage(valid);
		expect(image).toMatchObject({ type: "image", mimeType: "image/png" });
		if (image?.type === "image") expectPng(image.data);

		const malformed = await read.execute("bmp-malformed", { path: malformedPath });
		expect(findImage(malformed)).toBeUndefined();
		expect(malformed.content).toEqual([
			expect.objectContaining({ type: "text", text: expect.stringContaining("BM malformed remote file") }),
		]);
		await hcp.dispose();
	});
});
