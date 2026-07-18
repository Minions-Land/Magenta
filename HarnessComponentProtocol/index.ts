// Re-export Harness components, products, and public support APIs.

export * from "./.HCP/assembly/session-hcp.ts";
export { HCP_MAGNETS, HCP_SERVERS } from "./.HCP/assembly/sources.generated.ts";
// HCP layer (management + assembly, not the loop hot path):
//   HarnessComponentProtocol/HcpClient.ts       — HcpClient router (agent-facing)
//   HarnessComponentProtocol/.HCP/               — HCP data, assembly, and injectable Magnet process transport
//   HarnessComponentProtocol/_magenta/           — private Package, MCP, and host support
export * from "./.HCP/HcpMagnetTypes.ts";
export * from "./.HCP/HcpServerTypes.ts";
export * from "./.HCP/transport/hcp-process.ts";
export * from "./_magenta/env/pi/nodejs.ts";
export * from "./_magenta/env/ssh.ts";
export * from "./_magenta/mcp/client.ts";
export * from "./_magenta/mcp/http-client.ts";
export * from "./_magenta/mcp/jsonrpc.ts";
export * from "./_magenta/mcp/schema.ts";
export * from "./_magenta/mcp/sse.ts";
export * from "./_magenta/mcp/tool.ts";
export * from "./_magenta/mcp/transport.ts";
export * from "./_magenta/messages/messages.ts";
export * from "./_magenta/packages/hcp-client-components.ts";
export * from "./_magenta/packages/package-overlay-v2.ts";
export * from "./_magenta/packages/runtime-magnet-loader.ts";
export { initProcessToolsBinary } from "./_magenta/process-tools/embedded-binaries.ts";
export * from "./_magenta/session/pi/repo-utils.ts";
export * from "./_magenta/session/pi/session.ts";
export { uuidv7 } from "./_magenta/session/pi/uuid.ts";
export * from "./_magenta/types/types.ts";
export { getEmbeddedToolPath } from "./_magenta/utils/pi/embedded-tools.ts";
export * from "./_magenta/utils/pi/truncate.ts";
// 规范§2.1：<module>/HcpServer.ts 都导出裸 class HcpServer
// 为避免命名冲突，只导出具体的 provider 类型，不导出 HcpServer class
export type { CompactionProvider } from "./compaction/HcpServer.ts";
export * from "./compaction/pi/branch-summarization.ts";
export * from "./compaction/pi/compaction.ts";
export * from "./compaction/pi/provider.ts";
export {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	formatFileOperations,
} from "./compaction/pi/utils.ts";
export * from "./context/magenta/context.ts";
export * from "./HcpClient.ts";
export type { HookDescriptor, HookDiscoverResult, HookProvider, HookResult } from "./hooks/HcpServer.ts";
export * from "./memory/magenta/session-grounding.ts";
export * from "./policy/magenta/approval.ts";
export * from "./policy/magenta/policy.ts";
export * from "./policy/magenta/shell-policy.ts";
export * from "./prompt-templates/pi/prompt-templates.ts";
export * from "./runtime/magenta/process-runtime.ts";
export * from "./runtime/magenta/script-runtime.ts";
export * from "./sandbox/magenta/sandbox.ts";
export {
	formatSkillInvocation,
	getHarnessSkillsDir,
	loadSkillFile,
	loadSkills,
	loadSourcedSkills,
	type SkillDiagnostic,
	type SkillDiagnosticCode,
} from "./skills/HcpServer.ts";
export * from "./system-prompt/pi/descriptor.ts";
export * from "./system-prompt/pi/provider.ts";
export * from "./system-prompt/pi/system-prompt.ts";
export * from "./tools/descriptor/package-tool.ts";
// Tools: pure-execution tool logic + the AgentTool Tool contract.
export * from "./tools/index.ts";
export * from "./tools/multiagent/magenta/multiagent.ts";
export * from "./tools/multiagent/magenta/registry.ts";
export * from "./tools/multiagent/magenta/worktree.ts";
export * from "./tools/process-tool.ts";
export * from "./tools/send-message/magenta/message-store.ts";
export * from "./tools/send-message/magenta/peer-command.ts";
export * from "./tools/send-message/magenta/peer-endpoint.ts";
export * from "./tools/send-message/magenta/peer-link-protocol.ts";
export * from "./tools/send-message/magenta/peer-link-session.ts";
export * from "./tools/send-message/magenta/peer-link-store-adapter.ts";
export * from "./tools/send-message/magenta/remote-mailbox.ts";
export * from "./tools/send-message/magenta/runtime.ts";
export * from "./tools/send-message/magenta/send-message.ts";
export * from "./tools/sub-agent/magenta/runtime.ts";
export * from "./tools/sub-agent/magenta/sub-agent.ts";
export {
	MultiAgentOrchestrator,
	type WorkerRunner,
} from "./tools/sub-agent/magenta/workflow/orchestrator.ts";
export type { OrchestrationRequest, OrchestrationResult } from "./tools/sub-agent/magenta/workflow-types.ts";
export * from "./tools/todo/magenta/todo.ts";
export * from "./tools/tool-error.ts";
