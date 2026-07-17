import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { getResolvedThemeColors, loadThemeFromPath } from "../src/modes/interactive/theme/theme.ts";

type ThemeFile = {
	name: string;
	vars?: Record<string, string | number>;
	colors: Record<string, string | number>;
};

function loadDarkTheme(): ThemeFile {
	return JSON.parse(
		readFileSync(new URL("../src/modes/interactive/theme/dark.json", import.meta.url), "utf-8"),
	) as ThemeFile;
}

describe("thinkingMax fallback for legacy themes (CU-013)", () => {
	let tempRoot: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-theme-thinkingmax-"));
		previousAgentDir = process.env[ENV_AGENT_DIR];
		const agentDir = join(tempRoot, "agent");
		process.env[ENV_AGENT_DIR] = agentDir;
		mkdirSync(join(agentDir, "themes"), { recursive: true });
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
		if (previousAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = previousAgentDir;
		}
	});

	it("loads a legacy theme without thinkingMax and falls back to thinkingXhigh", () => {
		const dark = loadDarkTheme();
		const { thinkingMax: _omitted, ...colorsWithoutMax } = dark.colors;
		const legacyTheme: ThemeFile = {
			...dark,
			name: "legacy-without-max",
			colors: colorsWithoutMax,
		};

		const themePath = join(process.env[ENV_AGENT_DIR]!, "themes", "legacy-without-max.json");
		writeFileSync(themePath, JSON.stringify(legacyTheme, null, 2));

		// Must not throw despite the missing token (schema now optional).
		const theme = loadThemeFromPath(themePath);
		const maxBorder = theme.getThinkingBorderColor("max");
		const xhighBorder = theme.getThinkingBorderColor("xhigh");

		// Missing thinkingMax resolves to the xhigh color.
		expect(maxBorder("test")).toBe(xhighBorder("test"));
	});

	it("uses the explicit thinkingMax value when provided", () => {
		const dark = loadDarkTheme();
		const modernTheme: ThemeFile = {
			...dark,
			name: "modern-with-max",
			colors: { ...dark.colors, thinkingMax: "#ff00ff", thinkingXhigh: "#d183e8" },
		};

		const themePath = join(process.env[ENV_AGENT_DIR]!, "themes", "modern-with-max.json");
		writeFileSync(themePath, JSON.stringify(modernTheme, null, 2));

		const theme = loadThemeFromPath(themePath);
		const maxBorder = theme.getThinkingBorderColor("max");
		const xhighBorder = theme.getThinkingBorderColor("xhigh");

		// Distinct explicit values must not collapse to the fallback.
		expect(maxBorder("test")).not.toBe(xhighBorder("test"));
		expect(maxBorder("test")).toContain("test");
	});

	it("applies the fallback to HTML export colors for legacy themes", () => {
		const dark = loadDarkTheme();
		const { thinkingMax: _omitted, ...colorsWithoutMax } = dark.colors;
		const legacyTheme: ThemeFile = {
			...dark,
			name: "legacy-export",
			colors: colorsWithoutMax,
		};

		writeFileSync(
			join(process.env[ENV_AGENT_DIR]!, "themes", "legacy-export.json"),
			JSON.stringify(legacyTheme, null, 2),
		);

		const colors = getResolvedThemeColors("legacy-export");
		expect(colors.thinkingMax).toBeDefined();
		expect(colors.thinkingMax).toBe(colors.thinkingXhigh);
	});

	it("built-in dark and light themes ship an explicit thinkingMax", () => {
		const dark = loadDarkTheme();
		const light = JSON.parse(
			readFileSync(new URL("../src/modes/interactive/theme/light.json", import.meta.url), "utf-8"),
		) as ThemeFile;

		expect(dark.colors.thinkingMax).toBeDefined();
		expect(light.colors.thinkingMax).toBeDefined();
		// Built-ins intentionally distinguish max from xhigh.
		expect(dark.colors.thinkingMax).not.toBe(dark.colors.thinkingXhigh);
		expect(light.colors.thinkingMax).not.toBe(light.colors.thinkingXhigh);
	});
});
