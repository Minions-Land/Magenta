import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type AuthSelectorProvider = { id: string; name: string; authType: "oauth" | "api_key" };

const deferProviderLogin = Reflect.get(InteractiveMode.prototype, "deferProviderLogin") as (
	this: { startProviderLogin: (option: AuthSelectorProvider) => Promise<void> },
	option: AuthSelectorProvider,
) => void;

describe("login menu focus handoff", () => {
	it("defers provider login until after the floating menu closes and releases focus", async () => {
		const startProviderLogin = vi.fn(async () => {});
		const option: AuthSelectorProvider = { id: "openai-codex", name: "OpenAI (ChatGPT Plus/Pro)", authType: "oauth" };

		deferProviderLogin.call({ startProviderLogin }, option);

		// The floating-menu wrapper runs its synchronous close-and-refocus after the
		// leaf callback returns; the login flow must not start before that.
		expect(startProviderLogin).not.toHaveBeenCalled();

		await Promise.resolve();

		expect(startProviderLogin).toHaveBeenCalledTimes(1);
		expect(startProviderLogin).toHaveBeenCalledWith(option);
	});
});
