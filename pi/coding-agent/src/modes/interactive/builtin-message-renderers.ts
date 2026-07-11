/**
 * Built-in message renderers for custom message types.
 * Loaded as an internal extension during interactive mode initialization.
 */

import type { Extension, MessageRenderer } from "../../core/extensions/types.ts";
import { bgShellReturnRenderer } from "./components/bg-shell-return-renderer.ts";
import { subAgentReturnRenderer } from "./components/sub-agent-return-renderer.ts";

export function createBuiltInMessageRenderersExtension(): Extension {
	return {
		path: "<builtin-message-renderers>",
		resolvedPath: "<builtin-message-renderers>",
		sourceInfo: {
			scope: "user",
			source: "builtin",
			origin: "top-level",
			path: "<builtin-message-renderers>",
		},
		handlers: new Map(),
		tools: new Map(),
		messageRenderers: new Map([
			["bg-shell-return", bgShellReturnRenderer as MessageRenderer],
			["sub-agent-return", subAgentReturnRenderer as MessageRenderer],
		]),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}
