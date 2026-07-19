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
	private revision = 0;
	private cachedRender: { width: number; revision: number; lines: string[] } | undefined;
	private renderInvalidationListener: (() => void) | undefined;
	private readonly handleChildInvalidation = () => this.markDirty();

	constructor(options: { showImages: boolean }) {
		super();
		this.showImages = options.showImages;
	}

	setRenderInvalidationListener(listener: (() => void) | undefined): void {
		this.renderInvalidationListener = listener;
	}

	private markDirty(): void {
		this.revision += 1;
		this.cachedRender = undefined;
		this.renderInvalidationListener?.();
	}

	override invalidate(): void {
		for (const entry of this.entries.values()) entry.component.invalidate();
	}

	addOrUpdateTool(id: string, name: string, args: unknown, component: ToolExecutionComponent): void {
		const existing = this.entries.get(id);
		if (existing) {
			existing.name = name;
			existing.args = args;
			if (existing.component !== component) existing.component.setRenderInvalidationListener(undefined);
			existing.component = component;
			existing.component.setRenderInvalidationListener(this.handleChildInvalidation);
			existing.component.updateArgs(args);
			if (existing.status === "success" || existing.status === "error") {
				existing.status = existing.result?.isError ? "error" : "success";
			}
			return;
		}
		component.setRenderInvalidationListener(this.handleChildInvalidation);
		// A newly added tool inherits the group's current expansion so an expanded
		// gallery never contains a stray collapsed detail.
		component.setExpanded(this.expanded);
		this.entries.set(id, {
			id,
			name,
			args,
			component,
			status: "pending",
			sortIndex: this.entries.size,
		});
		this.markDirty();
	}

	markExecutionStarted(id: string): void {
		const entry = this.entries.get(id);
		if (entry) {
			entry.status = "running";
			this.markDirty();
		}
	}

	setArgsComplete(id: string): void {
		const entry = this.entries.get(id);
		if (!entry) return;
		entry.component.setArgsComplete();
	}

	updateResult(id: string, result: ToolResultLike, isPartial: boolean): void {
		const entry = this.entries.get(id);
		if (!entry) return;
		entry.result = result;
		entry.status = isPartial ? "running" : result.isError ? "error" : "success";
		entry.component.updateResult(result, isPartial);
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
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
			provenance: entry.component.provenance,
		}));
	}

	override render(width: number): string[] {
		if (this.cachedRender?.width === width && this.cachedRender.revision === this.revision) {
			return this.cachedRender.lines;
		}
		const lines = this.renderUncached(width);
		this.cachedRender = { width, revision: this.revision, lines };
		return lines;
	}

	private renderUncached(width: number): string[] {
		const tiles = this.tiles();
		if (tiles.length === 0) return [];
		if (!this.expanded) {
			// A single tool call is batch=1: it flows through the same activity gallery
			// as multi-tool turns instead of a separate single-line path. This keeps one
			// rendering code path (single = batch of one) and a consistent visual frame.
			return ["", ...renderToolCallActivity(tiles, width, { maxRows: 8, hint: "Ctrl+o gallery" })];
		}
		const lines = ["", ...renderToolCallGallery(tiles, width, { maxHeight: 16 })];
		for (const entry of [...this.entries.values()].sort((a, b) => a.sortIndex - b.sortIndex)) {
			lines.push(...entry.component.render(width));
		}
		return lines;
	}
}
