import { describe, expect, it } from "vitest";
import { ImageTokenController } from "../src/core/image-tokens.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("ImageTokenController", () => {
	it("replaces clipboard image paths with compact tokens and restores them on submit", () => {
		const controller = new ImageTokenController();
		const path = "/tmp/pi-clipboard-123e4567-e89b-12d3-a456-426614174000.png";

		expect(controller.replaceClipboardPaths(`look at ${path}`)).toBe("look at [image1] ");
		expect(controller.size).toBe(1);

		const result = controller.transformInput("please inspect [image1]");
		expect(result.transformed).toBe(true);
		expect(result.text).toBe(`please inspect ${path}`);
		expect(controller.size).toBe(0);
	});

	it("allocates the next free token id when existing text already contains image tokens", () => {
		const controller = new ImageTokenController();
		const path = "/tmp/pi-clipboard-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.webp";

		expect(controller.replaceClipboardPaths(path, "already [image1]")).toBe("[image2] ");
	});

	it("formats clipboard file URL paths and keeps non-image paths visible", () => {
		const controller = new ImageTokenController();
		const image = "/Users/test/Pictures/screenshot.jpeg";
		const text = "/Users/test/Documents/readme.txt";

		expect(controller.formatClipboardPaths([image, text])).toBe(`[image1]\n${text} `);
	});

	it("finds token delete ranges for backward and forward deletion", () => {
		const controller = new ImageTokenController();
		const line = "see [image1] now";

		expect(controller.findDeleteRange(line, 11, true)).toEqual({ start: 4, end: 12, token: "[image1]" });
		expect(controller.findDeleteRange(line, 4, false)).toEqual({ start: 4, end: 13, token: "[image1]" });
		expect(controller.findDeleteRange(line, 0, true)).toBeUndefined();
	});

	it("renders known tokens through the provided theme", () => {
		const controller = new ImageTokenController();
		controller.formatClipboardPaths(["/tmp/image.png"]);

		const rendered = controller.render(["attach [image1]"], {
			fg: (_color, text) => `<fg>${text}</fg>`,
			inverse: (text) => `<inverse>${text}</inverse>`,
		}, 80);

		expect(rendered).toEqual(["attach <fg><inverse>[image1]</inverse></fg>"]);
	});
});

describe("image token settings", () => {
	it("compresses image tokens by default and can be disabled", () => {
		const manager = SettingsManager.inMemory();

		expect(manager.getCompressImageTokens()).toBe(true);
		manager.setCompressImageTokens(false);
		expect(manager.getCompressImageTokens()).toBe(false);
		manager.setCompressImageTokens(true);
		expect(manager.getCompressImageTokens()).toBe(true);
	});
});
