import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyMacosReleaseTrustAgreement } from "./verify-macos-release-trust-agreement.mjs";

const schema = "magenta.macos-release-trust.v1";

test("requires strict, matching source and distribution Apple Team IDs", () => {
	const root = mkdtempSync(join(tmpdir(), "magenta-trust-agreement-"));
	const sourcePath = join(root, "source.json");
	const distributionPath = join(root, "distribution.json");
	try {
		writeFileSync(sourcePath, `${JSON.stringify({ schema, appleTeamId: "ABCDE12345" })}\n`);
		writeFileSync(distributionPath, `${JSON.stringify({ schema, appleTeamId: "ABCDE12345" })}\n`);
		assert.equal(verifyMacosReleaseTrustAgreement({ distributionPath, sourcePath }), "ABCDE12345");

		writeFileSync(distributionPath, `${JSON.stringify({ schema, appleTeamId: "ZZZZZ99999" })}\n`);
		assert.throws(
			() => verifyMacosReleaseTrustAgreement({ distributionPath, sourcePath }),
			/does not match source-owned release trust/u,
		);

		writeFileSync(distributionPath, `${JSON.stringify({ schema, appleTeamId: "UNCONFIGURED" })}\n`);
		assert.throws(
			() => verifyMacosReleaseTrustAgreement({ distributionPath, sourcePath }),
			/release trust is unconfigured/u,
		);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});
