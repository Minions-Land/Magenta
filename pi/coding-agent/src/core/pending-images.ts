import type { ImageContent } from "@earendil-works/pi-ai/compat";
import type { SubmittedInput } from "./agent-session.ts";

const IMAGE_PASTE_MARKER = /\[paste #\d+ Image\]/g;
const IMAGE_PASTE_MARKER_SINGLE = /^\[paste #\d+ Image\]$/;

export function findImagePasteMarkers(text: string): string[] {
	return text.match(IMAGE_PASTE_MARKER) ?? [];
}

/** Keeps clipboard images in memory until their registered editor markers are submitted. */
export class PendingImageController {
	private readonly imagesByMarker = new Map<string, ImageContent>();

	get size(): number {
		return this.imagesByMarker.size;
	}

	add(marker: string, image: ImageContent): void {
		if (!IMAGE_PASTE_MARKER_SINGLE.test(marker)) {
			throw new Error(`Invalid image paste marker: ${marker}`);
		}
		if (this.imagesByMarker.has(marker)) {
			throw new Error(`Duplicate image paste marker: ${marker}`);
		}
		this.imagesByMarker.set(marker, image);
	}

	clear(): void {
		this.imagesByMarker.clear();
	}

	/**
	 * Consume images whose markers remain in the submitted text, preserving marker order.
	 * All pending images are released because a submission ends the editor draft.
	 */
	takeForText(text: string): SubmittedInput {
		const images: ImageContent[] = [];
		const imageMarkers: string[] = [];
		const seen = new Set<string>();
		for (const marker of findImagePasteMarkers(text)) {
			if (seen.has(marker)) continue;
			seen.add(marker);
			const image = this.imagesByMarker.get(marker);
			if (image) {
				images.push(image);
				imageMarkers.push(marker);
			}
		}
		this.clear();
		return images.length > 0 ? { text, images, imageMarkers } : { text };
	}
}
