import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { applyAlias } from "../../../harness/extensions/pi/bundled/command-aliases.ts";
import sideChatExtension, { SIDE_CHAT_COMMAND_NAMES } from "../../../harness/extensions/pi/bundled/side-chat.ts";

describe("command links", () => {
	it("maps bare quit and exit input to the quit slash command", () => {
		expect(applyAlias("exit")).toBe("/quit");
		expect(applyAlias(" quit ")).toBe("/quit");
		expect(applyAlias("clear")).toBe("/new");
		expect(applyAlias("please exit")).toBe("please exit");
	});

	it("exposes harness, quit, and exit as built-in slash commands", () => {
		const names = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name));

		expect(names.has("harness")).toBe(true);
		expect(names.has("quit")).toBe(true);
		expect(names.has("exit")).toBe(true);
	});

	it("registers side, btw, and s to the same side-chat handler", () => {
		const commands = new Map<string, unknown>();
		const events: string[] = [];
		const pi = {
			on: (event: string) => {
				events.push(event);
			},
			registerCommand: (name: string, command: unknown) => {
				commands.set(name, command);
			},
		} as unknown as ExtensionAPI;

		sideChatExtension(pi);

		expect([...commands.keys()].sort()).toEqual([...SIDE_CHAT_COMMAND_NAMES].sort());
		expect(commands.get("btw")).toBe(commands.get("side"));
		expect(commands.get("s")).toBe(commands.get("side"));
		expect(events).toEqual(["agent_start", "tool_execution_start", "tool_execution_update", "tool_execution_end"]);
	});
});
