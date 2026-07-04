import { compactionPiMagnet } from "../../modules/compaction/pi/magnet.ts";
import { contextMagentaMagnet } from "../../modules/context/magenta/magnet.ts";
import { hookMagentaMagnet } from "../../modules/hooks/magenta/magnet.ts";
import { memoryMagentaMagnet } from "../../modules/memory/magenta/magnet.ts";
import { policyMagentaMagnet } from "../../modules/policy/magenta/magnet.ts";
import { promptTemplatePiMagnet } from "../../modules/prompt-templates/pi/magnet.ts";
import { runtimeMagentaMagnet } from "../../modules/runtime/magenta/magnet.ts";
import { sandboxMagentaMagnet } from "../../modules/sandbox/magenta/magnet.ts";
import { systemPromptPiMagnet } from "../../modules/system-prompt/pi/magnet.ts";
import type { CapabilitySourceMagnet } from "../../hcp-contract/hcp-magnet.ts";

/**
 * The dumb aggregation barrel of capability source magnets (spec §8).
 *
 * This is the ONE place the harness statically lists its built-in capability
 * sources — but it is deliberately NOT a "second registry": it holds no
 * selection logic. It only re-exports the source-owned descriptors (each of
 * which lives in `<module>/<source>/magnet.ts` and imports its own provider via
 * a literal specifier, so the build's extension rewrite keeps it loadable in
 * both `.ts` and built `dist/.js` form). The builder table and default-source
 * map that USED to live centrally are now DERIVED from this array
 * (`capability.ts`); which source is active for a slot is decided by the single
 * HcpClient / package overlay, never here.
 *
 * A static import list is unavoidable under this build (computed dynamic imports
 * are not extension-rewritten and break in `dist/` and in the bun binary); the
 * design constraint is documented in `docs/governance/hcp-rollout-progress.md`.
 * The invariant §10.1 protects — no second SELECTION registry — is preserved
 * because this barrel makes no selection decisions.
 */
export const CAPABILITY_SOURCE_MAGNETS: readonly CapabilitySourceMagnet[] = [
	compactionPiMagnet,
	contextMagentaMagnet,
	hookMagentaMagnet,
	memoryMagentaMagnet,
	policyMagentaMagnet,
	promptTemplatePiMagnet,
	runtimeMagentaMagnet,
	sandboxMagentaMagnet,
	systemPromptPiMagnet,
];
