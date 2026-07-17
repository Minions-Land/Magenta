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
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	const millions = count / 1000000;
	if (count < 100000000) return `${millions.toFixed(1).replace(/\.0$/, "")}M`;
	return `${Math.round(millions)}M`;
}

function knownNonNegative(value: number | null | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function fitGroupsToWidth(groups: string[], separator: string, width: number, ellipsis: string): string {
	if (groups.length === 0 || width <= 0) return "";

	const first = groups[0];
	const firstWidth = visibleWidth(first);
	if (firstWidth > width) return truncateToWidth(first, width, ellipsis);

	let result = first;
	let usedWidth = firstWidth;
	const separatorWidth = visibleWidth(separator);
	for (let i = 1; i < groups.length; i++) {
		const remainingWidth = width - usedWidth;
		if (remainingWidth <= separatorWidth) break;

		const group = groups[i];
		const groupWidth = visibleWidth(group);
		if (separatorWidth + groupWidth <= remainingWidth) {
			result += separator + group;
			usedWidth += separatorWidth + groupWidth;
			continue;
		}

		const availableGroupWidth = remainingWidth - separatorWidth;
		const truncatedGroup = truncateToWidth(group, availableGroupWidth, ellipsis);
		if (visibleWidth(truncatedGroup) > 0) result += separator + truncatedGroup;
		break;
	}
	return result;
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

		// Calculate the cumulative, token-weighted cache hit rate across persisted assistant entries.
		const totalPromptTokens = totalInput + totalCacheRead + totalCacheWrite;
		const avgCacheHitRate = totalPromptTokens > 0 ? (totalCacheRead / totalPromptTokens) * 100 : undefined;

		// Calculate context usage from session (handles compaction correctly).
		// After compaction, tokens are unknown until the next LLM response.
		const contextUsage = this.session.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const contextTokens = knownNonNegative(contextUsage?.tokens) ? contextUsage.tokens : undefined;
		const contextPercentValue = knownNonNegative(contextUsage?.percent) ? contextUsage.percent : undefined;

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

		// Build stats groups. Current context comes first so it stays visible on narrow
		// terminals; cumulative session usage is explicitly separated as "total".
		const statsGroups: string[] = [];
		if (contextWindow > 0) {
			const contextDetails: string[] = [];
			if (contextPercentValue !== undefined) contextDetails.push(`${contextPercentValue.toFixed(1)}%`);
			if (this.autoCompactEnabled) contextDetails.push("auto");
			let contextDisplay = `ctx ${contextTokens === undefined ? "?" : formatTokens(contextTokens)}/${formatTokens(contextWindow)}`;
			if (contextDetails.length > 0) contextDisplay += ` (${contextDetails.join(", ")})`;

			if (contextPercentValue !== undefined && contextPercentValue > 90) {
				contextDisplay = theme.fg("error", contextDisplay);
			} else if (contextPercentValue !== undefined && contextPercentValue > 70) {
				contextDisplay = theme.fg("warning", contextDisplay);
			} else {
				contextDisplay = theme.fg("dim", contextDisplay);
			}
			statsGroups.push(contextDisplay);
		}

		const totalParts: string[] = [];
		if (totalInput) totalParts.push(`↑${formatTokens(totalInput)}`);
		if (totalOutput) totalParts.push(`↓${formatTokens(totalOutput)}`);
		if (totalCacheRead) totalParts.push(`R${formatTokens(totalCacheRead)}`);
		if (totalCacheWrite) totalParts.push(`W${formatTokens(totalCacheWrite)}`);
		if ((totalCacheRead > 0 || totalCacheWrite > 0) && avgCacheHitRate !== undefined) {
			totalParts.push(`CH${avgCacheHitRate.toFixed(1)}%`);
		}

		// Show cost with "(sub)" indicator if using OAuth subscription.
		const usingSubscription = state.model ? this.session.modelRegistry.isUsingOAuth(state.model) : false;
		if (costUnknown) {
			totalParts.push("cost?");
		} else if (totalCost || usingSubscription) {
			totalParts.push(`$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
		}
		if (assistantMessageCount > 0) {
			totalParts.push(`${assistantMessageCount} call${assistantMessageCount === 1 ? "" : "s"}`);
		}
		if (totalParts.length > 0) statsGroups.push(theme.fg("dim", `total ${totalParts.join(" ")}`));

		if (areExperimentalFeaturesEnabled()) {
			statsGroups.push(`${theme.fg("dim", "•")} ${theme.bold(theme.fg("warning", "xp"))}`);
		}

		const groupSeparator = theme.fg("dim", " | ");
		let statsLeft = "";

		// Add model name on the right side, plus thinking level if model supports it.
		const modelName = state.model?.id || "no-model";
		const minPadding = 2;
		let rightSideWithoutProvider = modelName;
		if (state.model?.reasoning || this.session.executionProfile === "ultra") {
			const profile = this.session.executionProfile;
			rightSideWithoutProvider = profile === "off" ? `${modelName} • thinking off` : `${modelName} • ${profile}`;
		}

		// Provider is lower priority than the complete current-context group, but higher
		// priority than cumulative totals that can be truncated from the right.
		let rightSide = rightSideWithoutProvider;
		if (this.footerData.getAvailableProviderCount() > 1 && state.model) {
			const withProvider = `(${state.model.provider}) ${rightSideWithoutProvider}`;
			const criticalStatsWidth = visibleWidth(statsGroups[0] ?? "");
			if (criticalStatsWidth + minPadding + visibleWidth(withProvider) <= width) {
				rightSide = withProvider;
			}
		}

		let rightSideWidth = visibleWidth(rightSide);
		if (rightSideWidth > width) {
			rightSide = truncateToWidth(rightSide, width, "");
			rightSideWidth = visibleWidth(rightSide);
			statsLeft = "";
		} else {
			const maxStatsWidth = Math.max(0, width - rightSideWidth - minPadding);
			statsLeft = fitGroupsToWidth(statsGroups, groupSeparator, maxStatsWidth, theme.fg("dim", "..."));
		}

		const statsLeftWidth = visibleWidth(statsLeft);
		const padding = " ".repeat(Math.max(0, width - statsLeftWidth - rightSideWidth));
		const statsLine = statsLeft + padding + rightSide;

		// Stats groups already carry their final colors; only the padding/model remainder
		// needs the default dim styling.
		const dimStatsLeft = statsLeft;
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
