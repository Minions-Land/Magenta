import type { HcpMagnetBinding } from "../../../harness-component-protocol/HcpMagnetTypes.ts";
import type {
	HcpMagnetBuildContext,
	HcpServerDescription,
	HcpServerRequest,
} from "../../../harness-component-protocol/HcpServerTypes.ts";
import { piCompactionProvider } from "./provider.ts";

/**
 * The pi source's binding for the `compaction` capability (spec §8).
 *
 * 按照规范§2 + 头号铁律：裸 class，不继承任何基类。名字 = Hcp(一级) + Magnet(二级)。
 * Lives next to the implementation it builds and imports the provider via a
 * literal sibling import, so it survives the build extension rewrite.
 */
export class HcpMagnet {
	static readonly module = "compaction";
	static readonly kind = "compaction";
	static readonly source = "pi";
	static readonly isDefault = true;

	readonly kind = "capability:compaction";
	private readonly capabilityKind: string;
	private readonly name: string;
	private readonly source: string;
	private readonly instance: typeof piCompactionProvider;

	constructor(context: HcpMagnetBuildContext) {
		this.capabilityKind = context.kind ?? "compaction";
		this.name = context.name ?? "compaction";
		this.source = context.source ?? "pi";
		this.instance = piCompactionProvider;
	}

	toCapability(): HcpMagnetBinding {
		return {
			kind: this.capabilityKind,
			name: this.name,
			source: this.source,
			instance: this.instance,
		};
	}

	toHcpServer() {
		return {
			describe: (): HcpServerDescription => ({
				target: `capability:${this.capabilityKind}`,
				kind: this.capabilityKind,
				ops: ["describe", "health"],
				description: "Compaction capability from pi source",
				metadata: {
					name: this.name,
					implementation: `capability:${this.capabilityKind}`,
					source: this.source,
				},
			}),
			call: async (_call: HcpServerRequest): Promise<unknown> => this.instance,
			instance: <T = unknown>(_selector?: string): T | undefined => this.instance as unknown as T,
		};
	}
}
