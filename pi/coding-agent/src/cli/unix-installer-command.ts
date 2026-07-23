import { installLocalUnixRelease, uninstallLocalUnixRelease } from "../utils/unix-installer.ts";

export interface UnixInstallerArguments {
	installDirectory: string;
	resourceArchive: string;
	checksumsFile: string;
	binaryAssetName: string;
	expectedVersion: string;
	entrypointPath?: string;
	legacyInstallDirectory?: string;
}

export interface UnixUninstallerArguments {
	installDirectory: string;
	entrypointPath?: string;
	legacyInstallDirectory?: string;
}

function parsePairedArguments(args: readonly string[], allowed: ReadonlySet<string>): Map<string, string> {
	const values = new Map<string, string>();
	for (let index = 0; index < args.length; index += 2) {
		const flag = args[index];
		const value = args[index + 1];
		if (!flag || !allowed.has(flag))
			throw new Error(`Unknown Unix installer helper argument: ${flag ?? "<missing>"}`);
		if (!value || value.startsWith("--")) throw new Error(`Unix installer helper argument requires a value: ${flag}`);
		if (values.has(flag)) throw new Error(`Duplicate Unix installer helper argument: ${flag}`);
		values.set(flag, value);
	}
	return values;
}

/** @internal */
export function parseUnixInstallerArguments(args: readonly string[]): UnixInstallerArguments {
	const values = new Map<string, string>();
	const allowed = new Set([
		"--install-dir",
		"--resource-archive",
		"--checksums",
		"--binary-asset",
		"--expected-version",
		"--entrypoint-path",
		"--legacy-install-dir",
	]);
	for (const [flag, value] of parsePairedArguments(args, allowed)) values.set(flag, value);
	const requireValue = (flag: string): string => {
		const value = values.get(flag);
		if (!value) throw new Error(`Missing Unix installer helper argument: ${flag}`);
		return value;
	};
	return {
		installDirectory: requireValue("--install-dir"),
		resourceArchive: requireValue("--resource-archive"),
		checksumsFile: requireValue("--checksums"),
		binaryAssetName: requireValue("--binary-asset"),
		expectedVersion: requireValue("--expected-version"),
		...(values.has("--entrypoint-path") ? { entrypointPath: values.get("--entrypoint-path") as string } : {}),
		...(values.has("--legacy-install-dir")
			? { legacyInstallDirectory: values.get("--legacy-install-dir") as string }
			: {}),
	};
}

/** @internal */
export function parseUnixUninstallerArguments(args: readonly string[]): UnixUninstallerArguments {
	const values = parsePairedArguments(args, new Set(["--install-dir", "--entrypoint-path", "--legacy-install-dir"]));
	const installDirectory = values.get("--install-dir");
	if (!installDirectory) throw new Error("Missing Unix installer helper argument: --install-dir");
	return {
		installDirectory,
		...(values.has("--entrypoint-path") ? { entrypointPath: values.get("--entrypoint-path") as string } : {}),
		...(values.has("--legacy-install-dir")
			? { legacyInstallDirectory: values.get("--legacy-install-dir") as string }
			: {}),
	};
}

export async function handleUnixInstallerCommand(args: readonly string[]): Promise<void> {
	const parsed = parseUnixInstallerArguments(args);
	const testMode = process.env.MAGENTA_INSTALL_TEST_MODE === "1";
	const faultPoint = process.env.MAGENTA_INSTALL_TEST_FAULT;
	const operationId = process.env.MAGENTA_INSTALL_TEST_OPERATION_ID;
	if ((faultPoint || operationId) && !testMode) {
		throw new Error("Unix installer test controls require MAGENTA_INSTALL_TEST_MODE=1");
	}
	const result = await installLocalUnixRelease({
		...parsed,
		candidateBinary: process.execPath,
		launchedExecutable: process.execPath,
		operationId: testMode ? operationId : undefined,
		testFaultInjector: faultPoint
			? (point) => {
					if (point === faultPoint) throw new Error(`Injected Unix installer interruption at ${point}`);
				}
			: undefined,
	});
	for (const warning of result.warnings) process.stderr.write(`Installer cleanup warning: ${warning}\n`);
	process.stdout.write(`Magenta ${result.version} installed successfully.\n`);
}

export async function handleUnixUninstallerCommand(args: readonly string[]): Promise<void> {
	const parsed = parseUnixUninstallerArguments(args);
	const result = await uninstallLocalUnixRelease(parsed);
	for (const warning of result.warnings) process.stderr.write(`Uninstaller warning: ${warning}\n`);
	process.stdout.write(result.removed ? "Magenta uninstalled successfully.\n" : "Magenta is not installed.\n");
}
