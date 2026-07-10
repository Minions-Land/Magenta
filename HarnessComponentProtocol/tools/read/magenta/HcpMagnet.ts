import type { HcpMagnetBuildContext } from "../../../.HCP/HcpMagnetTypes.ts";
import type { ProcessRuntimeProvider } from "../../../runtime/HcpServer.ts";
import type { SandboxProvider } from "../../../sandbox/HcpServer.ts";
import { createProcessToolFromDescriptor, type ProcessTool } from "../../process-tool.ts";

export class HcpMagnet {
	static readonly module = "tools/read";
	static readonly kind = "tool";
	static readonly source = "magenta";
	static async build(context: HcpMagnetBuildContext) {
		if (!context.descriptorPath) throw new Error("tools/read:magenta requires a component descriptor");
		const runtime = context.resolveCapability?.<ProcessRuntimeProvider>("runtime:process");
		const sandbox = context.resolveCapability?.<SandboxProvider>("sandbox");
		if (!runtime || !sandbox) throw new Error("tools/read:magenta requires runtime:process and sandbox");
		return new HcpMagnet(
			await createProcessToolFromDescriptor({
				descriptorPath: context.descriptorPath,
				source: context.source,
				cwd: context.cwd ?? context.repoRoot,
				runtimeExec: runtime.exec.bind(runtime),
				sandboxResolve: sandbox.resolve.bind(sandbox),
			}),
		);
	}

	readonly kind = "process";
	readonly source = "magenta";
	private readonly tool: ProcessTool;

	constructor(tool: ProcessTool) {
		this.tool = tool;
	}
	toTool() {
		return this.tool.toTool();
	}
}
