import { spawnSync } from "node:child_process";
import { MACOS_RELEASE_APPLE_TEAM_ID } from "../macos-release-trust.generated.ts";

const APPLE_TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/;

export interface MacosReleaseVerificationOptions {
	expectedIdentifier?: string;
	expectedTeamId?: string;
	runCommand?(
		command: string,
		args: readonly string[],
	): {
		error?: Error;
		status: number | null;
		stderr?: string;
		stdout?: string;
	};
}

export function getExpectedMacosReleaseTeamId(value = MACOS_RELEASE_APPLE_TEAM_ID): string {
	if (!APPLE_TEAM_ID_PATTERN.test(value)) {
		throw new Error("macOS release trust is unconfigured; refusing to execute or install a downloaded candidate");
	}
	return value;
}

export function verifyMacosReleaseCandidate(path: string, options: MacosReleaseVerificationOptions = {}): void {
	const expectedIdentifier = options.expectedIdentifier ?? "land.minions.magenta";
	const expectedTeamId = getExpectedMacosReleaseTeamId(options.expectedTeamId);
	const runCommand =
		options.runCommand ??
		((command: string, args: readonly string[]) =>
			spawnSync(command, [...args], { encoding: "utf8", timeout: 60_000 }));
	const run = (command: string, args: readonly string[]): string => {
		const result = runCommand(command, args);
		if (result.error) throw result.error;
		if (result.status !== 0) {
			throw new Error(
				`macOS release verification failed: ${command} ${args.join(" ")}: ${String(result.stderr ?? "").trim()}`,
			);
		}
		return `${result.stdout ?? ""}${result.stderr ?? ""}`;
	};
	run("/usr/bin/codesign", ["--verify", "--strict", "--check-notarization", "--verbose=2", path]);
	run("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", path]);
	const signature = run("/usr/bin/codesign", ["--display", "--verbose=4", path]);
	const identifier = /^Identifier=(.+)$/m.exec(signature)?.[1];
	const teamId = /^TeamIdentifier=([A-Z0-9]+)$/m.exec(signature)?.[1];
	if (
		identifier !== expectedIdentifier ||
		!/^Authority=Developer ID Application:/m.test(signature) ||
		teamId !== expectedTeamId ||
		!/^Timestamp=.+$/m.test(signature) ||
		!/^CodeDirectory .*flags=.*\bruntime\b/m.test(signature) ||
		/^Signature=adhoc$/m.test(signature)
	) {
		throw new Error(
			`macOS release candidate does not match the trusted Developer ID contract (identifier=${identifier ?? "missing"}, team=${teamId ?? "missing"})`,
		);
	}
}
