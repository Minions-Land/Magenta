/**
 * Tool renderer registry —按数据形状(renderKind)注册渲染器,实现 1:N 复用。
 *
 * 渲染器是纯展示逻辑:读取 details 的结构化数据,产出 TUI 组件。harness 工具通过
 * manifest 声明 render_kind,pi 按 kind 匹配渲染器,不认识具体工具名。这样
 * server(harness)描述"我产出什么形状的数据",client(pi)决定"这种形状怎么画",
 * 符合 HCP 边界的 client/server 语义。
 */

import type { Component } from "@earendil-works/pi-tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolRenderContext } from "../extensions/types.ts";

/**
 * 工具渲染器契约。renderCall/renderResult 签名与 ToolDefinition 保持一致,
 * 这样可以直接从现有工具的渲染函数迁移过来。
 */
export interface ToolRenderer<TDetails = unknown> {
	/**
	 * 渲染工具调用(参数展示)。
	 * @param args - 工具调用参数
	 * @param theme - 当前主题
	 * @param context - 渲染上下文(包含 cwd、expanded、lastComponent 等)
	 * @returns TUI 组件
	 */
	renderCall?: (args: any, theme: Theme, context: ToolRenderContext) => Component;

	/**
	 * 渲染工具结果(输出展示)。
	 * @param result - 工具执行结果(content + details)
	 * @param options - 渲染选项(expanded、isPartial)
	 * @param theme - 当前主题
	 * @param context - 渲染上下文
	 * @returns TUI 组件
	 */
	renderResult?: (
		result: { content: any[]; details?: TDetails },
		options: { expanded: boolean; isPartial: boolean },
		theme: Theme,
		context: ToolRenderContext,
	) => Component;

	/**
	 * 渲染外壳类型:"default" 使用标准工具边框,"self" 表示渲染器自绘边框。
	 * 默认 "default"。
	 */
	renderShell?: "default" | "self";
}

/** 全局渲染器注册表:renderKind → ToolRenderer */
const renderers = new Map<string, ToolRenderer>();

/**
 * 注册一个渲染器。同一个 renderKind 注册多次,后者覆盖前者。
 * @param renderKind - 数据形状标识(如 "file-content"、"search-results")
 * @param renderer - 渲染器实现
 */
export function registerRenderer<TDetails = unknown>(renderKind: string, renderer: ToolRenderer<TDetails>): void {
	renderers.set(renderKind, renderer as ToolRenderer);
}

/**
 * 按 renderKind 查找渲染器。未找到返回 undefined,调用方回退到默认文本渲染。
 * @param renderKind - 数据形状标识
 * @returns 渲染器实现或 undefined
 */
export function getRenderer(renderKind: string | undefined): ToolRenderer | undefined {
	return renderKind ? renderers.get(renderKind) : undefined;
}

/**
 * 获取所有已注册的 renderKind 列表(调试用)。
 */
export function getRegisteredRenderKinds(): string[] {
	return Array.from(renderers.keys());
}
