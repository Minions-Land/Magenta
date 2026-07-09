// Re-export all harness capabilities

export * from "./core/env/pi/nodejs.ts";
export * from "./core/messages/messages.ts";
export * from "./core/session/pi/jsonl-repo.ts";
export * from "./core/session/pi/memory-repo.ts";
export * from "./core/session/pi/repo-utils.ts";
export * from "./core/session/pi/session.ts";
export { uuidv7 } from "./core/session/pi/uuid.ts";
export * from "./core/types/types.ts";
export * from "./core/utils/pi/shell-output.ts";
export * from "./core/utils/pi/truncate.ts";
export * from "./harness-component-protocol/assembly/register-servers.ts";
export * from "./harness-component-protocol/assembly/session-hcp.ts";
export * from "./harness-component-protocol/assembly/trunk-tools.ts";
export * from "./harness-component-protocol/HcpClient.ts";
// HCP layer (management + assembly, not the loop hot path):
//   harness-component-protocol/  — HCP data types (HcpServerRequest, HcpMagnetBinding, ...)
//   harness-component-protocol/  — HcpClient router + assembly (sources/capability/factory), registry, overlay
//   hcp-magnet/                   — the HcpMagnet transport framework (native/process/python/...)
export * from "./harness-component-protocol/HcpMagnetTypes.ts";
export * from "./harness-component-protocol/HcpServerTypes.ts";
export * from "./harness-component-protocol/overlay/package-overlay.ts";
export * from "./harness-component-protocol/registry/registry.ts";
export * from "./harness-component-protocol/magnet/hcp-process.ts";
export * from "./harness-component-protocol/magnet/mcp.ts";
export * from "./harness-component-protocol/magnet/mcp-client.ts";
export * from "./harness-component-protocol/magnet/native.ts";
export * from "./harness-component-protocol/magnet/package-tool.ts";
export * from "./harness-component-protocol/magnet/process.ts";
export * from "./harness-component-protocol/magnet/python.ts";
export * from "./harness-component-protocol/magnet/schema.ts";
export * from "./harness-component-protocol/magnet/universal.ts";
// 规范§2.1：modules/<m>/HcpServer.ts 都导出裸 class HcpServer
// 为避免命名冲突，只导出具体的 provider 类型，不导出 HcpServer class
export type { CompactionProvider } from "./modules/compaction/HcpServer.ts";
export * from "./modules/compaction/pi/branch-summarization.ts";
export * from "./modules/compaction/pi/compaction.ts";
export * from "./modules/compaction/pi/provider.ts";
export {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	formatFileOperations,
} from "./modules/compaction/pi/utils.ts";
export * from "./modules/context/magenta/context.ts";
export type { HookProvider, HookDescriptor, HookResult, HookDiscoverResult } from "./modules/hooks/HcpServer.ts";
export * from "./modules/memory/magenta/session-grounding.ts";
export type { OrchestrationRequest, OrchestrationResult } from "./modules/multiagent/HcpServer.ts";
export * from "./modules/multiagent/message/message-store.ts";
export {
	MultiAgentOrchestrator,
	type WorkerRunner,
} from "./modules/multiagent/workflow/magenta/orchestrator.ts";
export * from "./modules/policy/magenta/approval.ts";
export * from "./modules/policy/magenta/policy.ts";
export * from "./modules/policy/magenta/shell-policy.ts";
export * from "./modules/prompt-templates/pi/prompt-templates.ts";
export * from "./modules/runtime/magenta/process-runtime.ts";
export * from "./modules/runtime/magenta/script-runtime.ts";
export * from "./modules/sandbox/magenta/sandbox.ts";
export * from "./modules/skills/pi/skills.ts";

export * from "./modules/system-prompt/pi/descriptor.ts";
export * from "./modules/system-prompt/pi/provider.ts";
export * from "./modules/system-prompt/pi/system-prompt.ts";
// Tools: pure-execution tool logic + the AgentTool Tool contract.
export * from "./modules/tools/index.ts";
export * from "./modules/tools/todo/pi/todo.ts";
