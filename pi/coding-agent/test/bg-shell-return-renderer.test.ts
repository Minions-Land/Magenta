import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { MessageRenderer } from "../src/core/extensions/types.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import type { BackgroundShellEventSnapshot } from "../src/core/tools/bg-shell.ts";
import {
	type BgShellReturnDetails,
	bgShellReturnRenderer,
} from "../src/modes/interactive/components/bg-shell-return-renderer.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

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

	function createMessage(event: BackgroundShellEventSnapshot = eventData): CustomMessage<BgShellReturnDetails> {
		const content = [
			"Tests finished. Continue the original task.",
			"",
			`Event: ${event.id}${event.label ? ` (${event.label})` : ""}`,
			`Status: ${event.status}`,
			`Command: ${event.command}`,
			`CWD: ${event.cwd}`,
			"Elapsed: 2s",
			`Exit code: ${event.exitCode ?? "n/a"}`,
			`Signal: ${event.signal ?? "n/a"}`,
			`Log: ${event.logPath}`,
			...(event.error ? [`Error: ${event.error}`] : []),
			"",
			"Output:",
			event.tail,
		].join("\n");
		return {
			role: "custom",
			customType: "bg-shell-return",
			content,
			display: true,
			timestamp: Date.now(),
			details: {
				id: event.id,
				status: event.status,
				exitCode: event.exitCode,
				logPath: event.logPath,
				instruction: "Tests finished. Continue the original task.",
				eventData: event,
			},
		};
	}

	function render(message: CustomMessage<BgShellReturnDetails>, expanded: boolean, width = 120): string {
		return stripAnsi(bgShellReturnRenderer(message, { expanded }, theme).render(width).join("\n"));
	}

	it("keeps short eventData sections visible without a false hidden hint", () => {
		const text = render(createMessage(), false);
		expect(text).toContain("[bg-shell-return]");
		expect(text).toContain("Event: bg_001 (tests)");
		expect(text).toContain("Status: exited");
		expect(text).toContain("Exit code: 0");
		expect(text).toContain("Command: npm test");
		expect(text).toContain("suite one passed");
		expect(text).toContain("suite two passed");
		expect(text).not.toContain("hidden");
		expect(text).not.toContain("Tests finished");
	});

	it("caps every long section at two content lines with accurate hints", () => {
		const event: BackgroundShellEventSnapshot = {
			...eventData,
			status: "failed",
			exitCode: 2,
			command: "run first command line\ncommand line two\ncommand line three\ncommand line four",
			error: "failure one\nfailure two\nfailure three",
			tail: "output one\noutput two\noutput three\noutput four",
		};
		const text = render(createMessage(event), false);

		expect(text).toContain("Status: failed");
		expect(text).toContain("Exit code: 2");
		expect(text).toContain("Command: run first command line");
		expect(text).toContain("command line two");
		expect(text).not.toContain("command line three");
		expect(text).toContain("output one");
		expect(text).toContain("output two");
		expect(text).not.toContain("output three");
		expect(text.match(/\.\.\. 2 lines hidden \(ctrl\+o to expand\)/g)).toHaveLength(2);
		expect(text).toContain("... 1 line hidden (ctrl+o to expand)");
	});

	it("keeps header-shaped output lines inside the Output section", () => {
		const event = {
			...eventData,
			tail: "output one\nError: emitted by command\nStatus: still command output\noutput four",
		};
		const collapsed = render(createMessage(event), false);
		expect(collapsed).toContain("Error: emitted by command");
		expect(collapsed).not.toContain("Status: still command output");
		expect(collapsed).not.toContain("output four");
		expect(collapsed).toContain("... 2 lines hidden (ctrl+o to expand)");
	});

	it("expands eventData from its snapshot without exposing the model instruction", () => {
		const event: BackgroundShellEventSnapshot = {
			...eventData,
			command: "line one\nline two\nline three",
			tail: "result one\nresult two\nresult three",
		};
		const text = render(createMessage(event), true);
		expect(text).toContain("line three");
		expect(text).toContain("result three");
		expect(text).toContain("Log: /tmp/bg_001.log");
		expect(text).not.toContain("hidden");
		expect(text).not.toContain("Tests finished. Continue the original task.");
	});

	it("projects a real legacy payload without eventData and expands it losslessly", () => {
		const content = [
			"Background shell event has completed.",
			"Continue the original task.",
			"Do not ask the user to inspect the event id.",
			"",
			"Event: bg_009 (legacy)",
			"Status: exited",
			"Command: legacy command one",
			"legacy command two",
			"legacy command three",
			"CWD: /tmp/legacy",
			"Elapsed: 4s",
			"Exit code: 0",
			"Signal: n/a",
			"Log: /tmp/bg_009.log",
			"",
			"Output:",
			"legacy output one",
			"legacy output two",
			"legacy output three",
		].join("\n");
		const legacy: CustomMessage<BgShellReturnDetails> = {
			role: "custom",
			customType: "bg-shell-return",
			content,
			display: true,
			timestamp: Date.now(),
			details: undefined,
		};

		const collapsed = render(legacy, false);
		expect(collapsed).toContain("Event: bg_009 (legacy)");
		expect(collapsed).toContain("Exit code: 0");
		expect(collapsed).not.toContain("legacy command three");
		expect(collapsed).not.toContain("legacy output three");
		expect(collapsed).toContain("Continue the original task");
		expect(collapsed).not.toContain("Do not ask the user");

		const expanded = render(legacy, true);
		expect(expanded).toContain("legacy command three");
		expect(expanded).toContain("legacy output three");
		expect(expanded).toContain("Do not ask the user to inspect the event id.");
		expect(expanded).not.toContain("hidden");
	});

	it("counts terminal-wrapped lines at narrow widths", () => {
		const command = "echo alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
		const legacy: CustomMessage<BgShellReturnDetails> = {
			role: "custom",
			customType: "bg-shell-return",
			content: `Event: bg_narrow\nStatus: exited\nCommand: ${command}\nExit code: 0\nOutput:\nok`,
			display: true,
			timestamp: Date.now(),
			details: undefined,
		};
		const width = 36;
		const sectionWidth = width - 2;
		const wrappedLines = wrapTextWithAnsi(`Command: ${command}`, sectionWidth).length;
		const expectedHidden = wrappedLines - 2;
		const text = render(legacy, false, width);

		expect(expectedHidden).toBeGreaterThan(0);
		expect(text).toContain(`... ${expectedHidden} ${expectedHidden === 1 ? "line" : "lines"} hidden`);
		expect(render(legacy, true, width)).toContain("lambda mu");
	});

	it("roundtrips the whole return through CustomMessageComponent expansion", () => {
		const event = { ...eventData, tail: "one\ntwo\nthree\nfour" };
		const component = new CustomMessageComponent(createMessage(event), bgShellReturnRenderer as MessageRenderer);
		const output = () => stripAnsi(component.render(100).join("\n"));

		component.setExpanded(false);
		expect(output()).not.toContain("four");
		component.setExpanded(true);
		expect(output()).toContain("four");
		component.setExpanded(false);
		expect(output()).not.toContain("four");
		expect(output()).toContain("ctrl+o to expand");
	});
});
