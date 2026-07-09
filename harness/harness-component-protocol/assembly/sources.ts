import type { HcpMagnetClass } from "../../harness-component-protocol/HcpMagnetTypes.ts";
import { HcpMagnet as CompactionPiMagnet } from "../../modules/compaction/pi/HcpMagnet.ts";
import { HcpMagnet as ContextMagentaMagnet } from "../../modules/context/magenta/HcpMagnet.ts";
import { HcpMagnet as HookMagentaMagnet } from "../../modules/hooks/magenta/HcpMagnet.ts";
import { HcpMagnet as MemoryMagentaMagnet } from "../../modules/memory/magenta/HcpMagnet.ts";
import { HcpMagnet as MultiagentMagentaMagnet } from "../../modules/multiagent/workflow/magenta/HcpMagnet.ts";
import { HcpMagnet as PolicyMagentaMagnet } from "../../modules/policy/magenta/HcpMagnet.ts";
import { HcpMagnet as PromptTemplatePiMagnet } from "../../modules/prompt-templates/pi/HcpMagnet.ts";
import { HcpMagnet as RuntimeMagentaMagnet } from "../../modules/runtime/magenta/HcpMagnet.ts";
import { HcpMagnet as SandboxMagentaMagnet } from "../../modules/sandbox/magenta/HcpMagnet.ts";
import { HcpMagnet as SystemPromptPiMagnet } from "../../modules/system-prompt/pi/HcpMagnet.ts";

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
export const CAPABILITY_SOURCE_MAGNETS: readonly HcpMagnetClass[] = [
	CompactionPiMagnet,
	ContextMagentaMagnet,
	HookMagentaMagnet,
	MemoryMagentaMagnet,
	MultiagentMagentaMagnet,
	PolicyMagentaMagnet,
	PromptTemplatePiMagnet,
	RuntimeMagentaMagnet,
	SandboxMagentaMagnet,
	SystemPromptPiMagnet,
];
