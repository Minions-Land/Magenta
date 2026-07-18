/**
 * Message Renderer via central registry — demonstrates the unified renderer
 * registry path for custom message types.
 *
 * Where `message-renderer.ts` uses the high-level `pi.registerMessageRenderer`
 * extension API, this example shows the same idea from the perspective of the
 * central `renderer-registry` module that both tool and message renderers now
 * share. The registry lookup (`getMessageRenderer(type)`) is consulted by the
 * interactive renderer before falling back to per-extension renderers, so a
 * renderer registered here behaves identically to a built-in one.
 *
 * A third-party extension normally registers via `pi.registerMessageRenderer`
 * (the public, sandbox-safe API). We use it here for the "demo-custom-message"
 * type; the value flows into the same registry the core reads from.
 *
 * Usage:
 *   pi -e ./message-renderer-registry.ts
 *   then run: /demo-msg hello world
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Spacer, Text } from "@earendil-works/pi-tui";

const DEMO_MESSAGE_TYPE = "demo-custom-message";

export default function (pi: ExtensionAPI) {
	// Register a renderer for our custom message type. Under the hood this lands
	// in the same registry that `getMessageRenderer("demo-custom-message")`
	// reads from in interactive mode.
	pi.registerMessageRenderer(DEMO_MESSAGE_TYPE, (message, { expanded }, theme) => {
		const details = message.details as { count?: number; createdAt?: number } | undefined;

		const content =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n");

		const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(theme.fg("customMessageLabel", theme.bold("[demo]")), 0, 0));
		box.addChild(new Spacer(1));
		box.addChild(new Text(theme.fg("customMessageText", content), 0, 0));

		// Extra detail only when the user expands (ctrl+o).
		if (expanded && details) {
			const meta: string[] = [];
			if (details.count !== undefined) meta.push(`count=${details.count}`);
			if (details.createdAt) meta.push(`at ${new Date(details.createdAt).toLocaleTimeString()}`);
			if (meta.length > 0) {
				box.addChild(new Spacer(1));
				box.addChild(new Text(theme.fg("dim", meta.join("  ")), 0, 0));
			}
		}

		return box;
	});

	let count = 0;

	pi.registerCommand("demo-msg", {
		description: "Send a demo custom message rendered via the renderer registry",
		handler: async (args, _ctx) => {
			count += 1;
			pi.sendMessage({
				customType: DEMO_MESSAGE_TYPE,
				content: args.trim() || "Hello from the renderer registry demo",
				display: true,
				details: { count, createdAt: Date.now() },
			});
		},
	});
}
