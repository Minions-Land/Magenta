import type { HcpClient, HcpServerDescription } from "../hcp/hcp.ts";
import type { HcpMagnet } from "./magnet.ts";

export type DuplicateMagnetHcpServerPolicy = "error" | "replace" | "skip";

export interface RegisterMagnetHcpServersOptions {
	duplicates?: DuplicateMagnetHcpServerPolicy;
}

export interface MagnetHcpServerRegistration {
	target: string;
	kind: string;
	magnetKind: string;
	description: HcpServerDescription;
}

export interface MagnetHcpServerSkip {
	magnetKind: string;
	reason: "no_hcp_target" | "duplicate";
	target?: string;
}

export interface RegisterMagnetHcpServersResult {
	registrations: MagnetHcpServerRegistration[];
	skipped: MagnetHcpServerSkip[];
}

/**
 * Register the management side of a HcpMagnet collection into an HCP registry.
 *
 * The agent loop still receives `magnet.toTool()` directly. This helper only
 * wires the assembly/control surface, using exact target addresses so multiple
 * tool magnets cannot accidentally shadow each other under the same prefix.
 */
export function registerMagnetHcpServers(
	registry: HcpClient,
	magnets: Iterable<HcpMagnet>,
	options: RegisterMagnetHcpServersOptions = {},
): RegisterMagnetHcpServersResult {
	const duplicatePolicy = options.duplicates ?? "error";
	const registeredTargets = new Set(registry.addresses());
	const registrations: MagnetHcpServerRegistration[] = [];
	const skipped: MagnetHcpServerSkip[] = [];

	for (const magnet of magnets) {
		const target = magnet.toHcpServer?.();
		if (!target) {
			skipped.push({ magnetKind: magnet.kind, reason: "no_hcp_target" });
			continue;
		}

		const description = target.describe();
		if (!description.target) {
			throw new Error(`HcpMagnet ${magnet.kind} returned an HCP target without an address`);
		}

		if (registeredTargets.has(description.target)) {
			if (duplicatePolicy === "skip") {
				skipped.push({ magnetKind: magnet.kind, reason: "duplicate", target: description.target });
				continue;
			}
			if (duplicatePolicy === "error") {
				throw new Error(`Duplicate HcpMagnet HCP target: ${description.target}`);
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
