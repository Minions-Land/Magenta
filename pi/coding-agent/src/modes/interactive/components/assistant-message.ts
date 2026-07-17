import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { formatMessageUsageStats } from "./footer.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Normalize a text block that some models (e.g. gpt-5.6) emit for reasoning,
 * where the reasoning is delivered as a plain text block wrapped in literal
 * `<thinking>...</thinking>` tags instead of a proper thinking block. Such tags
 * would otherwise leak into the rendered output verbatim.
 *
 * Conservative by design: only a text block whose trimmed content STARTS with
 * `<thinking>` is treated as reasoning, so `<thinking>` appearing mid-text or
 * inside a fenced code example is left untouched. A block may split into a
 * leading thinking part plus any trailing normal text after `</thinking>`.
 */
export function normalizeThinkingTags(content: AssistantMessage["content"]): AssistantMessage["content"] {
	const normalized: AssistantMessage["content"] = [];
	for (const block of content) {
		if (block.type !== "text") {
			normalized.push(block);
			continue;
		}
		const trimmed = block.text.trimStart();
		if (!trimmed.startsWith("<thinking>")) {
			normalized.push(block);
			continue;
		}
		const afterOpen = trimmed.slice("<thinking>".length);
		const closeIndex = afterOpen.indexOf("</thinking>");
		if (closeIndex === -1) {
			// Streaming: closing tag not yet received. Whole block is reasoning.
			normalized.push({ type: "thinking", thinking: afterOpen });
			continue;
		}
		const thinkingText = afterOpen.slice(0, closeIndex);
		const trailing = afterOpen.slice(closeIndex + "</thinking>".length);
		normalized.push({ type: "thinking", thinking: thinkingText });
		if (trailing.trim()) {
			normalized.push({ type: "text", text: trailing });
		}
	}
	return normalized;
}

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private outputPad: number;
	private lastMessage?: AssistantMessage;
	private normalizedContent: AssistantMessage["content"] = [];
	private hasToolCalls = false;

	// Character-by-character animation state
	private targetTexts: string[] = []; // Target text for each content block
	private displayedTexts: string[] = []; // Currently displayed text for each block
	private displayedBlocks: (Markdown | Text | undefined)[] = []; // Component aligned with each animated block

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
			this.displayedTexts = [...this.targetTexts];
			this.renderContent();
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	updateContent(message: AssistantMessage): void {
		this.lastMessage = message;
		this.normalizedContent = normalizeThinkingTags(message.content);

		// Extract target texts from message content
		const newTargetTexts: string[] = [];
		for (const content of this.normalizedContent) {
			if (content.type === "text" && content.text.trim()) {
				newTargetTexts.push(content.text.trim());
			} else if (content.type === "thinking" && content.thinking.trim()) {
				newTargetTexts.push(content.thinking.trim());
			}
		}

		// Initialize displayedTexts if needed
		while (this.displayedTexts.length < newTargetTexts.length) {
			this.displayedTexts.push("");
		}

		// Update target texts
		this.targetTexts = newTargetTexts;

		// Check for tool calls
		this.hasToolCalls = this.normalizedContent.some((c) => c.type === "toolCall");

		// Render with current displayed texts
		this.renderContent();
	}

	/**
	 * Instantly display all remaining content (skip animation).
	 */
	finishAnimation(): void {
		for (let i = 0; i < this.targetTexts.length; i++) {
			this.displayedTexts[i] = this.targetTexts[i] || "";
		}
		this.renderContent();
	}

	/**
	 * Advance the character-by-character animation.
	 * Returns true if there's still more content to display.
	 */
	advance(): boolean {
		if (!this.lastMessage) return false;

		// Calculate total backlog
		let totalBacklog = 0;
		for (let i = 0; i < this.targetTexts.length; i++) {
			const target = this.targetTexts[i] || "";
			const displayed = this.displayedTexts[i] || "";
			totalBacklog += target.length - displayed.length;
		}

		if (totalBacklog === 0) return false;

		// Determine how many characters to advance based on backlog
		let charsToAdvance: number;
		if (totalBacklog < 10) {
			charsToAdvance = 1; // Slow typewriter
		} else if (totalBacklog < 50) {
			charsToAdvance = 3; // Medium speed
		} else if (totalBacklog < 200) {
			charsToAdvance = 8; // Fast
		} else {
			charsToAdvance = 20; // Very fast catchup
		}

		// Advance characters in the first incomplete block
		for (let i = 0; i < this.targetTexts.length; i++) {
			const target = this.targetTexts[i] || "";
			const displayed = this.displayedTexts[i] || "";
			if (displayed.length < target.length) {
				const hadVisibleContent = this.displayedTexts.some((text) => text.trim());
				const newLength = Math.min(displayed.length + charsToAdvance, target.length);
				this.displayedTexts[i] = target.slice(0, newLength);
				const hasVisibleContent = this.displayedTexts.some((text) => text.trim());
				if (hadVisibleContent !== hasVisibleContent || !this.updateDisplayedBlock(i)) {
					this.renderContent();
				}
				return true; // More content remains
			}
		}

		return false;
	}

	private updateDisplayedBlock(blockIndex: number): boolean {
		const component = this.displayedBlocks[blockIndex];
		if (!component) return false;
		if (component instanceof Markdown) {
			component.setText(this.displayedTexts[blockIndex] || "");
			return true;
		}
		// Hidden thinking blocks render a fixed label while their text advances.
		return component instanceof Text && this.hideThinkingBlock;
	}

	private renderContent(): void {
		if (!this.lastMessage) return;

		// Clear content container
		this.contentContainer.clear();
		this.displayedBlocks = [];

		const hasVisibleContent = this.displayedTexts.some((text) => text.trim());

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		// Render displayed content
		let blockIndex = 0;
		for (let i = 0; i < this.normalizedContent.length; i++) {
			const content = this.normalizedContent[i];
			if (content.type === "text" && content.text.trim()) {
				const displayedText = this.displayedTexts[blockIndex] || "";
				if (displayedText) {
					const md = new Markdown(displayedText, this.outputPad, 0, this.markdownTheme);
					this.contentContainer.addChild(md);
					this.displayedBlocks[blockIndex] = md;
				}
				blockIndex++;
			} else if (content.type === "thinking" && content.thinking.trim()) {
				const displayedText = this.displayedTexts[blockIndex] || "";
				const hasVisibleContentAfter = this.normalizedContent
					.slice(i + 1)
					.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

				if (this.hideThinkingBlock) {
					const label = new Text(theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)), 1, 0);
					this.contentContainer.addChild(label);
					this.displayedBlocks[blockIndex] = label;
					if (hasVisibleContentAfter) {
						this.contentContainer.addChild(new Spacer(1));
					}
				} else if (displayedText) {
					const md = new Markdown(displayedText, this.outputPad, 0, this.markdownTheme, {
						color: (text: string) => theme.fg("thinkingText", text),
						italic: true,
					});
					this.contentContainer.addChild(md);
					this.displayedBlocks[blockIndex] = md;
					if (hasVisibleContentAfter) {
						this.contentContainer.addChild(new Spacer(1));
					}
				}
				blockIndex++;
			}
		}

		// Show error/abort messages if no tool calls
		if (!this.hasToolCalls) {
			if (this.lastMessage.stopReason === "aborted") {
				const abortMessage =
					this.lastMessage.errorMessage && this.lastMessage.errorMessage !== "Request was aborted"
						? this.lastMessage.errorMessage
						: "Operation aborted";
				if (hasVisibleContent) {
					this.contentContainer.addChild(new Spacer(1));
				} else {
					this.contentContainer.addChild(new Spacer(1));
				}
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), 1, 0));
			} else if (this.lastMessage.stopReason === "error") {
				const errorMsg = this.lastMessage.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), 1, 0));
			}
		}

		// Add usage stats at the bottom if available
		if (this.lastMessage.usage) {
			const statsText = formatMessageUsageStats(this.lastMessage.usage);
			if (statsText) {
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("dim", statsText), 1, 0));
			}
		}
	}
}
