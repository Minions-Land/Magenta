import { spawnSync } from "node:child_process";
import { truncateToWidth } from "@earendil-works/pi-tui";

const CLIPBOARD_PATH_RE = /(?:[^\s"'`<>]+[\\/])?pi-clipboard-[0-9a-f-]+\.(?:png|jpe?g|webp|gif)/gi;
const IMAGE_FILE_RE = /\.(?:png|jpe?g|webp|gif)$/i;
const TOKEN_RE = /\[image(\d+)\]/g;
const TOKEN_LINE_RE = /\[image\d+\]/g;

const MACOS_CLIPBOARD_FILE_PATHS_SCRIPT = `
ObjC.import('AppKit');
ObjC.import('Foundation');
const pb = $.NSPasteboard.generalPasteboard;
const classes = $.NSArray.arrayWithObject($.NSURL);
const options = $.NSDictionary.dictionaryWithObjectForKey($.NSNumber.numberWithBool(true), $.NSPasteboardURLReadingFileURLsOnlyKey);
const urls = pb.readObjectsForClassesOptions(classes, options);
const paths = [];
if (urls) {
  for (let i = 0; i < urls.count; i++) {
    const url = urls.objectAtIndex(i);
    if (url.isFileURL) paths.push(ObjC.unwrap(url.path));
  }
}
JSON.stringify(paths);
`;

export interface ImageTokenTheme {
	fg(color: "toolDiffAdded", text: string): string;
	inverse(text: string): string;
}

export interface ImageTokenAttachment {
	token: string;
	path: string;
}

export interface ImageTokenDeleteRange {
	start: number;
	end: number;
	token: string;
}

export function imageToken(id: number): string {
	return `[image${id}]`;
}

export function renderImageToken(token: string, theme: ImageTokenTheme): string {
	return theme.fg("toolDiffAdded", theme.inverse(token));
}

export function readClipboardFilePaths(): string[] {
	if (process.platform !== "darwin") return [];

	const result = spawnSync("osascript", ["-l", "JavaScript", "-e", MACOS_CLIPBOARD_FILE_PATHS_SCRIPT], {
		encoding: "utf8",
		timeout: 700,
		maxBuffer: 1024 * 1024,
	});
	if (result.error || result.status !== 0) return [];

	try {
		const parsed: unknown = JSON.parse(result.stdout.trim() || "[]");
		if (!Array.isArray(parsed)) return [];
		return [...new Set(parsed.filter((path): path is string => typeof path === "string" && path.length > 0))];
	} catch {
		return [];
	}
}

export class ImageTokenController {
	private readonly attachments = new Map<string, ImageTokenAttachment>();

	clear(): void {
		this.attachments.clear();
	}

	get size(): number {
		return this.attachments.size;
	}

	render(lines: string[], theme: ImageTokenTheme, width: number): string[] {
		if (this.attachments.size === 0) return lines;

		let rendered = lines;
		for (const attachment of this.attachments.values()) {
			rendered = rendered.map((line) =>
				line.replaceAll(attachment.token, renderImageToken(attachment.token, theme)),
			);
		}
		return rendered.map((line) => truncateToWidth(line, width, ""));
	}

	replaceClipboardPaths(text: string, existingText = ""): string {
		const usedIds = this.collectUsedIds(`${existingText}\n${text}`);
		return text.replace(CLIPBOARD_PATH_RE, (path) => this.create(path, usedIds));
	}

	formatClipboardPaths(paths: string[], existingText = ""): string {
		const usedIds = this.collectUsedIds(existingText);
		const pieces = paths.map((path) => (IMAGE_FILE_RE.test(path) ? this.create(path, usedIds).trimEnd() : path));
		return pieces.length > 0 ? `${pieces.join(paths.length > 1 ? "\n" : "")} ` : "";
	}

	transformInput(text: string): { transformed: boolean; text: string } {
		const selected = this.collectAttachments(text);
		if (selected.length === 0) return { transformed: false, text };

		const transformed = text.replace(
			TOKEN_RE,
			(full, id) => this.attachments.get(imageToken(Number(id)))?.path ?? full,
		);
		for (const attachment of selected) this.attachments.delete(attachment.token);
		return { transformed: true, text: transformed };
	}

	collectUsedIds(text: string): Set<number> {
		const ids = new Set<number>();
		for (const match of text.matchAll(TOKEN_RE)) ids.add(Number(match[1]));
		return ids;
	}

	create(path: string, usedIds: Set<number>): string {
		let id = 1;
		while (usedIds.has(id)) id++;
		usedIds.add(id);
		const token = imageToken(id);
		this.attachments.set(token, { token, path });
		return `${token} `;
	}

	findDeleteRange(line: string, cursorCol: number, backward: boolean): ImageTokenDeleteRange | undefined {
		for (const match of line.matchAll(TOKEN_LINE_RE)) {
			const token = match[0];
			const start = match.index;
			let end = start + token.length;
			if (backward) {
				if (start < cursorCol && cursorCol <= end) return { start, end, token };
				if (cursorCol === end + 1 && line[end] === " ") return { start, end: end + 1, token };
			} else if (start <= cursorCol && cursorCol < end) {
				if (line[end] === " ") end++;
				return { start, end, token };
			}
		}
		return undefined;
	}

	deleteAttachment(token: string): void {
		this.attachments.delete(token);
	}

	private collectAttachments(text: string): ImageTokenAttachment[] {
		const selected: ImageTokenAttachment[] = [];
		const seen = new Set<string>();
		for (const match of text.matchAll(TOKEN_RE)) {
			const token = imageToken(Number(match[1]));
			const attachment = this.attachments.get(token);
			if (!attachment || seen.has(token)) continue;
			seen.add(token);
			selected.push(attachment);
		}
		return selected;
	}
}
