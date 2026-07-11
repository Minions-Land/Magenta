import { beforeAll, describe, expect, it } from "vitest";
import type { CustomMessage } from "../src/core/messages.ts";
import type { BackgroundShellEventSnapshot } from "../src/core/tools/bg-shell.ts";
import {
	type BgShellReturnDetails,
	bgShellReturnRenderer,
} from "../src/modes/interactive/components/bg-shell-return-renderer.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

describe("bg-shell-return renderer", () => {
	beforeAll(() => initTheme("default"));

	const eventData: BackgroundShellEventSnapshot = {
		id: "bg_001",
		command: "npm test",
		cwd: "/tmp/project",
		label: "tests",
		logPath: "/tmp/bg_001.log",
		startedAt: 1_000,
		endedAt: 3_000,
		status: "exited",
		exitCode: 0,
		signal: null,
		tail: "suite one passed\nsuite two passed",
	};

	const message: CustomMessage<BgShellReturnDetails> = {
		role: "custom",
		customType: "bg-shell-return",
		content:
			"Tests finished.\n\nEvent: bg_001 (tests)\nStatus: exited\nCommand: npm test\nCWD: /tmp/project\nElapsed: 2s\nExit code: 0\nSignal: n/a\nLog: /tmp/bg_001.log\n\nOutput:\nsuite one passed\nsuite two passed",
		display: true,
		timestamp: Date.now(),
		details: {
			id: "bg_001",
			status: "exited",
			exitCode: 0,
			logPath: "/tmp/bg_001.log",
			instruction: "Tests finished.",
			eventData,
		},
	};

	it("shows one compact status line and an output hint by default", () => {
		const text = bgShellReturnRenderer(message, { expanded: false }, theme).render(100).join("\n");
		expect(text).toContain("Background job bg_001 (tests): exited (2s)");
		expect(text).toContain("2 output lines hidden");
		expect(text).not.toContain("Command: npm test");
		expect(text).not.toContain("suite one passed");
	});

	it("shows full metadata and output when expanded", () => {
		const text = bgShellReturnRenderer(message, { expanded: true }, theme).render(100).join("\n");
		expect(text).toContain("Command: npm test");
		expect(text).toContain("CWD: /tmp/project");
		expect(text).toContain("suite one passed");
		expect(text).not.toContain("hidden");
	});
});
