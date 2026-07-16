import { describe, expect, it } from "vitest";
import {
	appendTail,
	flushTail,
	truncateModelText,
	truncateTail,
	Utf8TailDecoder,
} from "../src/core/background-shell-utils.ts";

describe("appendTail", () => {
	it("decodes CJK and emoji sequences split across chunks", () => {
		const source = Buffer.from("前🙂后", "utf8");
		const chunks = [source.subarray(0, 1), source.subarray(1, 4), source.subarray(4, 7), source.subarray(7)];
		const decoder = new Utf8TailDecoder();
		let tail = "";

		for (const chunk of chunks) tail = appendTail(tail, chunk, 64, decoder);
		tail = flushTail(tail, decoder, 64);

		expect(tail).toBe("前🙂后");
		expect(tail).not.toContain("�");
	});

	it("flushes with omitted or explicit final bytes", () => {
		expect(new Utf8TailDecoder().end()).toBe("");

		const source = Buffer.from("中", "utf8");
		const decoder = new Utf8TailDecoder();
		expect(decoder.write(source.subarray(0, 2))).toBe("");
		expect(decoder.end(source.subarray(2))).toBe("中");
	});

	it("keeps decoder state independent for interleaved events", () => {
		const cjk = Buffer.from("中", "utf8");
		const emoji = Buffer.from("🙂", "utf8");
		const cjkDecoder = new Utf8TailDecoder();
		const emojiDecoder = new Utf8TailDecoder();
		let cjkTail = appendTail("", cjk.subarray(0, 2), 64, cjkDecoder);
		let emojiTail = appendTail("", emoji.subarray(0, 2), 64, emojiDecoder);

		cjkTail = appendTail(cjkTail, cjk.subarray(2), 64, cjkDecoder);
		emojiTail = appendTail(emojiTail, emoji.subarray(2), 64, emojiDecoder);

		expect(cjkTail).toBe("中");
		expect(emojiTail).toBe("🙂");
	});

	it("never splits a surrogate pair at the byte boundary", () => {
		expect(appendTail("", Buffer.from("A🙂B"), 5)).toBe("🙂B");
		expect(appendTail("", Buffer.from("A🙂B"), 3)).toBe("B");
		expect(appendTail("", Buffer.from("A🙂B"), 0)).toBe("");
	});

	it("enforces the byte cap for mixed UTF-8 output", () => {
		const limit = 1024;
		const tail = appendTail("prefix", Buffer.from("中🙂".repeat(1_000)), limit);

		expect(Buffer.byteLength(tail, "utf8")).toBeLessThanOrEqual(limit);
		expect(tail).not.toContain("�");
	});

	it("preserves ASCII tail behavior", () => {
		expect(appendTail("abc", Buffer.from("def"), 5)).toBe("bcdef");
		expect(appendTail("abc", Buffer.from("def"), 6)).toBe("abcdef");
	});
});

describe("truncateTail", () => {
	it("returns a valid UTF-8 suffix without splitting emoji", () => {
		expect(truncateTail("A🙂B", 5)).toEqual({ text: "🙂B", truncated: true });
		expect(truncateTail("A🙂B", 3)).toEqual({ text: "B", truncated: true });
	});
});

describe("truncateModelText", () => {
	it("caps UTF-8 bytes while retaining identifying head and recent tail", () => {
		const source = `HEAD-${"中🙂".repeat(4_000)}-TAIL`;
		const result = truncateModelText(source, 1024);

		expect(result.truncated).toBe(true);
		expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(1024);
		expect(result.text).toContain("HEAD-");
		expect(result.text).toContain("-TAIL");
		expect(result.text).toContain("Model-visible result shortened");
		expect(result.text).not.toContain("�");
	});

	it("leaves already bounded text unchanged", () => {
		expect(truncateModelText("small", 32)).toEqual({ text: "small", truncated: false });
	});
});
