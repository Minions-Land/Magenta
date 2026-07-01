import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { HcpTarget } from "../../hcp/pi/hcp.ts";

/**
 * A Magnet is a connector that adapts one kind of implementation (native TS
 * today; MCP / API / process later) into the shapes the harness assembly layer
 * consumes: a loop-ready {@link AgentTool} and/or an {@link HcpTarget} for
 * management. Magnets run at assembly time only — they are how concrete
 * implementations get "attracted" into the loop's tool set.
 */
export interface Magnet {
	/** Discriminator for the kind of implementation this magnet connects (for example `"native"`). */
	kind: string;
	/** Produce a loop-ready tool, if this magnet yields one. */
	toTool?(): AgentTool;
	/** Produce a management endpoint, if this magnet exposes one over HCP. */
	toHcpTarget?(): HcpTarget;
}
