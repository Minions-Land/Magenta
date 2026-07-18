/**
 * Tool & Message renderer registry — 统一的展示层注册中心。
 *
 * ## Tool Renderers(按 renderKind 注册)
 * 渲染器是纯展示逻辑:读取 details 的结构化数据,产出 TUI 组件。harness 工具通过
 * manifest 声明 render_kind,pi 按 kind 匹配渲染器,不认识具体工具名。这样
 * server(harness)描述产出的数据形状,client(pi)决定怎么画,符合 HCP 边界。
 *   registerRenderer(kind, r) / getRenderer(kind) / getRegisteredRenderKinds()
 *
 * ## Message Renderers(按 messageType 注册)
 * 自定义消息(role=custom)的展示逻辑。内置渲染器(bg-shell-return、
 * sub-agent-return)与第三方扩展注册的渲染器共用同一张表,调用侧按
 * customType 查找,未命中回退到默认的 CustomMessageComponent 渲染。
 *   registerMessageRenderer(type, r) / getMessageRenderer(type) / getRegisteredMessageTypes()
 *
 * ## 生命周期
 * - 两张表都是模块级单例,进程内全局共享,注册后常驻到进程退出。
 * - 内置渲染器在交互模式初始化时注册;扩展渲染器在扩展加载时注册。
 * - 同名(kind / type)重复注册时后者覆盖前者。
 *
 * ## 如何新增渲染器
 * 工具渲染器:实现 ToolRenderer(renderCall / renderResult),调用 registerRenderer。
 * 消息渲染器:实现 MessageRenderer((message, options, theme) => Component | undefined),
 *   调用 registerMessageRenderer。返回 undefined 表示放弃,交给默认渲染。
 * 示例见 examples/extensions/message-renderer-registry.ts。
 */

import type { Component } from "@earendil-works/pi-tui";
import type { CustomMessage } from "../messages.ts";
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

// ============================================================================
// Message Renderer Registry
// ============================================================================

/**
 * 消息渲染器契约。接收消息对象、渲染选项和主题,返回 TUI 组件;
 * 返回 undefined 表示放弃自定义渲染,由调用方回退到默认渲染逻辑。
 * 与 extensions/types.ts 的 MessageRenderer 类型签名保持一致,
 * 这样扩展注册的渲染器可以直接进入本注册表。
 */
export interface MessageRenderer<T = unknown> {
	(message: CustomMessage<T>, options: { expanded: boolean }, theme: Theme): Component | undefined;
}

/** 全局消息渲染器注册表:messageType → MessageRenderer */
const messageRenderers = new Map<string, MessageRenderer>();

/**
 * 注册消息渲染器。同一个 messageType 注册多次,后者覆盖前者。
 * 供扩展注册自定义消息类型的渲染器,也供核心注册内置消息类型。
 * @param messageType - 消息类型标识(如 "bg-shell-return"、"sub-agent-return")
 * @param renderer - 渲染器实现
 */
export function registerMessageRenderer<T = unknown>(messageType: string, renderer: MessageRenderer<T>): void {
	messageRenderers.set(messageType, renderer as MessageRenderer);
}

/**
 * 按 messageType 查找渲染器。未找到返回 undefined,调用方回退到默认渲染。
 * @param messageType - 消息类型标识
 * @returns 渲染器实现或 undefined
 */
export function getMessageRenderer(messageType: string | undefined): MessageRenderer | undefined {
	return messageType ? messageRenderers.get(messageType) : undefined;
}

/**
 * 获取所有已注册的消息类型列表(调试用)。
 */
export function getRegisteredMessageTypes(): string[] {
	return Array.from(messageRenderers.keys());
}
