import type {
	HcpMagnetBuildContext,
	HcpMagnetResource,
	HcpMagnetResourcebuildsettings,
} from "../../.HCP/HcpMagnetTypes.ts";

/** Descriptor Source for skill Resources supplied by a host or Package. */
export class HcpMagnet {
	static readonly module = "skills";
	static readonly kind = "skill";
	static readonly source = "descriptor";
	static build(context: HcpMagnetBuildContext) {
		return new HcpMagnet(HcpMagnetsettings(context.settings));
	}

	readonly kind = "resource:skill";
	readonly source = "descriptor";
	private readonly resource: HcpMagnetResource;

	constructor(settings: HcpMagnetResourcebuildsettings) {
		this.resource = {
			kind: "skill",
			name: settings.name,
			source: settings.source,
			mergeMode: settings.mergeMode,
			...(settings.contentPath === undefined ? {} : { contentPath: settings.contentPath }),
			...(settings.content === undefined ? {} : { content: settings.content }),
			...(settings.metadata === undefined ? {} : { metadata: settings.metadata }),
		};
	}

	toResource(): HcpMagnetResource {
		return this.resource;
	}
}

function HcpMagnetsettings(settings: unknown): HcpMagnetResourcebuildsettings {
	if (
		!HcpMagnetisresourcesettings(settings) ||
		(settings.contentPath === undefined && settings.content === undefined)
	) {
		throw new Error("skills:descriptor requires Resource settings with content or contentPath");
	}
	return settings;
}

function HcpMagnetisresourcesettings(settings: unknown): settings is HcpMagnetResourcebuildsettings {
	if (settings === null || typeof settings !== "object") return false;
	const value = settings as Partial<HcpMagnetResourcebuildsettings>;
	return (
		typeof value.name === "string" &&
		value.name.length > 0 &&
		typeof value.source === "string" &&
		value.source.length > 0 &&
		(value.mergeMode === "replace" || value.mergeMode === "append") &&
		(value.contentPath === undefined || typeof value.contentPath === "string") &&
		(value.content === undefined || typeof value.content === "string")
	);
}
