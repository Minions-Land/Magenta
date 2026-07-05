import { describe, expect, it } from "vitest";
import { parseCodexBaseUrl, parseCodexModel } from "../src/core/external-auth-loader.ts";

describe("parseCodexBaseUrl", () => {
	it("resolves base_url from the active model_provider section", () => {
		// Mirrors a real config.toml where base_url lives in [model_providers.custom]
		// and is followed by many unrelated [projects.*] tables.
		const toml = `model_provider = "custom"
model = "gpt-5.5"
model_reasoning_effort = "xhigh"

[projects."/Users/mjm/foo"]
trust_level = "trusted"

[model_providers.custom]
name = "custom"
wire_api = "responses"
base_url = "https://tok.fan/v1"

[projects."/Users/mjm/bar"]
trust_level = "trusted"
`;
		expect(parseCodexBaseUrl(toml)).toBe("https://tok.fan/v1");
	});

	it("picks the active provider's base_url when multiple providers exist", () => {
		const toml = `model_provider = "second"

[model_providers.first]
base_url = "https://first.example/v1"

[model_providers.second]
base_url = "https://second.example/v1"
`;
		expect(parseCodexBaseUrl(toml)).toBe("https://second.example/v1");
	});

	it("falls back to the first base_url when model_provider is absent", () => {
		const toml = `[model_providers.only]
base_url = "https://only.example/v1"
`;
		expect(parseCodexBaseUrl(toml)).toBe("https://only.example/v1");
	});

	it("returns undefined when no base_url is present", () => {
		const toml = `model_provider = "custom"
model = "gpt-5.5"
`;
		expect(parseCodexBaseUrl(toml)).toBeUndefined();
	});

	it("does not leak a different provider's base_url when the active one lacks it", () => {
		// Active provider "custom" has no base_url; must not fall through to "other".
		// (Fallback only applies when model_provider is absent, so this returns undefined.)
		const toml = `model_provider = "custom"

[model_providers.custom]
name = "custom"

[model_providers.other]
base_url = "https://other.example/v1"
`;
		expect(parseCodexBaseUrl(toml)).toBeUndefined();
	});
});

describe("parseCodexModel", () => {
	it("reads a top-level model declaration", () => {
		const toml = `model_provider = "custom"
model = "gpt-5.5"

[model_providers.custom]
model = "should-not-win"
`;
		expect(parseCodexModel(toml)).toBe("gpt-5.5");
	});

	it("returns undefined when model is only inside a table", () => {
		const toml = `model_provider = "custom"

[model_providers.custom]
model = "inside-table"
`;
		expect(parseCodexModel(toml)).toBeUndefined();
	});
});
