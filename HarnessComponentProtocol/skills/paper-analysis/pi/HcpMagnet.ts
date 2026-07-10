import { join } from "node:path";
import type { HcpMagnetBuildContext } from "../../../.HCP/HcpMagnetTypes.ts";
import { getHarnessSkillsDir, type SkillSourceDefinition, skillSourceResource } from "../../HcpServer.ts";

export class HcpMagnet {
	static readonly module = "skills/paper-analysis";
	static readonly kind = "skill";
	static readonly source = "pi";
	static build(_context: HcpMagnetBuildContext) {
		return new HcpMagnet();
	}

	readonly kind = "resource:skill";
	private readonly definition: SkillSourceDefinition = {
		name: "paper-analysis",
		source: "pi",
		description: "Deep analysis of academic papers.",
		contentPath: join(getHarnessSkillsDir(), "paper-analysis", "pi", "SKILL.md"),
	};

	toResource() {
		return skillSourceResource(this.definition);
	}
}
