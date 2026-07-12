import { describe, expect, it } from "vitest";
import { HcpClientpackagetoolcommand } from "../tools/descriptor/package-tool.ts";

describe("Package tool platform command selection", () => {
	it("uses the matching platform override", () => {
		const descriptor = {
			command: "./bin/tool",
			command_windows: "./bin/tool.exe",
			command_macos: "./bin/tool-macos",
			command_linux: "./bin/tool-linux",
		};
		expect(HcpClientpackagetoolcommand(descriptor, "win32")).toBe("./bin/tool.exe");
		expect(HcpClientpackagetoolcommand(descriptor, "darwin")).toBe("./bin/tool-macos");
		expect(HcpClientpackagetoolcommand(descriptor, "linux")).toBe("./bin/tool-linux");
	});

	it("falls back to the portable command", () => {
		expect(HcpClientpackagetoolcommand({ command: "./bin/tool" }, "win32")).toBe("./bin/tool");
	});
});
