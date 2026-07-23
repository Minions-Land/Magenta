import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import {
	MACOS_CLIPBOARD_RESOURCE_PATH,
	MACOS_RELEASE_ASSET_NAMES_V0_0_30,
	MACOS_SIGNING_ENV_KEYS,
	captureAppleSigningCredentials,
	executeMacosReleaseSigning,
	parseReleaseChecksumManifest,
	readAppleSigningCredentials,
	sha256File,
	verifyInitialReleaseBundle,
	withEphemeralAppleCredentials,
} from "./macos-release-signing.mjs";

const CERTIFICATE_SHA256 = "a".repeat(64);
const TEAM_ID = "ABCDE12345";
const SIGNING_IDENTITY = `Developer ID Application: Magenta Test (${TEAM_ID})`;
const SOURCE_COMMIT = "b".repeat(40);
const NOTARY_IDS = {
	arm64: "11111111-1111-4111-8111-111111111111",
	x64: "22222222-2222-4222-8222-222222222222",
};

function signingEnvironment(overrides = {}) {
	return {
		MAGENTA_APPLE_NOTARY_ISSUER_ID: "33333333-3333-4333-8333-333333333333",
		MAGENTA_APPLE_NOTARY_KEY_ID: "KEYID12345",
		MAGENTA_APPLE_NOTARY_KEY_P8_BASE64: Buffer.from(
			"-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----\n",
		).toString("base64"),
		MAGENTA_MACOS_CERTIFICATE_P12_BASE64: Buffer.from("synthetic p12").toString("base64"),
		MAGENTA_MACOS_CERTIFICATE_PASSWORD: "synthetic password",
		MAGENTA_MACOS_CERTIFICATE_SHA256: CERTIFICATE_SHA256,
		MAGENTA_MACOS_SIGNING_IDENTITY: SIGNING_IDENTITY,
		MAGENTA_MACOS_TEAM_ID: TEAM_ID,
		...overrides,
	};
}

function writeFixtureFile(path, content) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

function writeChecksums(directory, names) {
	writeFileSync(
		join(directory, "SHA256SUMS"),
		`${names.map((name) => `${sha256File(join(directory, name))}  ${name}`).join("\n")}\n`,
	);
}

function createSigningFixture() {
	const root = mkdtempSync(join(tmpdir(), "magenta-macos-signing-contract-"));
	const embeddedRoot = join(root, "embedded");
	const releaseDir = join(root, "release");
	const resourceRoot = join(root, "resource-root");
	mkdirSync(releaseDir, { recursive: true });

	for (const name of MACOS_RELEASE_ASSET_NAMES_V0_0_30) {
		writeFixtureFile(join(releaseDir, name), name === "SOURCE_COMMIT" ? `${SOURCE_COMMIT}\n` : `initial:${name}\n`);
	}
	writeChecksums(releaseDir, MACOS_RELEASE_ASSET_NAMES_V0_0_30);
	const expectedInitialManifestSha256 = sha256File(join(releaseDir, "SHA256SUMS"));

	for (const kind of ["process-tools", "fd", "rg"]) {
		const directory = join(embeddedRoot, kind, "prebuilt");
		const prefix = kind === "process-tools" ? "magenta-process-tools" : kind;
		const names = [
			`${prefix}-macos-arm64`,
			`${prefix}-macos-x64`,
			`${prefix}-linux-x64`,
			`${prefix}-windows-x64.exe`,
		];
		for (const name of names) writeFixtureFile(join(directory, name), `unsigned:${name}\n`);
		writeChecksums(directory, names);
	}

	const clipboardPath = join(resourceRoot, MACOS_CLIPBOARD_RESOURCE_PATH);
	writeFixtureFile(clipboardPath, "unsigned:clipboard-universal\n");
	const outerEntitlementsPath = join(root, "magenta.entitlements.plist");
	writeFixtureFile(
		outerEntitlementsPath,
		'<?xml version="1.0"?><plist><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>\n',
	);

	return {
		clipboardPath,
		embeddedRoot,
		expectedInitialManifestSha256,
		outerEntitlementsPath,
		receiptPath: join(root, "macos-signing-receipt.json"),
		releaseDir,
		resourceRoot,
		root,
	};
}

