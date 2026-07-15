import { describe, expect, it, vi } from "vitest";
import type { EventEntry } from "../src/core/background-events.ts";
import { EventsOverlay } from "../src/modes/interactive/components/events-overlay.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";

function createOverlay(entry: EventEntry): EventsOverlay {
	return new EventsOverlay(
		{ requestRender: vi.fn() },
		{ fg: (_color: string, text: string) => text } as Theme,
		vi.fn(),
		() => "all",
		vi.fn(),
		() => [entry],
		() => [entry.source.id],
		vi.fn(),
		vi.fn(),
	);
}

describe("EventsOverlay background attention state", () => {
	it("renders source telemetry only through the UI callback", () => {
		const getUiTelemetry = vi.fn(() => ({
			input: 462_000,
			output: 67_000,
			cacheRead: 30_000_000,
			cacheWrite: 51_000,
			cost: 19.504,
			contextUsage: { percent: 94.5, contextWindow: 372_000 },
			autoCompactEnabled: true,
			assistantMessages: 151,
		}));
		const entry: EventEntry = {
			key: "teammates:teammate_001",
			source: { id: "teammates", title: "teammates", getEvents: () => [], getUiTelemetry },
			event: {
				id: "teammate_001",
				status: "running",
				startedAt: Date.now(),
				label: "reviewer · active",
			},
		};

		const lines = createOverlay(entry).renderEntry(entry, true, 120);

		expect(lines.join("\n")).toContain("↑462k ↓67k R30M W51k CH98.3% $19.504 94.5%/372k (auto) 151 msgs");
		expect(getUiTelemetry).toHaveBeenCalledWith("teammate_001", expect.any(Function));
	});

	it("shows unknown cost and context without inventing missing fields", () => {
		const entry: EventEntry = {
			key: "teammates:teammate_001",
			source: {
				id: "teammates",
				title: "teammates",
				getEvents: () => [],
				getUiTelemetry: () => ({
					costUnknown: true,
					contextUsage: { percent: null, contextWindow: 200_000 },
					assistantMessages: 1,
				}),
			},
			event: { id: "teammate_001", status: "running", startedAt: Date.now(), label: "reviewer" },
		};

		expect(createOverlay(entry).renderEntry(entry, true, 100).join("\n")).toContain("cost? ?/200k 1 msg");
	});

	it("renders overdue and silent status without emitting notifications", () => {
		const notify = vi.fn();
		const entry: EventEntry = {
			key: "shell:bg_001",
			source: { id: "shell", title: "shell", getEvents: () => [] },
			event: {
				id: "bg_001",
				status: "running",
				startedAt: Date.now() - 10 * 60_000,
				label: "long build",
				expectedSeconds: 10,
				lastActivityAt: Date.now() - 10 * 60_000,
				activityPhase: "running",
				reminderEligible: true,
			},
		};
		const overlay = createOverlay(entry);
		overlay.notify = notify;

		const lines = overlay.renderEntry(entry, true, 100);

		expect(lines.join("\n")).toContain("overdue/silent");
		expect(notify).not.toHaveBeenCalled();
	});

	it("shows the current activity phase when expanded", () => {
		const entry: EventEntry = {
			key: "agents:agent_001",
			source: { id: "agents", title: "agents", getEvents: () => [] },
			event: {
				id: "agent_001",
				status: "running",
				startedAt: Date.now(),
				label: "review",
				activityPhase: "workflow:fan_out_synthesize",
			},
		};
		const overlay = createOverlay(entry);
		overlay.expandedKeys.add(entry.key);

		expect(overlay.renderEntry(entry, true, 100).join("\n")).toContain("phase: workflow:fan_out_synthesize");
	});
});
