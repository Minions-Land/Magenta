import type { Component } from "@earendil-works/pi-tui";
import { Container } from "@earendil-works/pi-tui";
import { getTextOutput as getRenderedTextOutput } from "../../../core/tools/render-utils.ts";
import {
	renderToolCallActivity,
	renderToolCallGallery,
	type ToolCallTile,
	type ToolTileStatus,
} from "./tool-call-gallery.ts";
import type { ToolExecutionComponent } from "./tool-execution.ts";

type ToolResultLike = {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: unknown;
	isError: boolean;
};

interface ToolEntry {
	id: string;
	name: string;
	args: unknown;
	component: ToolExecutionComponent;
	status: ToolTileStatus;
	result?: ToolResultLike;
	sortIndex: number;
}

export class ToolExecutionGroupComponent extends Container {
	private readonly entries = new Map<string, ToolEntry>();
	private expanded = false;
	private showImages: boolean;

	constructor(options: { showImages: boolean }) {
		super();
		this.showImages = options.showImages;
	}

	addOrUpdateTool(id: string, name: string, args: unknown, component: ToolExecutionComponent): void {
		const existing = this.entries.get(id);
		if (existing) {
			existing.name = name;
			existing.args = args;
			existing.component = component;
			existing.component.updateArgs(args);
			if (existing.status === "success" || existing.status === "error") {
				existing.status = existing.result?.isError ? "error" : "success";
			}
			return;
		}
		this.entries.set(id, {
			id,
			name,
			args,
			component,
			status: "pending",
			sortIndex: this.entries.size,
		});
	}

	markExecutionStarted(id: string): void {
		const entry = this.entries.get(id);
		if (entry) entry.status = "running";
	}

	updateResult(id: string, result: ToolResultLike, isPartial: boolean): void {
		const entry = this.entries.get(id);
		if (!entry) return;
		entry.result = result;
		entry.status = isPartial ? "running" : result.isError ? "error" : "success";
		entry.component.updateResult(result, isPartial);
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		for (const entry of this.entries.values()) {
			entry.component.setExpanded(expanded);
		}
	}

	setShowImages(show: boolean): void {
		this.showImages = show;
		for (const entry of this.entries.values()) {
			entry.component.setShowImages(show);
		}
	}

	setImageWidthCells(width: number): void {
		for (const entry of this.entries.values()) {
			entry.component.setImageWidthCells(width);
		}
	}

	get size(): number {
		return this.entries.size;
	}

	private tiles(): ToolCallTile[] {
		return [...this.entries.values()].map((entry) => ({
			id: entry.id,
			name: entry.name,
			args: entry.args,
			status: entry.status,
			output: getRenderedTextOutput(entry.result, this.showImages),
			sortIndex: entry.sortIndex,
		}));
	}

	override render(width: number): string[] {
		const tiles = this.tiles();
		if (tiles.length === 0) return [];
		if (!this.expanded) {
			if (tiles.length === 1) return this.singleComponent()?.render(width) ?? [];
			return ["", ...renderToolCallActivity(tiles, width, { maxRows: 8, hint: "Ctrl+O gallery" })];
		}
		const lines = ["", ...renderToolCallGallery(tiles, width, { maxHeight: 16 })];
		for (const entry of [...this.entries.values()].sort((a, b) => a.sortIndex - b.sortIndex)) {
			lines.push(...entry.component.render(width));
		}
		return lines;
	}

	private singleComponent(): Component | undefined {
		return this.entries.values().next().value?.component;
	}
}
