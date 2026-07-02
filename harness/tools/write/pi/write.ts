import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { mkdir as fsMkdir, writeFile as fsWriteFile } from "fs/promises";
import { dirname } from "path";
import { type Static, Type } from "typebox";
import { withFileMutationQueue } from "../../../utils/pi/file-mutation-queue.ts";
import { resolveToCwd } from "../../../utils/pi/path-utils.ts";

export const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});

export type WriteToolInput = Static<typeof writeSchema>;

/** Structured details returned by the write tool execute. */
export type WriteToolDetails = undefined;

/**
 * Pluggable operations for the write tool.
 * Override these to delegate file writing to remote systems (for example SSH).
 */
export interface WriteOperations {
	/** Write content to a file */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** Create directory recursively */
	mkdir: (dir: string) => Promise<void>;
}

export const defaultWriteOperations: WriteOperations = {
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {}),
};

export interface WriteToolOptions {
	/** Custom operations for file writing. Default: local filesystem */
	operations?: WriteOperations;
}

/**
 * Build the pure execute function for the write tool.
 *
 * The returned function matches the `ToolDefinition.execute` / `AgentTool.execute`
 * contract: `(toolCallId, params, signal?, onUpdate?, ctx?)`. The trailing
 * `onUpdate` / `ctx` arguments are unused by write but accepted for signature
 * compatibility so callers can assemble either a `ToolDefinition` or an
 * `AgentTool` without an adapter.
 */
export function createWriteExecute(
	cwd: string,
	options?: WriteToolOptions,
): (
	toolCallId: string,
	params: WriteToolInput,
	signal?: AbortSignal,
	onUpdate?: unknown,
	ctx?: unknown,
) => Promise<AgentToolResult<WriteToolDetails>> {
	const ops = options?.operations ?? defaultWriteOperations;
	return async function execute(
		_toolCallId: string,
		{ path, content }: WriteToolInput,
		signal?: AbortSignal,
	): Promise<AgentToolResult<WriteToolDetails>> {
		const absolutePath = resolveToCwd(path, cwd);
		const dir = dirname(absolutePath);
		return withFileMutationQueue(absolutePath, async () => {
			// Do not reject from an abort event listener here: that would release the
			// mutation queue while an in-flight filesystem operation may still finish.
			// Checking signal.aborted after each await observes the same aborts while
			// keeping the queue locked until the current operation has settled.
			const throwIfAborted = (): void => {
				if (signal?.aborted) throw new Error("Operation aborted");
			};

			throwIfAborted();
			// Create parent directories if needed.
			await ops.mkdir(dir);
			throwIfAborted();

			// Write the file contents.
			await ops.writeFile(absolutePath, content);
			throwIfAborted();

			return {
				content: [{ type: "text", text: `Successfully wrote ${content.length} bytes to ${path}` }],
				details: undefined,
			};
		});
	};
}
