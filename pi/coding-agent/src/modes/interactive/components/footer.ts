import { isAbsolute, relative, resolve, sep } from "node:path";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import { areExperimentalFeaturesEnabled } from "../../../core/experimental.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { theme } from "../theme/theme.ts";

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text: string): string {
	// Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Format token counts for compact footer display.
 */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/**
 * Format usage stats for a single message (used by assistant message component).
 * Returns empty string if no significant usage data.
 */
export function formatMessageUsageStats(usage: {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number; unknown?: boolean };
}): string {
	const parts: string[] = [];

	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);

	// Calculate cache hit rate for this message
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	if ((usage.cacheRead > 0 || usage.cacheWrite > 0) && promptTokens > 0) {
		const hitRate = (usage.cacheRead / promptTokens) * 100;
		parts.push(`CH${hitRate.toFixed(1)}%`);
	}

	if (usage.cost.unknown) {
		parts.push("cost?");
	} else if (usage.cost.total > 0) {
		parts.push(`$${usage.cost.total.toFixed(3)}`);
	}

	return parts.length > 0 ? parts.join(" ") : "";
}

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

/**
 * Footer component that shows pwd, token stats, and context usage.
 * Computes token/context stats from session, gets git branch and extension statuses from provider.
 */
interface FooterUsageTotals {
	totalInput: number;
	totalOutput: number;
	totalCacheRead: number;
	totalCacheWrite: number;
	totalCost: number;
	costUnknown: boolean;
	assistantMessageCount: number;
}

export class FooterComponent implements Component {
	private autoCompactEnabled = true;
	private session: AgentSession;
	private footerData: ReadonlyFooterDataProvider;
	private usageCache: { sessionId: string; leafId: string | null; totals: FooterUsageTotals } | undefined;

	constructor(session: AgentSession, footerData: ReadonlyFooterDataProvider) {
		this.session = session;
		this.footerData = footerData;
	}

