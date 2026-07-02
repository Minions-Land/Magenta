import type { HcpRegistry, HcpTargetDescription } from "../../hcp/pi/hcp.ts";
import type { Magnet } from "./magnet.ts";

export type DuplicateMagnetHcpTargetPolicy = "error" | "replace" | "skip";

export interface RegisterMagnetHcpTargetsOptions {
	duplicates?: DuplicateMagnetHcpTargetPolicy;
}

export interface MagnetHcpTargetRegistration {
	target: string;
	kind: string;
	magnetKind: string;
	description: HcpTargetDescription;
}

export interface MagnetHcpTargetSkip {
	magnetKind: string;
	reason: "no_hcp_target" | "duplicate";
	target?: string;
}

export interface RegisterMagnetHcpTargetsResult {
	registrations: MagnetHcpTargetRegistration[];
	skipped: MagnetHcpTargetSkip[];
}

/**
 * Register the management side of a Magnet collection into an HCP registry.
 *
 * The agent loop still receives `magnet.toTool()` directly. This helper only
 * wires the assembly/control surface, using exact target addresses so multiple
 * tool magnets cannot accidentally shadow each other under the same prefix.
 */
export function registerMagnetHcpTargets(
	registry: HcpRegistry,
	magnets: Iterable<Magnet>,
	options: RegisterMagnetHcpTargetsOptions = {},
): RegisterMagnetHcpTargetsResult {
	const duplicatePolicy = options.duplicates ?? "error";
	const registeredTargets = new Set(registry.addresses());
	const registrations: MagnetHcpTargetRegistration[] = [];
	const skipped: MagnetHcpTargetSkip[] = [];

	for (const magnet of magnets) {
		const target = magnet.toHcpTarget?.();
		if (!target) {
			skipped.push({ magnetKind: magnet.kind, reason: "no_hcp_target" });
			continue;
		}

		const description = target.describe();
		if (!description.target) {
			throw new Error(`Magnet ${magnet.kind} returned an HCP target without an address`);
		}

		if (registeredTargets.has(description.target)) {
			if (duplicatePolicy === "skip") {
				skipped.push({ magnetKind: magnet.kind, reason: "duplicate", target: description.target });
				continue;
			}
			if (duplicatePolicy === "error") {
				throw new Error(`Duplicate Magnet HCP target: ${description.target}`);
			}
		}

		registry.registerExact(description.target, target);
		registeredTargets.add(description.target);
		registrations.push({
			target: description.target,
			kind: description.kind,
			magnetKind: magnet.kind,
			description,
		});
	}

	return { registrations, skipped };
}
