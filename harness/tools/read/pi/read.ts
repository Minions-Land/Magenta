import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile } from "fs/promises";
import { type Static, Type } from "typebox";
import { resolveReadPathAsync } from "../../support/path-utils.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "../../support/truncate.ts";

export const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

export type ReadToolInput = Static<typeof readSchema>;

export interface ReadToolDetails {
	truncation?: TruncationResult;
}

/**
 * Result of an injectable image-resize operation.
 *
 * Image resizing depends on pi-only infrastructure (worker threads + Photon WASM),
 * so the concrete implementation is injected by the assembling pi package. This
 * structural type keeps the harness execute logic free of any pi dependency.
 */
export interface ResizedImageResult {
	/** Base64-encoded image payload. */
	data: string;
	/** MIME type of the (possibly re-encoded) image. */
	mimeType: string;
	/** Optional human-readable note describing the resize/coordinate mapping. */
	dimensionNote?: string;
}

/**
 * Pluggable operations for the read tool.
 * Override these to delegate file reading to remote systems (for example SSH).
 */
export interface ReadOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Check if file is readable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
	/** Detect image MIME type, return null or undefined for non-images */
	detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
	/**
	 * Resize image bytes for inline delivery to the model. Return null if the image
	 * cannot be resized below the inline size limit. When omitted, raw image bytes
	 * are sent as-is.
	 */
	resizeImage?: (bytes: Buffer, mimeType: string) => Promise<ResizedImageResult | null>;
}

/**
 * Default operations for the read tool: local-filesystem reads only.
 *
 * Image detection and resizing are intentionally absent here because they depend
 * on pi-only utilities. The assembling pi package supplies those operations.
 */
export const defaultReadOperations: ReadOperations = {
	readFile: (path) => fsReadFile(path),
	access: (path) => fsAccess(path, constants.R_OK),
};

export interface ReadToolOptions {
	/** Whether to auto-resize images to 2000x2000 max. Default: true */
	autoResizeImages?: boolean;
	/** Custom operations for file reading. Default: local filesystem */
	operations?: ReadOperations;
}

function getNonVisionImageNote(model: Model<Api> | undefined): string | undefined {
	if (!model || model.input.includes("image")) {
		return undefined;
	}
	return "[Current model does not support images. The image will be omitted from this request.]";
}

/**
 * Build the pure execute function for the read tool.
 *
 * Returns a function matching the `ToolDefinition.execute` / `AgentTool.execute`
 * shape so pi can assemble the full ToolDefinition by combining this with its
 * renderers.
 */
export function createReadExecute(cwd: string, options?: ReadToolOptions) {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const ops = options?.operations ?? defaultReadOperations;
	return function execute(
		_toolCallId: string,
		{ path, offset, limit }: ReadToolInput,
		signal?: AbortSignal,
		_onUpdate?: unknown,
		ctx?: { model?: Model<Api> },
	): Promise<AgentToolResult<ReadToolDetails | undefined>> {
		return new Promise<AgentToolResult<ReadToolDetails | undefined>>((resolve, reject) => {
			if (signal?.aborted) {
				reject(new Error("Operation aborted"));
				return;
			}
			let aborted = false;
			const onAbort = () => {
				aborted = true;
				reject(new Error("Operation aborted"));
			};
			signal?.addEventListener("abort", onAbort, { once: true });

			(async () => {
				try {
					const absolutePath = await resolveReadPathAsync(path, cwd);
					if (aborted) return;
					// Check if file exists and is readable.
					await ops.access(absolutePath);
					if (aborted) return;
					const mimeType = ops.detectImageMimeType ? await ops.detectImageMimeType(absolutePath) : undefined;
					let content: (TextContent | ImageContent)[];
					let details: ReadToolDetails | undefined;
					const nonVisionImageNote = getNonVisionImageNote(ctx?.model);
					if (mimeType) {
						// Read image as binary.
						const buffer = await ops.readFile(absolutePath);
						if (autoResizeImages && ops.resizeImage) {
							// Resize image if needed before sending it back to the model.
							const resized = await ops.resizeImage(buffer, mimeType);
							if (!resized) {
								let textNote = `Read image file [${mimeType}]\n[Image omitted: could not be resized below the inline image size limit.]`;
								if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
								content = [{ type: "text", text: textNote }];
							} else {
								let textNote = `Read image file [${resized.mimeType}]`;
								if (resized.dimensionNote) textNote += `\n${resized.dimensionNote}`;
								if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
								content = [
									{ type: "text", text: textNote },
									{ type: "image", data: resized.data, mimeType: resized.mimeType },
								];
							}
						} else {
							let textNote = `Read image file [${mimeType}]`;
							if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
							content = [
								{ type: "text", text: textNote },
								{ type: "image", data: buffer.toString("base64"), mimeType },
							];
						}
					} else {
						// Read text content.
						const buffer = await ops.readFile(absolutePath);
						const textContent = buffer.toString("utf-8");
						const allLines = textContent.split("\n");
						const totalFileLines = allLines.length;
						// Apply offset if specified. Convert from 1-indexed input to 0-indexed array access.
						const startLine = offset ? Math.max(0, offset - 1) : 0;
						const startLineDisplay = startLine + 1;
						// Check if offset is out of bounds.
						if (startLine >= allLines.length) {
							throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
						}
						let selectedContent: string;
						let userLimitedLines: number | undefined;
						// If limit is specified by the user, honor it first. Otherwise truncateHead decides.
						if (limit !== undefined) {
							const endLine = Math.min(startLine + limit, allLines.length);
							selectedContent = allLines.slice(startLine, endLine).join("\n");
							userLimitedLines = endLine - startLine;
						} else {
							selectedContent = allLines.slice(startLine).join("\n");
						}
						// Apply truncation, respecting both line and byte limits.
						const truncation = truncateHead(selectedContent);
						let outputText: string;
						if (truncation.firstLineExceedsLimit) {
							// First line alone exceeds the byte limit. Point the model at a bash fallback.
							const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
							outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
							details = { truncation };
						} else if (truncation.truncated) {
							// Truncation occurred. Build an actionable continuation notice.
							const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
							const nextOffset = endLineDisplay + 1;
							outputText = truncation.content;
							if (truncation.truncatedBy === "lines") {
								outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
							} else {
								outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
							}
							details = { truncation };
						} else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
							// User-specified limit stopped early, but the file still has more content.
							const remaining = allLines.length - (startLine + userLimitedLines);
							const nextOffset = startLine + userLimitedLines + 1;
							outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
						} else {
							// No truncation and no remaining user-limited content.
							outputText = truncation.content;
						}
						content = [{ type: "text", text: outputText }];
					}

					if (aborted) return;
					signal?.removeEventListener("abort", onAbort);
					resolve({ content, details });
				} catch (error: any) {
					signal?.removeEventListener("abort", onAbort);
					if (!aborted) reject(error);
				}
			})();
		});
	};
}
