import { describe, expect, it } from "vitest";
import { applyCommandAlias } from "../src/core/command-aliases.ts";
import { SIDE_CHAT_COMMAND_NAMES } from "../src/core/side-chat.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";

describe("command links", () => {
	it("maps quit and clear aliases to their canonical slash commands", () => {
		expect(applyCommandAlias("exit")).toBe("/quit");
		expect(applyCommandAlias(" quit ")).toBe("/quit");
		expect(applyCommandAlias("clear")).toBe("/new");
		expect(applyCommandAlias(" /clear ")).toBe("/new");
		expect(applyCommandAlias("please exit")).toBe("please exit");
	});

	it("exposes harness, remote, quit, and exit as built-in slash commands", () => {
		const names = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name));

		expect(names.has("harness")).toBe(true);
		expect(names.has("remote")).toBe(true);
		expect(names.has("quit")).toBe(true);
		expect(names.has("exit")).toBe(true);
	});

	it("exposes side, btw, and s as built-in slash commands", () => {
		const names = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name));

		for (const name of SIDE_CHAT_COMMAND_NAMES) {
			expect(names.has(name)).toBe(true);
		}
	});
});
