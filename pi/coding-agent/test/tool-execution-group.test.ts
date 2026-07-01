import { Text, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, test } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { ToolExecutionGroupComponent } from "../src/modes/interactive/components/tool-execution-group.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

beforeAll(() => {
	initTheme("dark");
});

function fakeTui(): TUI {
	return { requestRender: () => undefined } as unknown as TUI;
}

function definition(name: string): ToolDefinition {
	return {
		name,
		label: name,
		description: name,
		parameters: Type.Any(),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		renderCall: (args) => new Text(`call ${name} ${JSON.stringify(args)}`, 0, 0),
		renderResult: (result) =>
			new Text(`result ${name} ${result.content.map((item) => item.text ?? "").join("")}`, 0, 0),
	};
}

function component(name: string, id: string, args: unknown): ToolExecutionComponent {
	return new ToolExecutionComponent(name, id, args, {}, definition(name), fakeTui(), process.cwd());
}

describe("ToolExecutionGroupComponent", () => {
	test("collapses multiple tools into a gallery and expands to child details", () => {
		const group = new ToolExecutionGroupComponent({ showImages: true });
		const first = component("custom_a", "a", { value: 1 });
		const second = component("custom_b", "b", { value: 2 });

		group.addOrUpdateTool("a", "custom_a", { value: 1 }, first);
		group.addOrUpdateTool("b", "custom_b", { value: 2 }, second);
		group.markExecutionStarted("a");
		group.updateResult("a", { content: [{ type: "text", text: "done a" }], isError: false }, false);
		group.updateResult("b", { content: [{ type: "text", text: "Error: failed b" }], isError: true }, false);

		const collapsed = stripAnsi(group.render(100).join("\n"));
		expect(collapsed).toContain("tools - 2 calls");
		expect(collapsed).toContain("[success]");
		expect(collapsed).toContain("[error]");
		expect(collapsed).not.toContain("result custom_a");

		group.setExpanded(true);
		const expanded = stripAnsi(group.render(100).join("\n"));
		expect(expanded).toContain("result custom_a done a");
		expect(expanded).toContain("result custom_b Error: failed b");
	});

	test("keeps single-tool rendering identical to the child component when collapsed", () => {
		const group = new ToolExecutionGroupComponent({ showImages: true });
		const child = component("custom_single", "single", { value: 3 });
		group.addOrUpdateTool("single", "custom_single", { value: 3 }, child);

		expect(stripAnsi(group.render(100).join("\n"))).toContain("call custom_single");
	});
});
