import type {
	HcpMagnetBuildContext,
	HcpMagnetResource,
	HcpMagnetResourcebuildsettings,
} from "../../.HCP/HcpMagnetTypes.ts";
import type { SystemPromptDescriptor, SystemPromptProvider } from "../HcpServer.ts";

/** Descriptor Source for file-backed system-prompt Resources. */
export class HcpMagnet {
	static readonly module = "system-prompt";
	static readonly kind = "system-prompt";
	static readonly source = "descriptor";
	static async build(context: HcpMagnetBuildContext) {
		const settings = HcpMagnetsettings(context.settings);
		const provider = context.resolveCapability?.<SystemPromptProvider>("system-prompt");
		if (!provider) throw new Error("system-prompt:descriptor requires the selected system-prompt capability");
		const result = await provider.loadDescriptor(settings.descriptorPath);
		const error = result.diagnostics.find((diagnostic) => diagnostic.type === "error");
		if (!result.descriptor || error) {
			throw new Error(error?.message ?? `Unable to load system-prompt descriptor ${settings.descriptorPath}`);
		}
		return new HcpMagnet(settings, result.descriptor);
	}

	readonly kind = "resource:system-prompt";
	readonly source = "descriptor";
	private readonly resource: HcpMagnetResource;

	constructor(settings: HcpMagnetResourcebuildsettings, descriptor: SystemPromptDescriptor) {
		const mergeMode = descriptor.kind === "append-system-prompt" ? "append" : "replace";
		if (settings.mergeMode !== mergeMode) {
			throw new Error(
				`system-prompt:descriptor mergeMode=${settings.mergeMode} does not match descriptor kind=${descriptor.kind}`,
			);
		}
		this.resource = {
			kind: "system-prompt",
			name: settings.name,
			source: settings.source,
			mergeMode,
			...(descriptor.contentPath === undefined ? {} : { contentPath: descriptor.contentPath }),
			...(settings.metadata === undefined ? {} : { metadata: settings.metadata }),
		};
	}

	toResource(): HcpMagnetResource {
		return this.resource;
	}
}

function HcpMagnetsettings(settings: unknown): HcpMagnetResourcebuildsettings & { descriptorPath: string } {
	if (settings === null || typeof settings !== "object") {
		throw new Error("system-prompt:descriptor requires Resource settings with descriptorPath");
	}
	const value = settings as Partial<HcpMagnetResourcebuildsettings>;
	if (
		typeof value.name !== "string" ||
		value.name.length === 0 ||
		typeof value.source !== "string" ||
		value.source.length === 0 ||
		(value.mergeMode !== "replace" && value.mergeMode !== "append") ||
		typeof value.descriptorPath !== "string" ||
		value.descriptorPath.length === 0
	) {
		throw new Error("system-prompt:descriptor requires Resource settings with descriptorPath");
	}
	return value as HcpMagnetResourcebuildsettings & { descriptorPath: string };
}
