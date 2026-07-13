import { join } from "node:path";
import type { HcpMagnetBuildContext } from "../../../.HCP/HcpMagnetTypes.ts";
import { getHarnessSkillsDir, type SkillSourceDefinition, skillSourceResource } from "../../HcpServer.ts";

export class HcpMagnet {
	static readonly module = "skills/research-orchestration";
	static readonly kind = "skill";
	static readonly source = "pi";
	static build(_context: HcpMagnetBuildContext) {
		return new HcpMagnet();
	}

	readonly kind = "resource:skill";
	private readonly definition: SkillSourceDefinition = {
		name: "research-orchestration",
		source: "pi",
		description: "Explicit research iteration with the session Todo as the single planning and progress source.",
		contentPath: join(getHarnessSkillsDir(), "research-orchestration", "pi", "SKILL.md"),
	};

	toResource() {
		return skillSourceResource(this.definition);
	}
}
