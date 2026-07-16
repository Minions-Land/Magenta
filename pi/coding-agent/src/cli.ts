#!/usr/bin/env node
/**
 * CLI entry point for the refactored coding agent.
 * Uses main.ts with AgentSession and new mode modules.
 *
 * Test with: npx tsx src/cli-new.ts [args...]
 */
import { APP_NAME } from "./config.ts";

process.title = APP_NAME;
process.env.PI_CODING_AGENT = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;

async function run(): Promise<void> {
	const args = process.argv.slice(2);
	if (args[0] === "_peer") {
		const { handlePeerCommand } = await import("./cli/peer-command.ts");
		await handlePeerCommand(args);
		return;
	}

	// Keep provider SDKs, extensions, resource loading, and TUI modules outside
	// the server-side peer helper's import graph.
	const [{ configureHttpDispatcher }, { main }] = await Promise.all([
		import("./core/http-dispatcher.ts"),
		import("./main.ts"),
	]);
	configureHttpDispatcher();
	await main(args);
}

void run().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
	process.exitCode = 1;
});
