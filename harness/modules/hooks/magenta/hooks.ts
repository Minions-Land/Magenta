import type { ShellPolicyClassification } from "../../policy/contract.ts";
import { decideApproval } from "../../policy/magenta/approval.ts";
import { classifyShellCommand } from "../../policy/magenta/shell-policy.ts";
import { selectSandboxProfile } from "../../sandbox/magenta/sandbox.ts";
import type { HookDescriptor, HookDiscoverResult, HookProvider as IHookProvider, HookResult } from "../contract.ts";

const LIFECYCLE_HOOKS = ["init", "pre-turn", "pre-llm", "post-llm", "pre-tool", "post-tool", "compact", "workflow"];

const HOOKS: readonly HookDescriptor[] = [
	{ name: "init", target: "hook://init", description: "Session/harness initialization hook." },
	{ name: "pre-turn", target: "hook://pre-turn", description: "Before-turn context injection hook." },
	{ name: "pre-llm", target: "hook://pre-llm", description: "Before-LLM lifecycle hook." },
	{ name: "post-llm", target: "hook://post-llm", description: "After-LLM lifecycle hook." },
	{ name: "pre-tool", target: "hook://pre-tool", description: "Before-tool lifecycle hook." },
	{ name: "post-tool", target: "hook://post-tool", description: "After-tool lifecycle hook." },
	{ name: "compact", target: "hook://compact", description: "Compaction lifecycle hook." },
	{ name: "workflow", target: "hook://workflow", description: "Workflow dispatch hook." },
	{ name: "sandbox-select", target: "hook://sandbox-select", description: "Sandbox profile selection hook." },
];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultReturnMode(name: string): string {
	switch (name) {
		case "compact":
		case "workflow":
			return "next_turn";
		case "post-llm":
		case "post-tool":
		case "init":
			return "follow_up";
		default:
			return "steer";
	}
}

function readString(input: unknown, key: string): string | undefined {
	return isRecord(input) && typeof input[key] === "string" ? input[key] : undefined;
}

function toolInput(input: unknown): Record<string, unknown> {
	return isRecord(input) && isRecord(input.tool) ? input.tool : {};
}

function shellPolicyForPreTool(input: unknown): ShellPolicyClassification | undefined {
	const tool = toolInput(input);
	const name = typeof tool.name === "string" ? tool.name : "";
	const tags = Array.isArray(tool.tags) ? tool.tags.filter((item): item is string => typeof item === "string") : [];
	const isShell = name.toLowerCase() === "bash" || tags.includes("shell");
	return isShell ? classifyShellCommand(input) : undefined;
}

export function runLifecycleHook(name: string, input: unknown): HookResult {
	const actions: unknown[] = [];
	let data: unknown = { input };

	if (name === "pre-tool") {
		const sandbox = selectSandboxProfile(input);
		const approval = decideApproval(input);
		const shellPolicy = shellPolicyForPreTool(input);
		actions.push({
			type: "sandbox",
			target: "hook://sandbox-select",
			output: sandbox,
		});
		actions.push({
			type: "hcp_call",
			target: "approval://policy",
			op: "decide",
			input,
			output: approval,
			purpose: "tool_approval",
		});
		if (shellPolicy) {
			actions.push({
				type: "hcp_call",
				target: "shell://policy",
				op: "classify",
				input,
				output: shellPolicy,
				purpose: "shell_policy",
			});
		}
		data = shellPolicy ? { input, sandbox, approval, shell_policy: shellPolicy } : { input, sandbox, approval };
	}

	if (name === "init") {
		const session = readString(input, "session") ?? "default";
		actions.push({
			type: "hcp_call",
			target: "session://current",
			op: "append_event",
			input: {
				kind: "session_initialized",
				data: { session },
			},
			purpose: "session_initialization",
		});
		data = {
			input,
			session: {
				target: "session://current",
				op: "append_event",
				kind: "session_initialized",
				session,
			},
		};
	}

	if (name === "pre-turn") {
		actions.push({
			type: "hcp_call",
			target: "memory://session-grounding",
			op: "read",
			purpose: "context_injection",
		});
		actions.push({
			type: "hcp_call",
			target: "context://project",
			op: "read",
			purpose: "context_injection",
		});
		data = {
			input,
			memory: { target: "memory://session-grounding", op: "read" },
			context: { target: "context://project", op: "read" },
		};
	}

	if (name === "post-llm") {
		actions.push({
			type: "hcp_call",
			target: "advisor://watchdog",
			op: "begin_update",
			input: { delta: input },
			purpose: "advisor_watchdog_update",
		});
		data = {
			input,
			advisor: {
				target: "advisor://watchdog",
				op: "begin_update",
				mode: "watchdog-guidance-and-emission-guard",
			},
		};
	}

	if (name === "compact") {
		const artifact = readString(input, "artifact") ?? "context.compaction";
		actions.push({
			type: "hcp_call",
			target: "session://current",
			op: "compact",
			input: { artifact },
		});
		data = {
			input,
			session: {
				target: "session://current",
				op: "compact",
				artifact,
			},
		};
	}

	if (name === "workflow") {
		const target = readString(input, "loop") ?? readString(input, "target") ?? "loop://plan-execute";
		const op = readString(input, "op") ?? "run";
		const workflowInput =
			isRecord(input) && "input" in input
				? input.input
				: isRecord(input) && "schedule" in input
					? { schedule: input.schedule }
					: {};
		actions.push({
			type: "hcp_call",
			target,
			op,
			input: workflowInput,
			purpose: "workflow_dispatch",
		});
		data = {
			input,
			workflow: { target, op },
		};
	}

	return {
		hook: name,
		status: "ok",
		return_mode: defaultReturnMode(name),
		actions,
		data,
	};
}

export class HookProvider implements IHookProvider {
	private readonly hooks = new Map<string, HookDescriptor>();

	constructor(hooks: readonly HookDescriptor[] = HOOKS) {
		for (const hook of hooks) {
			this.hooks.set(hook.name, hook);
		}
	}

	discover(): HookDiscoverResult {
		const hooks = [...this.hooks.values()];
		return {
			provider: "hooks",
			targets: hooks.map((hook) => hook.target),
			lifecycle_targets: LIFECYCLE_HOOKS.map((name) => `hook://${name}`),
			hooks,
		};
	}

	run(name: string, input: unknown): HookResult | unknown {
		const hook = this.describeHook(name);
		if (hook.name === "sandbox-select") return selectSandboxProfile(input);
		if (LIFECYCLE_HOOKS.includes(hook.name)) return runLifecycleHook(hook.name, input);
		return {
			hook: hook.name,
			status: "no_op",
			reason: "declarative hook has no runtime implementation yet",
		};
	}

	describeHook(name: string): HookDescriptor {
		const hook =
			this.hooks.get(name) ??
			[...this.hooks.entries()].find(([candidate]) => candidate.toLowerCase() === name.toLowerCase())?.[1];
		if (!hook) {
			throw new Error(`hook not found: ${name}`);
		}
		return hook;
	}
}
