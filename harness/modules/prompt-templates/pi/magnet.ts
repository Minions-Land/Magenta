import type { CapabilitySourceMagnet } from "../../../hcp-client/contract/hcp-magnet.ts";
import { PromptTemplateProvider } from "./prompt-templates.ts";

/** The pi source's binding for the `prompt-template` capability (spec §8). */
export const promptTemplatePiMagnet: CapabilitySourceMagnet = {
	module: "prompt-templates",
	kind: "prompt-template",
	source: "pi",
	isDefault: true,
	build: () => new PromptTemplateProvider(),
};