function signingCredentials() {
	return {
		certificateP12: Buffer.from("synthetic p12"),
		certificatePassword: "synthetic-certificate-password",
		certificateSha256: CERTIFICATE_SHA256,
		identity: SIGNING_IDENTITY,
		notaryIssuerId: "33333333-3333-4333-8333-333333333333",
		notaryKey: Buffer.from("-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----\n"),
		notaryKeyId: "KEYID12345",
		teamId: TEAM_ID,
	};
}

function architectureForPath(path) {
	if (path.includes("clipboard.darwin-universal.node")) return "x86_64 arm64";
	if (path.includes("macos-x64")) return "x86_64";
	return "arm64";
}

function createMockCommandRunner({
	certificateSha256 = CERTIFICATE_SHA256,
	displayIdentifier,
	failNotaryArchitecture,
	mutateAfterNotarization,
} = {}) {
	const calls = [];
	const events = [];
	const signedIdentifiers = new Map();
	const temporaryPaths = new Set();
	const runCommand = (command, args, options = {}) => {
		calls.push({ args: [...args], command, label: options.label });
		if (command === "security") {
			if (args[0] === "list-keychains" && !args.includes("-s")) {
				return { status: 0, stderr: "", stdout: '    "/Users/test/Library/Keychains/login.keychain-db"\n' };
			}
			if (args[0] === "create-keychain") temporaryPaths.add(args.at(-1));
			if (args[0] === "find-identity") {
				return { status: 0, stderr: "", stdout: `1) synthetic \"${SIGNING_IDENTITY}\"\n` };
			}
			if (args[0] === "find-certificate") {
				return { status: 0, stderr: "", stdout: `SHA-256 hash: ${certificateSha256.toUpperCase()}\n` };
			}
			return { status: 0, stderr: "", stdout: "" };
		}
		if (command === "lipo") {
			return { status: 0, stderr: "", stdout: `${architectureForPath(args.at(-1))}\n` };
		}
		if (command === "codesign" && args[0] === "--force") {
			const path = args.at(-1);
			signedIdentifiers.set(path, args[args.indexOf("--identifier") + 1]);
			events.push(`sign:${basename(path)}`);
			writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from("signed\n")]));
			return { status: 0, stderr: "", stdout: "" };
		}
		if (command === "codesign" && args[0] === "--display") {
			return {
				status: 0,
				stderr: [
					`Identifier=${displayIdentifier ?? signedIdentifiers.get(args.at(-1))}`,
					"CodeDirectory v=20500 flags=0x10000(runtime)",
					"Authority=Developer ID Application: Magenta Test (ABCDE12345)",
					"Timestamp=Jul 23, 2026 at 00:00:00",
					`TeamIdentifier=${TEAM_ID}`,
					"CDHash=abcdef0123456789",
				].join("\n"),
				stdout: "",
			};
		}
		if (command === "codesign") return { status: 0, stderr: "", stdout: "" };
		if (command === "ditto") {
			const archive = args.at(-1);
			writeFixtureFile(archive, `synthetic notary archive:${basename(archive)}\n`);
			return { status: 0, stderr: "", stdout: "" };
		}
		if (command === "xcrun" && args[0] === "notarytool" && args[1] === "submit") {
			const architecture = args[2].includes("x64") ? "x64" : "arm64";
			events.push(`notarize:${architecture}`);
			if (architecture === failNotaryArchitecture) throw new Error("synthetic notary failure");
			if (architecture === "x64") mutateAfterNotarization?.(signedIdentifiers);
			return {
				status: 0,
				stderr: "",
				stdout: JSON.stringify({ id: NOTARY_IDS[architecture], status: "Accepted" }),
			};
		}
		if (command === "xcrun" && args[0] === "notarytool" && args[1] === "log") {
			return { status: 0, stderr: "", stdout: JSON.stringify({ id: args[2], issues: [] }) };
		}
		if (command === "spctl") return { status: 0, stderr: "", stdout: "accepted\n" };
		throw new Error(`Unexpected command: ${command} ${args[0] ?? ""}`);
	};
	return { calls, events, runCommand, temporaryPaths };
}

