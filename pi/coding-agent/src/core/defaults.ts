import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

/**
 * Native application tools that are active by default in a fresh session.
 *
 * This is the single source of truth for the default active set. Both the SDK
 * entrypoint (createAgentSession) and the interactive AgentSession derive their
 * defaults from this array, so the two paths can never drift apart. Every native
 * tool Magenta ships is enabled out of the box; users still narrow the set with
 * --tools / --exclude-tools (or the SDK `tools`/`excludeTools` options).
 *
 * Note: HCP repository-default tools, package tools, and user MCP tools are
 * appended on top of this list by the callers; this array is only the native
 * application tools.
 */
export const DEFAULT_NATIVE_ACTIVE_TOOLS: readonly string[] = [
	"read",
	"bash",
	"edit",
	"write",
	"bg_shell",
	"sub_agent",
	"send_message",
	"show",
	"grep",
	"find",
	"ls",
];
