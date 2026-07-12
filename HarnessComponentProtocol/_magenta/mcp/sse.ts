/**
 * Incremental Server-Sent Events (SSE) frame parser.
 *
 * The streamable-HTTP MCP transport may return responses as an SSE stream where
 * each frame's `data:` field carries one JSON-RPC message. This parser turns a
 * growing text buffer into complete frames, returning the unparsed remainder so
 * a caller can append the next network chunk and parse again. It implements the
 * subset of the SSE spec the transport needs: frames delimited by a blank line
 * using CRLF, LF, CR, or legal mixed line endings; `event:`/`data:`/`id:`
 * fields; `:` comment lines; and multi-line `data:` concatenation with `\n`.
 *
 * The logic mirrors the corroborated implementations in the official Rust SDK
 * (`rmcp` client-side SSE), the reference `aose-mcp` client, and Claude Code's
 * `parseSSEFrames`.
 */

export type SseFrame = {
	event?: string;
	id?: string;
	/** Concatenated `data:` payload, or undefined for a comment-only frame. */
	data?: string;
};

export type ParseSseResult = {
	frames: SseFrame[];
	/** Bytes after the last complete frame; feed the next chunk after this. */
	remaining: string;
};

/** Find the end index of the first complete frame, or -1 if none is complete. */
function frameBoundary(buffer: string, from: number): { index: number; width: number } {
	// Enumerate pairs of SSE line endings explicitly. A grouped alternation would
	// backtrack and misread one CRLF as two separate endings (`CR` + `LF`).
	const match = /\r\n\r\n|\r\n\r|\r\n\n|\r\r\n|\n\r\n|\r\r|\n\n|\n\r/u.exec(buffer.slice(from));
	if (!match || match.index === undefined) return { index: -1, width: 0 };
	return { index: from + match.index, width: match[0].length };
}

export function parseSseFrames(buffer: string): ParseSseResult {
	const frames: SseFrame[] = [];
	let pos = 0;

	for (;;) {
		const { index, width } = frameBoundary(buffer, pos);
		if (index === -1) break;
		const rawFrame = buffer.slice(pos, index);
		pos = index + width;
		if (rawFrame.trim() === "") continue;

		const frame: SseFrame = {};
		const dataLines: string[] = [];
		for (const line of rawFrame.split(/\r\n|\r|\n/u)) {
			if (line === "" || line.startsWith(":")) continue; // comment / blank
			const colon = line.indexOf(":");
			const field = colon === -1 ? line : line.slice(0, colon);
			// Per the SSE spec, strip a single leading space after the colon.
			let value = colon === -1 ? "" : line.slice(colon + 1);
			if (value.startsWith(" ")) value = value.slice(1);
			switch (field) {
				case "event":
					frame.event = value;
					break;
				case "id":
					frame.id = value;
					break;
				case "data":
					dataLines.push(value);
					break;
				// Ignore other fields (retry:, etc.).
			}
		}
		if (dataLines.length > 0) frame.data = dataLines.join("\n");
		if (frame.data !== undefined || frame.event !== undefined || frame.id !== undefined) {
			frames.push(frame);
		}
	}

	return { frames, remaining: buffer.slice(pos) };
}
