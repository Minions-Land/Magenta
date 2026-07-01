import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";

/**
 * The in-process Tool contract that the agent loop consumes.
 *
 * Per the harness reorg spec (§1/§5), the loop calls `tool.execute()` directly,
 * in-process — HCP is NOT on this hot path. HCP/Magnet are the management/assembly
 * layer that discovers, configures, and wires implementations into the loop; once
 * wired, the loop treats every tool uniformly through this `AgentTool` abstraction.
 *
 * These re-exports give harness a stable, namespaced name for pi's `AgentTool`
 * shape (defined in `@earendil-works/pi-agent-core`) so assembly code can refer to
 * the Tool contract without deep-importing the agent-core internals.
 */
export type { AgentTool, AgentToolResult, AgentToolUpdateCallback };

/**
 * Factory contract for a harness tool: given a working directory (and optional
 * tool-specific options) produce a ready-to-run {@link AgentTool}. This is the
 * shape a `native` Magnet adapts a `harness/tools/pi/<tool>` module into.
 */
export type ToolFactory<TOptions = any> = (cwd: string, options?: TOptions) => AgentTool;
