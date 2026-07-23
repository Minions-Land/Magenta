#!/usr/bin/env node
/**
 * CLI entry point for the refactored coding agent.
 * Uses main.ts with AgentSession and new mode modules.
 *
 * Test with: npx tsx src/cli-new.ts [args...]
 */
import { APP_NAME, VERSION } from "./config.ts";

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
	if (args[0] === "_install-unix") {
		const { handleUnixInstallerCommand } = await import("./cli/unix-installer-command.ts");
		await handleUnixInstallerCommand(args.slice(1));
		return;
	}
	if (args[0] === "_uninstall-unix") {
		const { handleUnixUninstallerCommand } = await import("./cli/unix-installer-command.ts");
		await handleUnixUninstallerCommand(args.slice(1));
		return;
	}
	if (args[0] === "_release-helper-proof") {
		const { handleReleaseHelperProofCommand } = await import("./cli/release-helper-proof-command.ts");
		handleReleaseHelperProofCommand(args.slice(1));
		return;
	}
	if (args.some((arg) => arg === "--version" || arg === "-v")) {
		const { parseArgs } = await import("./cli/args.ts");
		const parsed = parseArgs(args);
		if (parsed.version && parsed.diagnostics.length === 0) {
			console.log(VERSION);
			return;
		}
	}
	if (args.length > 0 && args.every((arg) => arg === "--help" || arg === "-h")) {
		const { printHelp } = await import("./cli/args.ts");
		printHelp();
		return;
	}

	// Keep provider SDKs, extensions, resource loading, and TUI modules outside
	// the server-side peer helper and read-only metadata import graphs.
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
