import type { HcpMagnetBuildContext } from "../../../harness-component-protocol/HcpServerTypes.ts";
import { createCapabilityServer } from "../../../harness-component-protocol/server/capability-server.ts";
import { CapabilityMagnet } from "../../../hcp-magnet/universal.ts";
import { APPROVAL_POLICY_TARGET, SHELL_POLICY_TARGET } from "../HcpServer.ts";
import { PolicyProvider } from "./policy.ts";

/**
 * The magenta source's binding for the `policy` capability (spec §8).
 *
 * Policy is a composite capability with two sub-providers (approval and shell).
 * We wrap the main PolicyProvider and expose approval/shell as operations that
 * delegate to the sub-providers.
 */
export class HcpMagnet extends CapabilityMagnet {
	static readonly module = "policy";
	static readonly kind = "policy";
	static readonly source = "magenta";
	static readonly isDefault = true;

	constructor(context: HcpMagnetBuildContext) {
		const kind = context.kind ?? "policy";
		const name = context.name ?? "policy";
		const source = context.source ?? "magenta";

		const provider = new PolicyProvider();

		// Create HcpServers for the two sub-providers
		const approvalServer = createCapabilityServer({
			kind: "approval",
			target: APPROVAL_POLICY_TARGET,
			description: "Resolve tool approval decisions from tool tier, session mode, user policy, and safety override.",
			provider: provider.approval,
			operations: {
				decide: (p, req) => p.decide(req.input),
				call: (p, req) => p.decide(req.input),
				status: (p) => p.status(),
			},
			metadata: {
				implementation: "native-ts",
				source: "magenta",
				origin: "magenta1-general-harness",
			},
		});

		const shellServer = createCapabilityServer({
			kind: "shell",
			target: SHELL_POLICY_TARGET,
			description: "Classify shell command intent and suggest native Harness tools before execution.",
			provider: provider.shell,
			operations: {
				classify: (p, req) => p.classify(req.input),
				call: (p, req) => p.classify(req.input),
				status: (p) => p.status(),
			},
			metadata: {
				implementation: "native-ts",
				source: "magenta",
				origin: "magenta1-general-harness",
			},
		});

		// Return the main provider wrapped in an HcpServer
		const instance = createCapabilityServer({
			kind: "policy",
			target: "policy://bundle",
			description: "Policy bundle containing approval and shell sub-providers.",
			provider,
			operations: {
				decideApproval: (p, req) => p.decideApproval(req.input),
				classifyShellCommand: (p, req) => p.classifyShellCommand(req.input),
			},
			metadata: {
				implementation: "native-ts",
				source: "magenta",
				subProviders: {
					approval: approvalServer,
					shell: shellServer,
				},
			},
		});

		super({
			descriptor: {
				target: `capability:${kind}`,
				kind: kind,
				name: name,
				implementation: "capability:policy",
				description: "Policy bundle containing approval and shell sub-providers.",
				metadata: {
					hotSwappable: context.hotSwappable ?? false,
				},
			},
			source: source,
			instance,
		});
	}
}
