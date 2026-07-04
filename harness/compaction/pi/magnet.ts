import type { CapabilitySourceMagnet } from "../../hcp-contract/hcp-magnet.ts";
import { piCompactionProvider } from "./provider.ts";

/**
 * The pi source's binding for the `compaction` capability (spec §8).
 *
 * Lives next to the implementation it builds and imports the provider via a
 * literal sibling import, so it survives the build extension rewrite. Registered
 * centrally only through the dumb `sources.ts` barrel.
 */
export const compactionPiMagnet: CapabilitySourceMagnet = {
	kind: "compaction",
	source: "pi",
	isDefault: true,
	build: () => piCompactionProvider,
};
