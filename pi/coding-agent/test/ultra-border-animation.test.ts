import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type BorderEditor = { borderColor: (text: string) => string };

type UltraBorderTestMode = {
	runtimeHost: {
		session: {
			executionProfile: "ultra" | "high";
			thinkingLevel: "high";
		};
	};
	defaultEditor: BorderEditor;
	editor: BorderEditor;
	ui: { requestRender: () => void };
	isInitialized: boolean;
	isTuiActive: boolean;
	isShuttingDown: boolean;
	isBashMode: boolean;
	ultraBorderAnimationTimer: NodeJS.Timeout | undefined;
	ultraBorderAnimationPhase: number;
	updateEditorBorderColor(): void;
	stopUltraBorderAnimation(): void;
};

function createMode(): UltraBorderTestMode {
	initTheme("dark");
	const identity = (text: string) => text;
	const mode = Object.create(InteractiveMode.prototype) as UltraBorderTestMode;
	Object.assign(mode, {
		runtimeHost: { session: { executionProfile: "ultra", thinkingLevel: "high" } },
		defaultEditor: { borderColor: identity },
		editor: { borderColor: identity },
		ui: { requestRender: vi.fn() },
		isInitialized: true,
		isTuiActive: true,
		isShuttingDown: false,
		isBashMode: false,
		ultraBorderAnimationTimer: undefined,
		ultraBorderAnimationPhase: 0,
	});
	return mode;
}

describe("Ultra border animation lifecycle", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("moves the rainbow without changing width and stops outside Ultra", () => {
		vi.useFakeTimers();
		const mode = createMode();
		const requestRender = vi.mocked(mode.ui.requestRender);
		const border = "─".repeat(21);

		mode.updateEditorBorderColor();
		mode.updateEditorBorderColor();
		expect(vi.getTimerCount()).toBe(1);
		expect(mode.ultraBorderAnimationTimer?.hasRef()).toBe(false);

		const firstFrame = mode.defaultEditor.borderColor(border);
		vi.advanceTimersByTime(120);
		const secondFrame = mode.defaultEditor.borderColor(border);

		expect(secondFrame).not.toBe(firstFrame);
		expect(mode.editor.borderColor(border)).toBe(secondFrame);
		expect(visibleWidth(secondFrame)).toBe(21);
		expect(stripVTControlCharacters(secondFrame)).toBe(border);
		expect(requestRender).toHaveBeenCalledTimes(3);

		mode.isBashMode = true;
		mode.updateEditorBorderColor();
		expect(vi.getTimerCount()).toBe(0);
		const rendersAfterBash = requestRender.mock.calls.length;
		vi.advanceTimersByTime(480);
		expect(requestRender).toHaveBeenCalledTimes(rendersAfterBash);

		mode.isBashMode = false;
		mode.runtimeHost.session.executionProfile = "high";
		mode.updateEditorBorderColor();
		expect(vi.getTimerCount()).toBe(0);

		mode.runtimeHost.session.executionProfile = "ultra";
		mode.isTuiActive = false;
		mode.updateEditorBorderColor();
		expect(vi.getTimerCount()).toBe(0);

		mode.isTuiActive = true;
		mode.updateEditorBorderColor();
		expect(vi.getTimerCount()).toBe(1);
		mode.stopUltraBorderAnimation();
		expect(vi.getTimerCount()).toBe(0);
	});
});
