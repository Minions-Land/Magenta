import { createAssistantMessageEventStream, Type } from "@earendil-works/pi-ai";
import { complete, getModel, getProviders } from "@earendil-works/pi-ai/compat";
import {
	Agent,
	agentLoop,
	agentLoopContinue,
	type AgentContext,
	type AgentEvent,
	type AgentTool,
	streamProxy,
} from "@earendil-works/pi-agent-core";

// Keep this entry browser-safe. It is bundled by scripts/check-browser-smoke.mjs
// to catch accidental Node-only runtime imports in browser-facing package exports.
const model = getModel("google", "gemini-2.5-flash");
const schema = Type.Object({ prompt: Type.String() });
const stream = createAssistantMessageEventStream();

const agent = new Agent({ initialState: { model } });
agent.steer({ role: "user", content: [{ type: "text", text: "queued" }], timestamp: 0 });

const context: AgentContext = { systemPrompt: "browser-safe", messages: [], tools: [] };
const loop = agentLoop([], context, {
	model,
	convertToLlm: (messages) => messages.filter((message) => message.role !== "custom"),
});
const continuation = agentLoopContinue(
	{ ...context, messages: [{ role: "user", content: [{ type: "text", text: "continue" }], timestamp: 0 }] },
	{
		model,
		convertToLlm: (messages) => messages,
	},
);
const event: AgentEvent = { type: "agent_start" };
const tool = {
	name: "noop",
	label: "Noop",
	description: "No-op browser smoke tool",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
} satisfies AgentTool;

console.log(
	model.id,
	getProviders().length,
	typeof complete,
	schema.type,
	typeof stream.push,
	agent.hasQueuedMessages(),
	typeof loop.subscribe,
	typeof continuation.subscribe,
	event.type,
	tool.name,
	typeof streamProxy,
);
