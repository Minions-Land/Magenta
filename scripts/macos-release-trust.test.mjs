import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	MACOS_RELEASE_TRUST_PATH,
	MACOS_RELEASE_TRUST_PLACEHOLDER,
	MACOS_RELEASE_TRUST_SCHEMA,
	normalizeAppleTeamId,
	parseMacosReleaseTrust,
	readMacosReleaseTrust,
} from "./macos-release-trust.mjs";

const TEAM_ID = "ABCDE12345";

test("checked-in release trust accepts either the explicit placeholder or one valid source-owned Team ID", () => {
	const sourceTrust = readMacosReleaseTrust(MACOS_RELEASE_TRUST_PATH, { allowUnconfigured: true });
	assert.equal(sourceTrust.schema, MACOS_RELEASE_TRUST_SCHEMA);
	if (sourceTrust.appleTeamId === MACOS_RELEASE_TRUST_PLACEHOLDER) {
		assert.throws(() => readMacosReleaseTrust(MACOS_RELEASE_TRUST_PATH), /release trust is unconfigured/u);
	} else {
		assert.equal(readMacosReleaseTrust(MACOS_RELEASE_TRUST_PATH).appleTeamId, sourceTrust.appleTeamId);
		assert.equal(normalizeAppleTeamId(sourceTrust.appleTeamId), sourceTrust.appleTeamId);
	}
});

test("accepts one exact source-owned Apple Team ID", () => {
	const root = mkdtempSync(join(tmpdir(), "magenta-release-trust-"));
	const path = join(root, "trust.json");
	try {
		writeFileSync(path, `${JSON.stringify({ appleTeamId: TEAM_ID, schema: MACOS_RELEASE_TRUST_SCHEMA })}\n`);
		assert.deepEqual(readMacosReleaseTrust(path), {
			appleTeamId: TEAM_ID,
			schema: MACOS_RELEASE_TRUST_SCHEMA,
		});
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test("rejects malformed, placeholder, and ambiguous trust configuration", () => {
	assert.throws(() => normalizeAppleTeamId("abcde12345"), /uppercase ASCII/u);
	assert.throws(() => normalizeAppleTeamId("ABCDE1234"), /exactly 10/u);
	assert.throws(
		() => parseMacosReleaseTrust('{"schema":"magenta.macos-release-trust.v1","appleTeamId":"UNCONFIGURED"}'),
		/unconfigured/u,
	);
	assert.throws(
		() =>
			parseMacosReleaseTrust(
				'{"schema":"magenta.macos-release-trust.v1","appleTeamId":"ABCDE12345","fallbackTeamId":"ZZZZZ99999"}',
			),
		/only schema and appleTeamId/u,
	);
});