	setSession(session: AgentSession): void {
		this.session = session;
		this.usageCache = undefined;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	/** Git branch caching is handled by the provider; clear local usage aggregation. */
	invalidate(): void {
		this.usageCache = undefined;
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	private getUsageTotals(): FooterUsageTotals {
		const sessionId = this.session.sessionId;
		const leafId = this.session.sessionManager.getLeafId();
		if (this.usageCache?.sessionId === sessionId && this.usageCache.leafId === leafId) {
			return this.usageCache.totals;
		}

		const totals: FooterUsageTotals = {
			totalInput: 0,
			totalOutput: 0,
			totalCacheRead: 0,
			totalCacheWrite: 0,
			totalCost: 0,
			costUnknown: false,
			assistantMessageCount: 0,
		};
		for (const entry of this.session.sessionManager.getEntries()) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			totals.assistantMessageCount += 1;
			totals.totalInput += entry.message.usage.input;
			totals.totalOutput += entry.message.usage.output;
			totals.totalCacheRead += entry.message.usage.cacheRead;
			totals.totalCacheWrite += entry.message.usage.cacheWrite;
			if (entry.message.usage.cost.unknown) {
				totals.costUnknown = true;
			} else {
				totals.totalCost += entry.message.usage.cost.total;
			}
		}
		this.usageCache = { sessionId, leafId, totals };
		return totals;
	}

	render(width: number): string[] {
		const state = this.session.state;
		const {
			totalInput,
			totalOutput,
			totalCacheRead,
			totalCacheWrite,
			totalCost,
			costUnknown,
			assistantMessageCount,
		} = this.getUsageTotals();

		// Calculate average cache hit rate across all messages
		const totalPromptTokens = totalInput + totalCacheRead + totalCacheWrite;
		const avgCacheHitRate = totalPromptTokens > 0 ? (totalCacheRead / totalPromptTokens) * 100 : undefined;

		// Calculate context usage from session (handles compaction correctly).
		// After compaction, tokens are unknown until the next LLM response.
		const contextUsage = this.session.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

		// Replace home directory with ~
		let pwd = formatCwdForFooter(this.session.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);

		// Add git branch if available
		const branch = this.footerData.getGitBranch();
		if (branch) {
			pwd = `${pwd} (${branch})`;
		}

		// Add the session id so it is easy to read off and copy (peer messaging
		// addresses sessions by this id). Kept on the first line, right after the
		// cwd/branch, so it sits at a stable, selectable position.
		const sessionId = this.session.sessionId;
		if (sessionId) {
			pwd = `${pwd}  SessionID ${sessionId}`;
		}

		// Add session name if set
		const sessionName = this.session.sessionManager.getSessionName();
		if (sessionName) {
			pwd = `${pwd} • ${sessionName}`;
		}

		// Build stats line
		const statsParts = [];
		if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
		if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
		if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
		if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);
		if ((totalCacheRead > 0 || totalCacheWrite > 0) && avgCacheHitRate !== undefined) {
			statsParts.push(`CH${avgCacheHitRate.toFixed(1)}%`);
		}

		// Show cost with "(sub)" indicator if using OAuth subscription
		const usingSubscription = state.model ? this.session.modelRegistry.isUsingOAuth(state.model) : false;
		if (costUnknown) {
			statsParts.push("cost?");
		} else if (totalCost || usingSubscription) {
			const costStr = `$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`;
			statsParts.push(costStr);
		}

		// Colorize context percentage based on usage
		let contextPercentStr: string;
		const autoIndicator = this.autoCompactEnabled ? " (auto)" : "";
		const contextPercentDisplay =
			contextPercent === "?"
				? `?/${formatTokens(contextWindow)}${autoIndicator}`
				: `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
		if (contextPercentValue > 90) {
			contextPercentStr = theme.fg("error", contextPercentDisplay);
		} else if (contextPercentValue > 70) {
			contextPercentStr = theme.fg("warning", contextPercentDisplay);
		} else {
			contextPercentStr = contextPercentDisplay;
		}
		statsParts.push(contextPercentStr);
		if (areExperimentalFeaturesEnabled()) {
			statsParts.push(`${theme.fg("dim", "•")} ${theme.bold(theme.fg("warning", "xp"))}`);
		}

		// Add message count at the end
		if (assistantMessageCount > 0) {
			statsParts.push(`${assistantMessageCount} msg${assistantMessageCount === 1 ? "" : "s"}`);
		}

		let statsLeft = statsParts.join(" ");

		// Add model name on the right side, plus thinking level if model supports it
		const modelName = state.model?.id || "no-model";

		let statsLeftWidth = visibleWidth(statsLeft);

		// If statsLeft is too wide, truncate it
		if (statsLeftWidth > width) {
			statsLeft = truncateToWidth(statsLeft, width, "...");
			statsLeftWidth = visibleWidth(statsLeft);
		}

		// Calculate available space for padding (minimum 2 spaces between stats and model)
		const minPadding = 2;

		// Add thinking level indicator if model supports reasoning
		let rightSideWithoutProvider = modelName;
		if (state.model?.reasoning || this.session.executionProfile === "ultra") {
			const profile = this.session.executionProfile;
			rightSideWithoutProvider = profile === "off" ? `${modelName} • thinking off` : `${modelName} • ${profile}`;
		}

		// Prepend the provider in parentheses if there are multiple providers and there's enough room
		let rightSide = rightSideWithoutProvider;
		if (this.footerData.getAvailableProviderCount() > 1 && state.model) {
			rightSide = `(${state.model!.provider}) ${rightSideWithoutProvider}`;
			if (statsLeftWidth + minPadding + visibleWidth(rightSide) > width) {
				// Too wide, fall back
				rightSide = rightSideWithoutProvider;
			}
		}

		const rightSideWidth = visibleWidth(rightSide);
		const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;

		let statsLine: string;
		if (totalNeeded <= width) {
			// Both fit - add padding to right-align model
			const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
			statsLine = statsLeft + padding + rightSide;
		} else {
			// Need to truncate right side
			const availableForRight = width - statsLeftWidth - minPadding;
			if (availableForRight > 0) {
				const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
				const truncatedRightWidth = visibleWidth(truncatedRight);
				const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
				statsLine = statsLeft + padding + truncatedRight;
			} else {
				// Not enough space for right side at all
				statsLine = statsLeft;
			}
		}

		// Apply dim to each part separately. statsLeft may contain color codes (for context %)
		// that end with a reset, which would clear an outer dim wrapper. So we dim the parts
		// before and after the colored section independently.
		const dimStatsLeft = theme.fg("dim", statsLeft);
		const remainder = statsLine.slice(statsLeft.length); // padding + rightSide
		const dimRemainder = theme.fg("dim", remainder);

		const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
		const lines = [pwdLine, dimStatsLeft + dimRemainder];

		// Add extension statuses on a single line, sorted by key alphabetically
		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			const sortedStatuses = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			const statusLine = sortedStatuses.join(" ");
			// Truncate to terminal width with dim ellipsis for consistency with footer style
			lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
		}

		return lines;
	}
}