function executeFixture(fixture, runner, overrides = {}) {
	return executeMacosReleaseSigning({
		credentials: signingCredentials(),
		embeddedRoot: fixture.embeddedRoot,
		expectedInitialManifestSha256: fixture.expectedInitialManifestSha256,
		expectedTeamId: TEAM_ID,
		now: () => new Date("2026-07-23T00:00:00.000Z"),
		outerEntitlementsPath: fixture.outerEntitlementsPath,
		rebuildOuterBinaries: async ({ embeddedPayloads, outerBinaries }) => {
			runner.events.push("rebuild:outer-binaries");
			for (const outer of outerBinaries) writeFixtureFile(outer.path, `rebuilt:${outer.assetName}\n`);
			return {
				embeddedPayloadSha256: Object.fromEntries(
					embeddedPayloads.map((payload) => [payload.relativePath, payload.afterSha256]),
				),
			};
		},
		receiptPath: fixture.receiptPath,
		releaseDir: fixture.releaseDir,
		repackResourceArchive: async ({ clipboard, resourceArchivePath }) => {
			runner.events.push("repack:resource-archive");
			writeFixtureFile(resourceArchivePath, `repacked:${clipboard.afterSha256}\n`);
			return {
				clipboardSha256: clipboard.afterSha256,
				resourceArchiveSha256: sha256File(resourceArchivePath),
			};
		},
		resourceRoot: fixture.resourceRoot,
		runCommand: runner.runCommand,
		temporaryParent: fixture.root,
		...overrides,
	});
}

test("executes the explicit inside-out signing contract and emits a final receipt", async () => {
	const fixture = createSigningFixture();
	const runner = createMockCommandRunner();
	const immutableBefore = Object.fromEntries(
		MACOS_RELEASE_ASSET_NAMES_V0_0_30.filter(
			(name) => !name.startsWith("magenta-macos-") && name !== "magenta-resources-universal.tar.gz",
		).map((name) => [name, sha256File(join(fixture.releaseDir, name))]),
	);
	try {
		const receipt = await executeFixture(fixture, runner);
		assert.equal(receipt.schema, "magenta.macos-signing-receipt.v1");
		assert.equal(receipt.sourceCommit, SOURCE_COMMIT);
		assert.equal(receipt.certificate.teamId, TEAM_ID);
		assert.equal(receipt.certificate.sha256, CERTIFICATE_SHA256);
		assert.deepEqual(
			receipt.notarization.map(({ architecture, status }) => ({ architecture, status })),
			[
				{ architecture: "arm64", status: "Accepted" },
				{ architecture: "x64", status: "Accepted" },
			],
		);
		assert.equal(sha256File(join(fixture.releaseDir, "SHA256SUMS")), receipt.finalManifestSha256);
		assert.notEqual(receipt.finalManifestSha256, receipt.initialManifestSha256);
		assert.deepEqual(
			[...parseReleaseChecksumManifest(readFileSync(join(fixture.releaseDir, "SHA256SUMS"), "utf8")).keys()],
			MACOS_RELEASE_ASSET_NAMES_V0_0_30,
		);
		for (const [name, hash] of Object.entries(immutableBefore)) {
			assert.equal(sha256File(join(fixture.releaseDir, name)), hash, name);
		}

		const rebuildIndex = runner.events.indexOf("rebuild:outer-binaries");
		const clipboardIndex = runner.events.indexOf("sign:clipboard.darwin-universal.node");
		const repackIndex = runner.events.indexOf("repack:resource-archive");
		const firstOuterIndex = runner.events.indexOf("sign:magenta-macos-arm64");
		const lastOuterIndex = runner.events.indexOf("sign:magenta-macos-x64");
		const firstNotaryIndex = runner.events.indexOf("notarize:arm64");
		const secondNotaryIndex = runner.events.indexOf("notarize:x64");
		assert.equal(runner.events.slice(0, rebuildIndex).filter((event) => event.startsWith("sign:")).length, 6);
		assert.ok(rebuildIndex < clipboardIndex);
		assert.ok(clipboardIndex < repackIndex);
		assert.ok(repackIndex < firstOuterIndex);
		assert.ok(firstOuterIndex < lastOuterIndex);
		assert.ok(lastOuterIndex < firstNotaryIndex);
		assert.ok(firstNotaryIndex < secondNotaryIndex);
		const onlineVerifications = runner.calls.filter(
			(call) => call.command === "codesign" && call.args.includes("--check-notarization"),
		);
		assert.equal(onlineVerifications.length, 9);
		assert.ok(
			onlineVerifications.every(
				(call) =>
					call.args.includes("--test-requirement") &&
					call.args.includes(
						"=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists",
					),
			),
		);
		assert.doesNotMatch(readFileSync(fixture.receiptPath, "utf8"), /synthetic-certificate-password/u);

		const createdKeychain = runner.calls.find(
			(call) => call.command === "security" && call.args[0] === "create-keychain",
		)?.args.at(-1);
		assert.ok(createdKeychain);
		assert.equal(existsSync(dirname(createdKeychain)), false, "temporary credential directory must be removed");
		assert.ok(
			runner.calls.some((call) => call.command === "security" && call.args[0] === "delete-keychain"),
			"ephemeral keychain must be deleted",
		);
	} finally {
		rmSync(fixture.root, { force: true, recursive: true });
	}
	});

