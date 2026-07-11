import {
	type HcpClientassemblydiagnostic,
	HcpClientbuildsession,
	type HcpClientbuildsessionoptions,
	type HcpClientbuildsessionresult,
} from "../.HCP/assembly/session-hcp.ts";
import { HcpClientpackageinputfromoverlay } from "../_magenta/packages/hcp-client-components.ts";
import type {
	PackageAssemblyProgress,
	PackageDiagnostic,
	PackageOverlay,
} from "../_magenta/packages/package-overlay.ts";

export type HcpClientpackagetestbuildoptions = Omit<HcpClientbuildsessionoptions, "components"> & {
	overlay: PackageOverlay;
	onPackageAssemblyProgress?: (progress: PackageAssemblyProgress) => void;
};

export type HcpClientpackagetestbuildresult = Omit<HcpClientbuildsessionresult, "diagnostics"> & {
	diagnostics: Array<PackageDiagnostic | HcpClientassemblydiagnostic>;
	packageToolAddresses: string[];
	packageResourceAddresses: string[];
};

/** Exercise the host Package adapter through the same generic session Client used in production. */
export async function HcpClientbuildpackagesessionfortest(
	options: HcpClientpackagetestbuildoptions,
): Promise<HcpClientpackagetestbuildresult> {
	const { overlay, onPackageAssemblyProgress, ...sessionOptions } = options;
	const input = HcpClientpackageinputfromoverlay(overlay);
	for (const [index, component] of overlay.components.entries()) {
		onPackageAssemblyProgress?.({ phase: "start", index, total: overlay.components.length, component });
	}

	let session: HcpClientbuildsessionresult | undefined;
	try {
		session = await HcpClientbuildsession({ ...sessionOptions, components: input.components });
		const packageComponents = new Set(input.components);
		const packageToolAddresses = session.builtComponents
			.filter(({ component }) => packageComponents.has(component) && component.product === "tool")
			.flatMap(({ addresses }) => addresses)
			.filter((address) => address.startsWith("tool:"));
		const packageResourceAddresses = session.builtComponents
			.filter(({ component }) => packageComponents.has(component) && component.product === "resource")
			.flatMap(({ addresses }) => addresses);

		for (const [index, component] of overlay.components.entries()) {
			onPackageAssemblyProgress?.({ phase: "assembled", index, total: overlay.components.length, component });
		}

		return {
			...session,
			diagnostics: [...input.diagnostics, ...input.toolDiagnostics, ...session.diagnostics],
			packageToolAddresses: [...new Set(packageToolAddresses)],
			packageResourceAddresses: [...new Set(packageResourceAddresses)],
		};
	} catch (error) {
		await session?.hcp.dispose();
		throw error;
	}
}
