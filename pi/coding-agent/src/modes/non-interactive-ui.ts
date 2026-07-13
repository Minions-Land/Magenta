import type { ExtensionUIContext } from "../core/extensions/types.ts";
import { type Theme, theme } from "./interactive/theme/theme.ts";
import {
	HEADLESS_PROTOCOL_VERSION,
	type HeadlessUiEvent,
	type NonInteractiveUiPolicy,
} from "./headless-protocol.ts";

export class NonInteractiveUiError extends Error {
	readonly method: string;

	constructor(method: string) {
		super(`Extension UI method "${method}" is unavailable in non-interactive mode`);
		this.name = "NonInteractiveUiError";
		this.method = method;
	}
}

export function createNonInteractiveUiContext(options: {
	mode: "print" | "json";
	policy: NonInteractiveUiPolicy;
	onEvent: (event: HeadlessUiEvent) => void;
}): ExtensionUIContext {
	const report = (
		method: string,
		disposition: HeadlessUiEvent["disposition"],
		message = `Extension UI method "${method}" is unavailable in ${options.mode} mode`,
	): void => {
		options.onEvent({
			type: "non_interactive_ui",
			protocolVersion: HEADLESS_PROTOCOL_VERSION,
			mode: options.mode,
			method,
			disposition,
			message,
		});
	};

	const ignoredMethods = new Set<string>();

	const deny = <T>(method: string, fallback: T): T => {
		if (options.policy === "error") {
			report(method, "error");
			throw new NonInteractiveUiError(method);
		}
		report(method, "denied");
		return fallback;
	};

	const ignored = (method: string): void => {
		if (ignoredMethods.has(method)) return;
		ignoredMethods.add(method);
		report(method, "ignored");
	};

	return {
		select: async () => deny("select", undefined),
		confirm: async () => deny("confirm", false),
		input: async () => deny("input", undefined),
		notify: (message, type) =>
			report("notify", "reported", `Extension notification${type ? ` (${type})` : ""}: ${message}`),
		onTerminalInput: () => {
			ignored("onTerminalInput");
			return () => {};
		},
		setStatus: () => ignored("setStatus"),
		setWorkingMessage: () => ignored("setWorkingMessage"),
		setWorkingVisible: () => ignored("setWorkingVisible"),
		setWorkingIndicator: () => ignored("setWorkingIndicator"),
		setHiddenThinkingLabel: () => ignored("setHiddenThinkingLabel"),
		setWidget: () => ignored("setWidget"),
		setFooter: () => ignored("setFooter"),
		setHeader: () => ignored("setHeader"),
		setTitle: () => ignored("setTitle"),
		custom: async () => deny("custom", undefined as never),
		pasteToEditor: () => ignored("pasteToEditor"),
		setEditorText: () => ignored("setEditorText"),
		getEditorText: () => {
			ignored("getEditorText");
			return "";
		},
		editor: async () => deny("editor", undefined),
		addAutocompleteProvider: () => ignored("addAutocompleteProvider"),
		setEditorComponent: () => ignored("setEditorComponent"),
		getEditorComponent: () => {
			ignored("getEditorComponent");
			return undefined;
		},
		get theme() {
			return theme;
		},
		getAllThemes: () => {
			ignored("getAllThemes");
			return [];
		},
		getTheme: () => {
			ignored("getTheme");
			return undefined;
		},
		setTheme: (_nextTheme: string | Theme) => {
			ignored("setTheme");
			return { success: false, error: "UI not available" };
		},
		getToolsExpanded: () => {
			ignored("getToolsExpanded");
			return false;
		},
		setToolsExpanded: () => ignored("setToolsExpanded"),
	};
}