test("rejects a bundle mutation before importing signing credentials", async () => {
	const fixture = createSigningFixture();
	const runner = createMockCommandRunner();
	try {
		writeFileSync(join(fixture.releaseDir, "install.sh"), "tampered installer\n");
		await assert.rejects(() => executeFixture(fixture, runner), /Initial checksum mismatch for install\.sh/u);
		assert.equal(runner.calls.length, 0);
	} finally {
		rmSync(fixture.root, { force: true, recursive: true });
	}
});

test("always removes ephemeral Apple credentials when notarization fails", async () => {
	const fixture = createSigningFixture();
	const runner = createMockCommandRunner({ failNotaryArchitecture: "x64" });
	try {
		await assert.rejects(() => executeFixture(fixture, runner), /synthetic notary failure/u);
		const createdKeychain = runner.calls.find(
			(call) => call.command === "security" && call.args[0] === "create-keychain",
		)?.args.at(-1);
		assert.ok(createdKeychain);
		assert.equal(existsSync(dirname(createdKeychain)), false);
		assert.ok(runner.calls.some((call) => call.command === "security" && call.args[0] === "delete-keychain"));
		assert.ok(
			runner.calls.some(
				(call) => call.command === "security" && call.args[0] === "list-keychains" && call.args.includes("-s"),
			),
		);
	} finally {
		rmSync(fixture.root, { force: true, recursive: true });
	}
});

test("rejects a signed payload changed after notarization", async () => {
	const fixture = createSigningFixture();
	const runner = createMockCommandRunner({
		mutateAfterNotarization: (signedIdentifiers) => {
			const outerPath = [...signedIdentifiers.keys()].find((path) => path.endsWith("magenta-macos-arm64"));
			assert.ok(outerPath);
			writeFileSync(outerPath, Buffer.concat([readFileSync(outerPath), Buffer.from("tampered\n")]));
		},
	});
	try {
		await assert.rejects(() => executeFixture(fixture, runner), /Signed payload changed after signing/u);
	} finally {
		rmSync(fixture.root, { force: true, recursive: true });
	}
});

test("rejects the wrong Developer ID fingerprint and still deletes the keychain", async () => {
	const fixture = createSigningFixture();
	const runner = createMockCommandRunner({ certificateSha256: "c".repeat(64) });
	try {
		await assert.rejects(() => executeFixture(fixture, runner), /certificate fingerprint/u);
		assert.ok(runner.calls.some((call) => call.command === "security" && call.args[0] === "delete-keychain"));
		assert.equal(runner.events.length, 0, "no payload may be signed with an unpinned certificate");
	} finally {
		rmSync(fixture.root, { force: true, recursive: true });
	}
});

test("parses protected-environment credentials without persisting secret material", () => {
	const credentials = readAppleSigningCredentials(
		{
			MAGENTA_APPLE_NOTARY_ISSUER_ID: "33333333-3333-4333-8333-333333333333",
			MAGENTA_APPLE_NOTARY_KEY_ID: "KEYID12345",
			MAGENTA_APPLE_NOTARY_KEY_P8_BASE64: Buffer.from(
				"-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----\n",
			).toString("base64"),
			MAGENTA_MACOS_CERTIFICATE_P12_BASE64: Buffer.from("synthetic p12").toString("base64"),
			MAGENTA_MACOS_CERTIFICATE_PASSWORD: "synthetic password",
			MAGENTA_MACOS_CERTIFICATE_SHA256: CERTIFICATE_SHA256,
			MAGENTA_MACOS_SIGNING_IDENTITY: SIGNING_IDENTITY,
			MAGENTA_MACOS_TEAM_ID: TEAM_ID,
		},
		{ expectedTeamId: TEAM_ID },
	);
	assert.equal(credentials.teamId, TEAM_ID);
	assert.equal(credentials.certificateSha256, CERTIFICATE_SHA256);
	assert.equal(credentials.certificateP12.toString("utf8"), "synthetic p12");
});

