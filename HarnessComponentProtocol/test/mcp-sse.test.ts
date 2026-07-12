import { describe, expect, it } from "vitest";
import { parseSseFrames } from "../_magenta/mcp/sse.ts";

describe("parseSseFrames", () => {
	it("parses a single data frame delimited by a blank line", () => {
		const { frames, remaining } = parseSseFrames('data: {"id":1}\n\n');
		expect(frames).toEqual([{ data: '{"id":1}' }]);
		expect(remaining).toBe("");
	});

	it("keeps an incomplete trailing frame in remaining", () => {
		const { frames, remaining } = parseSseFrames('data: {"id":1}\n\ndata: {"id":2}');
		expect(frames).toEqual([{ data: '{"id":1}' }]);
		expect(remaining).toBe('data: {"id":2}');
	});

	it("concatenates multi-line data with newlines and captures event/id", () => {
		const { frames } = parseSseFrames("event: message\nid: 42\ndata: line1\ndata: line2\n\n");
		expect(frames).toEqual([{ event: "message", id: "42", data: "line1\nline2" }]);
	});

	it("handles CRLF frame delimiters and line endings", () => {
		const { frames, remaining } = parseSseFrames('data: {"a":1}\r\n\r\n');
		expect(frames).toEqual([{ data: '{"a":1}' }]);
		expect(remaining).toBe("");
	});

	it("handles bare CR and mixed legal SSE line endings", () => {
		expect(parseSseFrames('data: {"a":1}\r\r').frames).toEqual([{ data: '{"a":1}' }]);
		expect(parseSseFrames('data: {"b":2}\r\n\n').frames).toEqual([{ data: '{"b":2}' }]);
		expect(parseSseFrames('data: {"c":3}\n\r\n').frames).toEqual([{ data: '{"c":3}' }]);
	});

	it("does not treat a single CRLF line ending as an empty frame boundary", () => {
		const { frames, remaining } = parseSseFrames("data: first\r\ndata: second");
		expect(frames).toEqual([]);
		expect(remaining).toBe("data: first\r\ndata: second");
	});

	it("skips comment-only frames (keepalives)", () => {
		const { frames } = parseSseFrames(":keepalive\n\ndata: x\n\n");
		expect(frames).toEqual([{ data: "x" }]);
	});

	it("strips exactly one leading space after the colon", () => {
		const { frames } = parseSseFrames("data:  two-spaces\n\n");
		expect(frames[0]?.data).toBe(" two-spaces");
	});

	it("parses multiple frames from one buffer", () => {
		const { frames } = parseSseFrames("data: a\n\ndata: b\n\ndata: c\n\n");
		expect(frames.map((f) => f.data)).toEqual(["a", "b", "c"]);
	});
});
