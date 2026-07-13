import type { ImageContent } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { PendingImageController } from "../src/core/pending-images.ts";

function image(data: string): ImageContent {
	return { type: "image", mimeType: "image/png", data };
}

describe("PendingImageController", () => {
	it("submits clipboard images in marker order and keeps marker text", () => {
		const pending = new PendingImageController();
		pending.add("[paste #2 Image]", image("second"));
		pending.add("[paste #1 Image]", image("first"));

		expect(pending.takeForText("compare [paste #1 Image] with [paste #2 Image]")).toEqual({
			text: "compare [paste #1 Image] with [paste #2 Image]",
			images: [image("first"), image("second")],
			imageMarkers: ["[paste #1 Image]", "[paste #2 Image]"],
		});
		expect(pending.size).toBe(0);
	});

	it("does not submit deleted, unknown, or duplicated markers", () => {
		const pending = new PendingImageController();
		pending.add("[paste #1 Image]", image("first"));
		pending.add("[paste #2 Image]", image("deleted"));

		expect(pending.takeForText("[paste #1 Image] [paste #1 Image] [paste #99 Image]")).toEqual({
			text: "[paste #1 Image] [paste #1 Image] [paste #99 Image]",
			images: [image("first")],
			imageMarkers: ["[paste #1 Image]"],
		});
		expect(pending.size).toBe(0);
	});

	it("drops images whose markers were removed (undone) from the submitted text", () => {
		const pending = new PendingImageController();
		pending.add("[paste #1 Image]", image("kept"));
		pending.add("[paste #2 Image]", image("undone"));

		// The user undid the second marker insertion, so only #1 remains in the text.
		expect(pending.takeForText("keep [paste #1 Image]")).toEqual({
			text: "keep [paste #1 Image]",
			images: [image("kept")],
			imageMarkers: ["[paste #1 Image]"],
		});
		// Submission releases all pending images, so the undone one cannot leak into a later turn.
		expect(pending.size).toBe(0);
		expect(pending.takeForText("[paste #2 Image]")).toEqual({ text: "[paste #2 Image]" });
	});

	it("rejects invalid and duplicate marker ownership", () => {
		const pending = new PendingImageController();
		expect(() => pending.add("[image1]", image("bad"))).toThrow("Invalid image paste marker");
		pending.add("[paste #1 Image]", image("first"));
		expect(() => pending.add("[paste #1 Image]", image("replacement"))).toThrow("Duplicate image paste marker");
	});
});
