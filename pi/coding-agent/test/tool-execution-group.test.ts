import { StaticPrefixContainer, Text, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, test, vi } from "vitest";
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
			new Text(
				`result ${name} ${result.content.map((item) => (item.type === "text" ? item.text : "")).join("")}`,
				0,
				0,
			),
	};
}

function component(name: string, id: string, args: unknown): ToolExecutionComponent {
	return new ToolExecutionComponent(name, id, args, {}, definition(name), fakeTui(), process.cwd());
}

describe("ToolExecutionGroupComponent", () => {
	test("collapses multiple tools into activity and expands to gallery plus child details", () => {
		const group = new ToolExecutionGroupComponent({ showImages: true });
		const first = component("custom_a", "a", { value: 1 });
		const second = component("custom_b", "b", { value: 2 });

		group.addOrUpdateTool("a", "custom_a", { value: 1 }, first);
		group.addOrUpdateTool("b", "custom_b", { value: 2 }, second);
		group.markExecutionStarted("a");
		group.updateResult("a", { content: [{ type: "text", text: "done a" }], isError: false }, false);
		group.updateResult("b", { content: [{ type: "text", text: "Error: failed b" }], isError: true }, false);

		const collapsed = stripAnsi(group.render(100).join("\n"));
		expect(collapsed).toContain("activity");
		expect(collapsed).toContain("tools ×2");
		expect(collapsed).toContain("✓1");
		expect(collapsed).toContain("✕1");
		expect(collapsed).toContain("Ctrl+o gallery");
		expect(collapsed).not.toContain("result custom_a");

		group.setExpanded(true);
		const expanded = stripAnsi(group.render(100).join("\n"));
		expect(expanded).toContain("tools · 2 calls");
		expect(expanded).toContain("result custom_a done a");
		expect(expanded).toContain("result custom_b Error: failed b");
	});

	test("keeps single-tool rendering identical to the child component when collapsed", () => {
		const group = new ToolExecutionGroupComponent({ showImages: true });
		const child = component("custom_single", "single", { value: 3 });
		group.addOrUpdateTool("single", "custom_single", { value: 3 }, child);

		expect(stripAnsi(group.render(100).join("\n"))).toContain("call custom_single");
	});

	test("propagates child-driven invalidation through a cached chat prefix", () => {
		const chat = new StaticPrefixContainer();
		const group = new ToolExecutionGroupComponent({ showImages: true });
		let rendererInvalidate: (() => void) | undefined;
		const toolDefinition = definition("custom_async");
		toolDefinition.renderCall = (_args, _theme, context) => {
			rendererInvalidate = context.invalidate;
			return new Text("async renderer", 0, 0);
		};
		const child = new ToolExecutionComponent(
			"custom_async",
			"async",
			{ value: 1 },
			{},
			toolDefinition,
			fakeTui(),
			process.cwd(),
		);
		const renderSpy = vi.spyOn(child, "render");
		group.addOrUpdateTool("async", "custom_async", { value: 1 }, child);
		group.setRenderInvalidationListener(() => chat.invalidateChild(group));
		chat.addChild(group);

		chat.render(100);
		const cached = chat.render(100);
		expect(renderSpy).toHaveBeenCalledTimes(1);

		expect(rendererInvalidate).toBeDefined();
		rendererInvalidate?.();
		const updated = chat.render(100);
		expect(updated).not.toBe(cached);
		expect(renderSpy).toHaveBeenCalledTimes(2);
	});

	test("reuses rendered output until state, width, or theme invalidation changes", () => {
		const group = new ToolExecutionGroupComponent({ showImages: true });
		const child = component("custom_cached", "cached", { value: 1 });
		const renderSpy = vi.spyOn(child, "render");
		group.addOrUpdateTool("cached", "custom_cached", { value: 1 }, child);

		const first = group.render(100);
		expect(group.render(100)).toBe(first);
		expect(renderSpy).toHaveBeenCalledTimes(1);

		child.invalidate();
		group.render(100);
		expect(renderSpy).toHaveBeenCalledTimes(2);

		group.setArgsComplete("cached");
		group.render(100);
		expect(renderSpy).toHaveBeenCalledTimes(3);

		group.updateResult("cached", { content: [{ type: "text", text: "done" }], isError: false }, false);
		group.render(100);
		expect(renderSpy).toHaveBeenCalledTimes(4);

		group.render(80);
		expect(renderSpy).toHaveBeenCalledTimes(5);
		group.invalidate();
		group.render(80);
		expect(renderSpy).toHaveBeenCalledTimes(6);
	});
});
