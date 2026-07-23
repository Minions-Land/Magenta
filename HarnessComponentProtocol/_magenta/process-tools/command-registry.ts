import { isAbsolute, resolve } from "node:path";

type CommandBinding = {
	active: boolean;
	executablePath: string;
	previous?: CommandBinding;
};

const commandOverrides = new Map<string, CommandBinding>();

function assertNormalizedAbsolutePath(path: string, label: string): void {
	if (!isAbsolute(path) || resolve(path) !== path) throw new Error(`${label} must be an absolute normalized path`);
}

/**
 * Bind one manifest-resolved logical command to this process's immutable helper.
 * The returned cleanup is generation-aware so tests and embedders cannot remove
 * a newer binding accidentally.
 */
export function registerProcessToolCommandOverride(logicalCommand: string, executablePath: string): () => void {
	assertNormalizedAbsolutePath(logicalCommand, "Process-tool logical command");
	assertNormalizedAbsolutePath(executablePath, "Process-tool executable override");
	const previous = commandOverrides.get(logicalCommand);
	if (previous?.executablePath === executablePath) return () => {};
	const binding: CommandBinding = { active: true, executablePath, previous };
	commandOverrides.set(logicalCommand, binding);
	return () => {
		if (!binding.active) return;
		binding.active = false;
		if (commandOverrides.get(logicalCommand) !== binding) return;
		let fallback = binding.previous;
		while (fallback && !fallback.active) fallback = fallback.previous;
		if (fallback === undefined) commandOverrides.delete(logicalCommand);
		else commandOverrides.set(logicalCommand, fallback);
	};
}

export function resolveProcessToolCommandOverride(logicalCommand: string): string | undefined {
	return commandOverrides.get(logicalCommand)?.executablePath;
}
