// Re-export all harness capabilities

// HCP layer (management + assembly, not the loop hot path):
//   hcp-contract/  — the three-role contracts (HcpServer, HcpMagnet, ...)
//   hcp-client/    — HcpClient router + assembly (sources/capability/factory), registry, overlay
//   hcp-magnet/    — the HcpMagnet transport framework (native/process/python/...)
export * from "./hcp-contract/hcp-server.ts";
export * from "./hcp-contract/hcp-magnet.ts";
export * from "./hcp-client/hcp-client.ts";
export * from "./hcp-client/assembly/factory.ts";
export * from "./hcp-client/assembly/register-servers.ts";
export * from "./hcp-magnet/hcp-process.ts";
export * from "./hcp-magnet/native.ts";
export * from "./hcp-magnet/package-tool.ts";
export * from "./hcp-magnet/process.ts";
export * from "./hcp-magnet/python.ts";
export * from "./hcp-magnet/schema.ts";
export * from "./hcp-magnet/universal.ts";
export * from "./hcp-client/registry/registry.ts";
export * from "./catalog/pi/catalog.ts";
export * from "./compaction/contract.ts";
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
export * from "./env/pi/nodejs.ts";
export * from "./hooks/contract.ts";
export * from "./hooks/magenta/hooks.ts";
export * from "./loop/pi/agent-harness.ts";
export * from "./messages/messages.ts";
export * from "./policy/contract.ts";
export * from "./policy/magenta/policy.ts";
export * from "./policy/magenta/approval.ts";
export * from "./policy/magenta/shell-policy.ts";
export * from "./hcp-client/overlay/package-overlay.ts";
export * from "./prompt-templates/contract.ts";
export * from "./prompt-templates/pi/prompt-templates.ts";
export * from "./runtime/contract.ts";
export * from "./runtime/magenta/process-runtime.ts";
export * from "./runtime/magenta/script-runtime.ts";
export * from "./sandbox/contract.ts";
export * from "./sandbox/magenta/sandbox.ts";
export * from "./session/pi/jsonl-repo.ts";
export * from "./session/pi/memory-repo.ts";
export * from "./session/pi/repo-utils.ts";
export * from "./session/pi/session.ts";
export { uuidv7 } from "./session/pi/uuid.ts";
export * from "./memory/magenta/session-grounding.ts";
export * from "./skills/pi/skills.ts";
export * from "./system-prompt/contract.ts";
export * from "./system-prompt/pi/descriptor.ts";
export * from "./system-prompt/pi/provider.ts";
export * from "./system-prompt/pi/system-prompt.ts";
// Tools: pure-execution tool logic + the AgentTool Tool contract.
export * from "./tools/index.ts";
export * from "./tools/todo/pi/todo.ts";
export * from "./types/types.ts";
export * from "./utils/pi/shell-output.ts";
export * from "./utils/pi/truncate.ts";
