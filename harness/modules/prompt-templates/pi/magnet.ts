import type { CapabilitySourceMagnet } from "../../../hcp-contract/hcp-magnet.ts";
import { PromptTemplateProvider } from "./prompt-templates.ts";

/** The pi source's binding for the `prompt-template` capability (spec §8). */
export const promptTemplatePiMagnet: CapabilitySourceMagnet = {
	kind: "prompt-template",
	source: "pi",
	isDefault: true,
	build: () => new PromptTemplateProvider(),
};
