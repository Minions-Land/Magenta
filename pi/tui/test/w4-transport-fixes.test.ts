import assert from "node:assert";
import { describe, it } from "node:test";
import { parseKey } from "../src/keys.ts";
import { normalizeTerminalOutput } from "../src/utils.ts";

// TR-004: normalizeTerminalOutput expands visible tabs to a fixed width so
// terminal tab stops cannot wrap a logical line, while leaving ANSI sequences
// untouched.
describe("TR-004 tab normalization for terminal output", () => {
	it("expands a leading tab to three spaces", () => {
		assert.strictEqual(normalizeTerminalOutput("\thi"), "   hi");
	});

	it("expands multiple tabs", () => {
		assert.strictEqual(normalizeTerminalOutput("a\tb\tc"), "a   b   c");
	});

	it("leaves tab-free strings unchanged", () => {
		assert.strictEqual(normalizeTerminalOutput("plain text"), "plain text");
	});

	it("does not expand tabs inside ANSI escape sequences", () => {
		// An SGR sequence has no tab; a tab in visible text is still expanded.
		const input = "\x1b[31m\tred\x1b[39m";
		assert.strictEqual(normalizeTerminalOutput(input), "\x1b[31m   red\x1b[39m");
	});
});

// TR-003: legacy alt-prefixed symbol keys (ESC followed by a printable symbol)
// parse to alt+<symbol>, not just alt+letter/digit.
describe("TR-003 legacy alt-prefixed symbol parsing", () => {
	it("parses alt+letter (regression guard)", () => {
		assert.strictEqual(parseKey("\x1ba"), "alt+a");
	});

	it("parses alt+digit (regression guard)", () => {
		assert.strictEqual(parseKey("\x1b5"), "alt+5");
	});

	it("parses a legacy alt-prefixed symbol key", () => {
		// "/" is a SYMBOL_KEYS member; ESC + "/" should map to alt+/
		const result = parseKey("\x1b/");
		assert.strictEqual(result, "alt+/");
	});
});
