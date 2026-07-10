import { join } from "node:path";
import type { HcpMagnetBuildContext } from "../../../.HCP/HcpMagnetTypes.ts";
import { getHarnessSkillsDir, type SkillSourceDefinition, skillSourceResource } from "../../HcpServer.ts";

export class HcpMagnet {
	static readonly module = "skills/pptx";
	static readonly kind = "skill";
	static readonly source = "pi";
	static build(_context: HcpMagnetBuildContext) {
		return new HcpMagnet();
	}

	readonly kind = "resource:skill";
	private readonly definition: SkillSourceDefinition = {
		name: "pptx",
		source: "pi",
		description: "PowerPoint presentation creation, editing, inspection, and QA.",
		contentPath: join(getHarnessSkillsDir(), "pptx", "pi", "SKILL.md"),
	};

	toResource() {
		return skillSourceResource(this.definition);
	}
}
