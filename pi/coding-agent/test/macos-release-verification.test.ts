import { describe, expect, it, vi } from "vitest";
import { getExpectedMacosReleaseTeamId, verifyMacosReleaseCandidate } from "../src/utils/macos-release-verification.ts";

const TEAM_ID = "ABCDE12345";
const SIGNATURE = `Executable=/tmp/magenta
Identifier=land.minions.magenta
Authority=Developer ID Application: Magenta (${TEAM_ID})
TeamIdentifier=${TEAM_ID}
Timestamp=Jul 23, 2026 at 01:00:00
CodeDirectory v=20500 size=123 flags=0x10000(runtime) hashes=1+2 location=embedded
`;

describe("macOS release verification", () => {
	it("requires configured source-owned trust", () => {
		expect(() => getExpectedMacosReleaseTeamId("UNCONFIGURED")).toThrow(/trust is unconfigured/u);
		expect(getExpectedMacosReleaseTeamId(TEAM_ID)).toBe(TEAM_ID);
	});

	it("accepts the exact notarized identifier and Apple Team ID", () => {
		const runCommand = vi.fn((_command: string, args: readonly string[]) => ({
			status: 0,
			stderr: args.includes("--display") ? SIGNATURE : "",
			stdout: "",
		}));
		expect(() => verifyMacosReleaseCandidate("/tmp/magenta", { expectedTeamId: TEAM_ID, runCommand })).not.toThrow();
		expect(runCommand).toHaveBeenCalledTimes(3);
	});

	it("rejects another valid Developer ID team and an ad-hoc signature", () => {
		for (const signature of [SIGNATURE.replaceAll(TEAM_ID, "ZZZZZ99999"), `${SIGNATURE}Signature=adhoc\n`]) {
			const runCommand = (_command: string, args: readonly string[]) => ({
				status: 0,
				stderr: args.includes("--display") ? signature : "",
				stdout: "",
			});
			expect(() => verifyMacosReleaseCandidate("/tmp/magenta", { expectedTeamId: TEAM_ID, runCommand })).toThrow(
				/trusted Developer ID contract/u,
			);
		}
	});
});
