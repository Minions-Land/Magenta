import { join } from "node:path";
import type { HcpMagnetBuildContext } from "../../../.HCP/HcpMagnetTypes.ts";
import { getHarnessSkillsDir, type SkillSourceDefinition, skillSourceResource } from "../../HcpServer.ts";

export class HcpMagnet {
	static readonly module = "skills/self-evo";
	static readonly kind = "skill";
	static readonly source = "magenta";
	static build(_context: HcpMagnetBuildContext) {
		return new HcpMagnet();
	}

	readonly kind = "resource:skill";
	private readonly definition: SkillSourceDefinition = {
		name: "self-evo",
		source: "magenta",
		description: "Development mode for evolving Magenta's harness.",
		contentPath: join(getHarnessSkillsDir(), "self-evo", "magenta", "SKILL.md"),
	};

	toResource() {
		return skillSourceResource(this.definition);
	}
}
