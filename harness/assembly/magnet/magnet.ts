import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { HcpServer } from "../hcp/hcp.ts";

/**
 * A resolved non-tool capability binding produced by a magnet.
 *
 * Where {@link HcpMagnet.toTool} yields an LLM-facing tool for the loop hot path,
 * {@link HcpMagnet.toCapability} yields the in-process implementation that a
 * harness consumer (loop, session, hooks, ...) injects and calls directly.
 * The `instance` is the source-selected implementation object; the assembly
 * layer resolves *which* source to load, so the LLM never perceives the source.
 */
export interface CapabilityBinding<T = unknown> {
	/** Capability kind, e.g. `"compaction"`, `"memory"`. */
	kind: string;
	/** Component name within the kind, e.g. `"compaction"`, `"session-grounding"`. */
	name: string;
	/** The selected source that supplied this implementation, e.g. `"pi"`, `"magenta"`. */
	source: string;
	/** The source-selected implementation object, injected into consumers at assembly time. */
	instance: T;
}

/**
 * A HcpMagnet is a connector that adapts one kind of implementation (native TS
 * today; MCP / API / process later) into the shapes the harness assembly layer
 * consumes: a loop-ready {@link AgentTool} (LLM hot path), a non-tool
 * {@link CapabilityBinding} (in-process capability the loop/session injects),
 * and/or an {@link HcpServer} for management. Magnets run at assembly time only
 * — they are how concrete implementations get "attracted" into the harness
 * regardless of source.
 *
 * Invariant: a magnet produces at most one of {@link HcpMagnet.toTool} /
 * {@link HcpMagnet.toCapability}. A tool never lands on the capability map, and a
 * capability never leaks onto the LLM tool hot path.
 */
export interface HcpMagnet {
	/** Discriminator for the kind of implementation this magnet connects (for example `"native"`). */
	kind: string;
	/** Produce a loop-ready tool, if this magnet yields one. */
	toTool?(): AgentTool;
	/** Produce a source-selected non-tool capability binding, if this magnet yields one. */
	toCapability?(): CapabilityBinding;
	/** Produce a management endpoint, if this magnet exposes one over HCP. */
	toHcpServer?(): HcpServer;
}
