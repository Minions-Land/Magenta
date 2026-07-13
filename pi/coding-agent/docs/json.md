# JSON Event Stream Mode

```bash
magenta --mode json -p "Your prompt"
```

JSON mode runs the same `AgentSessionRuntime`, tools, resources, extensions, retry, and compaction pipeline as the TUI, then writes a strict JSONL execution record to stdout. Ordinary logs and diagnostics go to stderr.

## Stream Contract

Every output line is one JSON object. The headless protocol version is currently `1`. The new headless envelope records are described by [`headless-protocol.schema.json`](headless-protocol.schema.json); existing `AgentSessionEvent` payloads retain their TypeScript definitions.

A run contains, in order:

1. The persisted session header when the session has one.
2. A `runtime_manifest` after extensions and extension-provided resources finish binding.
3. Agent/session events in execution order.
4. Exactly one terminal `run_end` record.

If an extension replaces the active session, another `runtime_manifest` is emitted with the same `runId` and an incremented `sequence`.

### Runtime Manifest

The manifest makes the effective runtime auditable without exposing credentials or system-prompt contents:

```json
{
  "type": "runtime_manifest",
  "protocolVersion": 1,
  "runId": "uuid",
  "sequence": 1,
  "mode": "json",
  "timestamp": "...",
  "product": {
    "name": "Magenta",
    "version": "0.0.16",
    "infrastructureVersion": "0.80.2"
  },
  "cwd": "/workspace",
  "session": {"id": "uuid", "persisted": false},
  "model": {"provider": "openai", "id": "gpt-5.6-sol", "api": "openai-responses"},
  "execution": {
    "thinkingLevel": "high",
    "profile": "high",
    "harnessCapabilities": {"workflows": true, "teammates": false}
  },
  "tools": {"active": ["read", "bash"], "available": []},
  "resources": {
    "extensions": [],
    "skills": [],
    "prompts": [],
    "contextFiles": [],
    "harnessPackages": [],
    "packageTools": [],
    "userMcpTools": [],
    "customSystemPrompt": false,
    "appendSystemPromptCount": 0
  },
  "projectTrust": {"trusted": false, "required": true},
  "policies": {
    "autoCompaction": true,
    "autoRetry": true,
    "steeringMode": "one-at-a-time",
    "followUpMode": "one-at-a-time"
  },
  "diagnostics": []
}
```

### Terminal Record

`run_end` is the authoritative outcome. The process exit code agrees with `exitCode` for normal completion:

```json
{
  "type": "run_end",
  "protocolVersion": 1,
  "runId": "uuid",
  "status": "success",
  "exitCode": 0,
  "startedAt": "...",
  "endedAt": "...",
  "durationMs": 1234,
  "stopReason": "stop",
  "stats": {},
  "background": {
    "policy": "cancel",
    "settled": true,
    "events": []
  },
  "nonInteractiveUi": {
    "policy": "deny",
    "requestCount": 0
  }
}
```

Statuses are `success`, `error`, or `aborted`. Provider errors and aborted assistant messages return a non-zero process status in JSON mode. A forced `SIGKILL` cannot emit a terminal record.

## Agent Event Types

Events are defined by `AgentSessionEvent` and include:

```typescript
type AgentSessionEvent =
  | AgentEvent
  | { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] }
  | { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
  | { type: "compaction_progress"; reason: string; phase: string; processedBytes?: number; totalBytes?: number }
  | { type: "compaction_end"; reason: string; result?: CompactionResult; aborted: boolean; willRetry: boolean; errorMessage?: string }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string };
```

Base agent events cover agent, turn, message, and tool execution lifecycle:

```text
agent_start, agent_end
turn_start, turn_end
message_start, message_update, message_end
tool_execution_start, tool_execution_update, tool_execution_end
```

`message_update` includes streaming text, thinking, and tool-call deltas. Assistant messages include provider usage and cost fields.

Extension failures are emitted as structured `extension_error` records. A blocking extension UI request in JSON/print mode emits `non_interactive_ui`; the default `deny` policy returns the non-interactive fallback, while `--non-interactive-ui error` fails the run.

## Background Work

One-shot cleanup remains bounded by default:

```bash
# Preserve historical cleanup: report and cancel leftovers when the run exits
magenta --mode json -p --background-policy cancel "Run the task"

# Wait up to 120 seconds for background work and auto-return continuations
magenta --mode json -p --background-policy wait --background-wait-timeout 120 "Run the task"

# Fail if the main agent leaves any background event running
magenta --mode json -p --background-policy error "Run the task"
```

The terminal record reports shell, sub-agent, teammate, and Package events after session cleanup, including cancellations caused by shutdown.

## Validation-Only Run

Validate model resolution, credentials, extensions, resources, tools, trust, and the headless binding path without sending a model request:

```bash
magenta --validate-config --mode json --no-session
```

The manifest is emitted before authentication validation, and `run_end` reports success or the precise failure.

## Example

```bash
magenta --mode json -p "List files" 2>/dev/null \
  | jq -c 'select(.type == "runtime_manifest" or .type == "tool_execution_end" or .type == "run_end")'
```
