import type { McpStdioManagedProcessInput, McpStdioManagedSpawner } from "../.HCP/transport/mcp-client.ts";
import type { ProcessRuntimeManagedHandle } from "../runtime/HcpServer.ts";
import { ProcessRuntimeProvider } from "../runtime/magenta/process-runtime.ts";

export type ManagedMcpSpawnerOptions = {
	provider?: ProcessRuntimeProvider;
	workspaceRoot?: string;
	onSpawn?: (handle: ProcessRuntimeManagedHandle) => void;
};

/** Route test MCP servers through the same managed process boundary as production. */
export function createManagedMcpSpawner(options: ManagedMcpSpawnerOptions = {}): McpStdioManagedSpawner {
	const provider = options.provider ?? new ProcessRuntimeProvider();
	return async (input: McpStdioManagedProcessInput, signal?: AbortSignal) => {
		const cwd = input.cwd ?? options.workspaceRoot ?? process.cwd();
		const workspaceRoot = options.workspaceRoot ?? cwd;
		const envOverrides = Object.fromEntries(
			Object.entries(input.env ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
		);
		const handle = await provider.spawnManaged(
			{
				command: input.command,
				args: input.args,
				cwd,
				workspace_root: workspaceRoot,
				allow_direct_exec: true,
				env_overrides: envOverrides,
			},
			signal,
		);
		options.onSpawn?.(handle);
		return handle;
	};
}