test("captures Apple credentials and scrubs every signing variable before child processes run", () => {
	const unrelatedKey = "MAGENTA_SIGNING_TEST_UNRELATED";
	const keysToRestore = [...MACOS_SIGNING_ENV_KEYS, unrelatedKey];
	const saved = new Map(keysToRestore.map((key) => [key, process.env[key]]));
	try {
		Object.assign(process.env, signingEnvironment(), { [unrelatedKey]: "retain-this-value" });
		const credentials = captureAppleSigningCredentials(process.env, { expectedTeamId: TEAM_ID });
		assert.equal(credentials.teamId, TEAM_ID);
		assert.equal(credentials.certificatePassword, "synthetic password");
		assert.deepEqual(
			MACOS_SIGNING_ENV_KEYS.filter((key) => process.env[key] !== undefined),
			[],
		);
		assert.equal(process.env[unrelatedKey], "retain-this-value");
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

test("scrubs every signing variable when Apple credential validation fails", () => {
	const unrelatedKey = "MAGENTA_SIGNING_TEST_UNRELATED";
	const keysToRestore = [...MACOS_SIGNING_ENV_KEYS, unrelatedKey];
	const saved = new Map(keysToRestore.map((key) => [key, process.env[key]]));
	try {
		Object.assign(
			process.env,
			signingEnvironment({ MAGENTA_MACOS_TEAM_ID: "ZZZZZ99999" }),
			{ [unrelatedKey]: "retain-this-value" },
		);
		assert.throws(
			() => captureAppleSigningCredentials(process.env, { expectedTeamId: TEAM_ID }),
			/MAGENTA_MACOS_TEAM_ID does not match/u,
		);
		assert.deepEqual(
			MACOS_SIGNING_ENV_KEYS.filter((key) => process.env[key] !== undefined),
			[],
		);
		assert.equal(process.env[unrelatedKey], "retain-this-value");
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

test("requires the versioned asset contract to include install.sh by default", () => {
	const fixture = createSigningFixture();
	try {
		rmSync(join(fixture.releaseDir, "install.sh"));
		const remaining = MACOS_RELEASE_ASSET_NAMES_V0_0_30.filter((name) => name !== "install.sh");
		writeChecksums(fixture.releaseDir, remaining);
		assert.throws(
			() =>
				verifyInitialReleaseBundle({
					expectedManifestSha256: sha256File(join(fixture.releaseDir, "SHA256SUMS")),
					releaseDir: fixture.releaseDir,
				}),
			/asset set mismatch/u,
		);
	} finally {
		rmSync(fixture.root, { force: true, recursive: true });
	}
});

test("rejects a signed payload whose Identifier differs from the signing plan", async () => {
	const fixture = createSigningFixture();
	try {
		const runner = createMockCommandRunner({ displayIdentifier: "land.minions.unexpected" });
		await assert.rejects(
			() => executeFixture(fixture, runner),
			/Signed payload Identifier mismatch/u,
		);
	} finally {
		rmSync(fixture.root, { force: true, recursive: true });
	}
});

test("fails closed when the keychain search list cannot be restored", async () => {
	const root = mkdtempSync(join(tmpdir(), "magenta-keychain-cleanup-"));
	let searchListWriteCount = 0;
	const runCommand = (command, args) => {
		assert.equal(command, "security");
		if (args[0] === "list-keychains" && !args.includes("-s")) {
			return { status: 0, stderr: "", stdout: '"/Users/test/Library/Keychains/login.keychain-db"\n' };
		}
		if (args[0] === "list-keychains" && args.includes("-s")) {
			searchListWriteCount += 1;
			return { status: searchListWriteCount === 2 ? 1 : 0, stderr: "", stdout: "" };
		}
		if (args[0] === "find-identity") {
			return { status: 0, stderr: "", stdout: `1) synthetic "${SIGNING_IDENTITY}"\n` };
		}
		if (args[0] === "find-certificate") {
			return { status: 0, stderr: "", stdout: `SHA-256 hash: ${CERTIFICATE_SHA256.toUpperCase()}\n` };
		}
		return { status: 0, stderr: "", stdout: "" };
	};
	try {
		await assert.rejects(
			() =>
				withEphemeralAppleCredentials(signingCredentials(), async () => "signed", {
					runCommand,
					temporaryParent: root,
				}),
			/macOS signing credential cleanup was incomplete/u,
		);
		assert.equal(searchListWriteCount, 2);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});
