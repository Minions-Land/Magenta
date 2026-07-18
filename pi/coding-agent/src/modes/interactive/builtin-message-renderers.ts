/**
 * Built-in message renderers for custom message types.
 * Registers into the central renderer-registry on module load, and also provides
 * an Extension for backward compatibility with the extension-runner lookup path.
 */

import type { Extension, MessageRenderer } from "../../core/extensions/types.ts";
import { registerMessageRenderer } from "../../core/tools/renderer-registry.ts";
import { bgShellReturnRenderer } from "./components/bg-shell-return-renderer.ts";
import { subAgentReturnRenderer } from "./components/sub-agent-return-renderer.ts";

// Register into the central renderer-registry for unified lookup.
// These registrations persist for the lifetime of the process.
registerMessageRenderer("bg-shell-return", bgShellReturnRenderer);
registerMessageRenderer("sub-agent-return", subAgentReturnRenderer);

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
