/**
 * Central Overlay - 统一的中央浮动窗口抽象
 * 
 * 这是TUI中所有浮动窗口的唯一入口点。通过模板和配置系统，
 * 可以适配各种不同的内容类型（选择器、交互式对话、加载提示等）。
 */

import type { Component, Focusable, OverlayOptions, SizeValue } from "@earendil-works/pi-tui";
import type { FloatingOverlayBody } from "./floating-menu.ts";

/**
 * 中央浮动窗口的预设类型
 */
export type CentralOverlayType = 
	| "selector"      // 选择器类型（Session, Settings, Model等）
	| "interactive"   // 交互式内容（Side Chat等）
	| "message"       // 简单消息/加载提示
	| "custom";       // 自定义

/**
 * 中央浮动窗口的尺寸预设
 */
export type CentralOverlaySize = 
	| "small"   // 小窗口，用于简单消息
	| "medium"  // 中等窗口，用于设置选择器
	| "large"   // 大窗口，用于复杂选择器和交互
	| "xlarge"; // 超大窗口，用于需要更多空间的内容

/**
 * 中央浮动窗口配置
 */
export interface CentralOverlayConfig {
	/** 窗口类型，决定默认的渲染模板 */
	type?: CentralOverlayType;
	
	/** 窗口尺寸预设 */
	size?: CentralOverlaySize;
	
	/** 是否自动移除组件内部边框（避免双层边框） */
	removeBorder?: boolean;
	
	/** 自定义宽度（覆盖size预设） */
	width?: SizeValue;
	
	/** 自定义最小宽度 */
	minWidth?: number;
	
	/** 自定义最大高度 */
	maxHeight?: SizeValue;
	
	/** 内容区域行数 */
	bodyLines?: number;
	
	/** 是否允许按 Q 键关闭 */
	closeOnQ?: boolean;
	
	/** 自定义 overlay 选项（完全覆盖） */
	overlayOptions?: OverlayOptions;
}

/**
 * 根据类型和尺寸获取默认配置
 */
export function getCentralOverlayDefaults(type: CentralOverlayType, size: CentralOverlaySize): Required<Pick<CentralOverlayConfig, 'width' | 'minWidth' | 'maxHeight' | 'bodyLines' | 'removeBorder' | 'closeOnQ'>> {
	// 尺寸预设
	const sizePresets: Record<CentralOverlaySize, { width: SizeValue; minWidth: number; maxHeight: SizeValue; bodyLines: number }> = {
		small: { width: "50%", minWidth: 40, maxHeight: "50%", bodyLines: 8 },
		medium: { width: "70%", minWidth: 60, maxHeight: "75%", bodyLines: 18 },
		large: { width: "82%", minWidth: 72, maxHeight: "88%", bodyLines: 24 },
		xlarge: { width: "90%", minWidth: 80, maxHeight: "92%", bodyLines: 30 },
	};
	
	// 类型特定的默认值
	const typeDefaults = {
		selector: { removeBorder: true, closeOnQ: false },
		interactive: { removeBorder: false, closeOnQ: false },
		message: { removeBorder: true, closeOnQ: true },
		custom: { removeBorder: false, closeOnQ: false },
	};
	
	return {
		...sizePresets[size],
		...typeDefaults[type],
	};
}

/**
 * 构建 OverlayOptions
 */
export function buildOverlayOptions(config: CentralOverlayConfig): OverlayOptions {
	if (config.overlayOptions) {
		return config.overlayOptions;
	}
	
	const type = config.type ?? "custom";
	const size = config.size ?? "large";
	const defaults = getCentralOverlayDefaults(type, size);
	
	return {
		anchor: "center",
		width: config.width ?? defaults.width,
		minWidth: config.minWidth ?? defaults.minWidth,
		maxHeight: config.maxHeight ?? defaults.maxHeight,
		margin: 1,
	};
}

/**
 * 移除组件渲染输出中的边框线
 * 检测并移除顶部和底部的边框字符
 */
export function stripComponentBorders(lines: string[]): string[] {
	if (lines.length === 0) return lines;
	
	// 常见的边框字符模式
	const borderPattern = /^[\s─═╭╮╰╯┌┐└┘├┤┬┴┼│║╞╡╟╢╤╥╦╧╨╩╪╫╬]*$/;
	
	let start = 0;
	let end = lines.length;
	
	// 跳过顶部边框（通常是前2行：顶部边框 + 标题行可能也有边框装饰）
	while (start < lines.length && borderPattern.test(lines[start] ?? "")) {
		start++;
	}
	
	// 跳过顶部的空行
	while (start < lines.length && (lines[start] ?? "").trim() === "") {
		start++;
	}
	
	// 跳过底部边框
	while (end > start && borderPattern.test(lines[end - 1] ?? "")) {
		end--;
	}
	
	// 跳过底部的空行
	while (end > start && (lines[end - 1] ?? "").trim() === "") {
		end--;
	}
	
	return lines.slice(start, end);
}

/**
 * 创建适配器，将任意 Component 包装为 FloatingOverlayBody
 */
export function createCentralOverlayAdapter(
	component: Component,
	focus: Component,
	config: CentralOverlayConfig,
): FloatingOverlayBody {
	const type = config.type ?? "custom";
	const size = config.size ?? "large";
	const defaults = getCentralOverlayDefaults(type, size);
	const removeBorder = config.removeBorder ?? defaults.removeBorder;
	const closeOnQ = config.closeOnQ ?? defaults.closeOnQ;
	const bodyLines = config.bodyLines ?? defaults.bodyLines;
	
	return {
		closeOnQ,
		
		handleInput: (data: string) => {
			// 转发输入到焦点组件
			if (focus && 'handleInput' in focus && typeof (focus as any).handleInput === 'function') {
				(focus as any).handleInput(data);
				return true;
			}
			return undefined;
		},
		
		render: (width: number, height: number, focused: boolean) => {
			// 更新焦点状态
			if ('focused' in focus) {
				(focus as any).focused = focused;
			}
			
			// 渲染组件
			let rendered = component.render(width);
			
			// 根据配置移除内部边框
			if (removeBorder) {
				rendered = stripComponentBorders(rendered);
			}
			
			// 适配高度：截取或填充到目标行数
			const maxLines = Math.min(bodyLines, height);
			const body = rendered.slice(0, maxLines);
			
			// 填充空行到目标高度（保持窗口稳定）
			while (body.length < maxLines) {
				body.push("");
			}
			
			return {
				title: "",
				body,
			};
		},
		
		invalidate: () => {
			if ('invalidate' in component && typeof (component as any).invalidate === 'function') {
				(component as any).invalidate();
			}
		},
	};
}

/**
 * 为 Focusable 组件初始化焦点状态
 */
export function initializeFocus(focus: Component): void {
	if ('focused' in focus) {
		(focus as any).focused = true;
	}
}
