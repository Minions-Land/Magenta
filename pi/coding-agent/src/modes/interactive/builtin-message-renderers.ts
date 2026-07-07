/**
 * Built-in message renderers for custom message types.
 * Loaded as an internal extension during interactive mode initialization.
 */

import type { ExtensionAPI } from "../../core/extensions/types.ts";
import type { SourceInfo } from "../../core/source-info.ts";
import { bgShellReturnRenderer } from "./components/bg-shell-return-renderer.ts";

export function createBuiltInMessageRenderersExtension(): {
	path: string;
	resolvedPath: string;
	sourceInfo: SourceInfo;
	handlers: Map<string, any[]>;
	tools: Map<string, any>;
	messageRenderers: Map<string, any>;
	commands: Map<string, any>;
	flags: Map<string, any>;
	shortcuts: Map<string, any>;
} {
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
		messageRenderers: new Map([["bg-shell-return", bgShellReturnRenderer]]),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}
