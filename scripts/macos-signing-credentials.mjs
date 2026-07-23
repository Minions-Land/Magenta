import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { normalizeAppleTeamId } from "./macos-release-trust.mjs";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

// These values are only needed to build the in-memory signing credential. Keep
// the list explicit so a newly added release child process cannot inherit a
// credential by accident.
export const MACOS_SIGNING_ENV_KEYS = Object.freeze([
	"MAGENTA_APPLE_NOTARY_ISSUER_ID",
	"MAGENTA_APPLE_NOTARY_KEY_ID",
	"MAGENTA_APPLE_NOTARY_KEY_P8_BASE64",
	"MAGENTA_MACOS_CERTIFICATE_P12_BASE64",
	"MAGENTA_MACOS_CERTIFICATE_PASSWORD",
	"MAGENTA_MACOS_CERTIFICATE_SHA256",
	"MAGENTA_MACOS_SIGNING_IDENTITY",
	"MAGENTA_MACOS_TEAM_ID",
]);

function commandOutput(result) {
	return `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`;
}

function runChecked(runCommand, command, args, label) {
	const result = runCommand(command, args, { label });
	if (result?.status !== undefined && result.status !== 0) throw new Error(`${label} failed.`);
	return result ?? { status: 0, stderr: "", stdout: "" };
}

function runCleanup(runCommand, command, args, label) {
	try {
		const result = runCommand(command, args, { label });
		if (result?.status !== undefined && result.status !== 0) return new Error(`${label} failed.`);
		return undefined;
	} catch (error) {
		return error instanceof Error ? error : new Error(`${label} failed: ${String(error)}`);
	}
}

function normalizeSha256(value, label) {
	const normalized = String(value ?? "").trim().toLowerCase();
	if (!SHA256_PATTERN.test(normalized)) throw new Error(`${label} must be a 64-character SHA-256 value.`);
	return normalized;
}

function decodeBase64Secret(value, label) {
	const normalized = String(value ?? "").replaceAll(/\s/gu, "");
	if (!normalized || !/^[A-Za-z0-9+/]+={0,2}$/u.test(normalized)) {
		throw new Error(`${label} must be non-empty base64.`);
	}
	const content = Buffer.from(normalized, "base64");
	if (content.length === 0) throw new Error(`${label} decoded to an empty value.`);
	return content;
}

export function readAppleSigningCredentials(env = process.env, { expectedTeamId } = {}) {
	const trustedTeamId = normalizeAppleTeamId(expectedTeamId, "Expected source-owned Apple Team ID");
	const secretTeamId = normalizeAppleTeamId(env.MAGENTA_MACOS_TEAM_ID, "MAGENTA_MACOS_TEAM_ID");
	if (secretTeamId !== trustedTeamId) {
		throw new Error("MAGENTA_MACOS_TEAM_ID does not match the source-owned Apple Team ID.");
	}
	const credentials = {
		certificateP12: decodeBase64Secret(env.MAGENTA_MACOS_CERTIFICATE_P12_BASE64, "Developer ID certificate"),
		certificatePassword: env.MAGENTA_MACOS_CERTIFICATE_PASSWORD,
		certificateSha256: normalizeSha256(
			env.MAGENTA_MACOS_CERTIFICATE_SHA256,
			"Developer ID certificate fingerprint",
		),
		identity: env.MAGENTA_MACOS_SIGNING_IDENTITY,
		notaryIssuerId: env.MAGENTA_APPLE_NOTARY_ISSUER_ID,
		notaryKey: decodeBase64Secret(env.MAGENTA_APPLE_NOTARY_KEY_P8_BASE64, "Apple notary API key"),
		notaryKeyId: env.MAGENTA_APPLE_NOTARY_KEY_ID,
		teamId: secretTeamId,
	};
	if (!credentials.certificatePassword) throw new Error("MAGENTA_MACOS_CERTIFICATE_PASSWORD is required.");
	if (!credentials.identity?.startsWith("Developer ID Application:")) {
		throw new Error("MAGENTA_MACOS_SIGNING_IDENTITY must name a Developer ID Application identity.");
	}
	if (!credentials.identity.endsWith(` (${trustedTeamId})`)) {
		throw new Error("MAGENTA_MACOS_SIGNING_IDENTITY does not match the source-owned Apple Team ID.");
	}
	if (!/^[A-Z0-9]{10,32}$/u.test(credentials.notaryKeyId ?? "")) {
		throw new Error("MAGENTA_APPLE_NOTARY_KEY_ID is invalid.");
	}
	if (!UUID_PATTERN.test(credentials.notaryIssuerId ?? "")) {
		throw new Error("MAGENTA_APPLE_NOTARY_ISSUER_ID must be a UUID.");
	}
	if (!credentials.notaryKey.toString("utf8").includes("BEGIN PRIVATE KEY")) {
		throw new Error("Apple notary API key is not a PEM private key.");
	}
	return credentials;
}

/**
 * Capture and validate protected Apple credentials, then remove every signing
 * variable from the supplied environment even when validation fails.
 *
 * The returned object is the sole in-memory copy used by the signing flow;
 * child processes inherit the caller's now-scrubbed process environment.
 */
export function captureAppleSigningCredentials(env = process.env, options = {}) {
	try {
		return readAppleSigningCredentials(env, options);
	} finally {
		for (const key of MACOS_SIGNING_ENV_KEYS) delete env[key];
	}
}

function parseKeychainList(output) {
	return [...output.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
}

function verifyImportedSigningIdentity({ credentials, keychainPath, runCommand }) {
	const identities = commandOutput(
		runChecked(
			runCommand,
			"security",
			["find-identity", "-v", "-p", "codesigning", keychainPath],
			"Developer ID identity lookup",
		),
	);
	if (!identities.includes(credentials.identity)) {
		throw new Error("The protected keychain does not contain the configured Developer ID identity.");
	}
	const certificate = commandOutput(
		runChecked(
			runCommand,
			"security",
			["find-certificate", "-c", credentials.identity, "-Z", keychainPath],
			"Developer ID certificate lookup",
		),
	);
	const fingerprints = [...certificate.matchAll(/SHA-256 hash:\s*([0-9A-F]{64})/giu)].map((match) =>
		match[1].toLowerCase(),
	);
	if (fingerprints.length !== 1 || fingerprints[0] !== credentials.certificateSha256) {
		throw new Error("Developer ID certificate fingerprint does not match the protected configuration.");
	}
}

export async function withEphemeralAppleCredentials(
	credentials,
	callback,
	{ runCommand, temporaryParent = tmpdir() },
) {
	if (typeof runCommand !== "function") throw new Error("withEphemeralAppleCredentials requires a command runner.");
	const temporaryDirectory = mkdtempSync(join(resolve(temporaryParent), "magenta-macos-signing-"));
	const certificatePath = join(temporaryDirectory, "developer-id.p12");
	const notaryKeyPath = join(temporaryDirectory, "AuthKey.p8");
	const keychainPath = join(temporaryDirectory, "signing.keychain-db");
	const keychainPassword = randomBytes(32).toString("hex");
	let originalKeychains = [];
	let originalKeychainsKnown = false;
	let keychainCreated = false;
	let result;
	let operationError;
	try {
		writeFileSync(certificatePath, credentials.certificateP12, { mode: 0o600 });
		writeFileSync(notaryKeyPath, credentials.notaryKey, { mode: 0o600 });
		chmodSync(temporaryDirectory, 0o700);
		const keychains = runChecked(
			runCommand,
			"security",
			["list-keychains", "-d", "user"],
			"Keychain search-list lookup",
		);
		originalKeychains = parseKeychainList(commandOutput(keychains));
		originalKeychainsKnown = true;
		runChecked(
			runCommand,
			"security",
			["create-keychain", "-p", keychainPassword, keychainPath],
			"Ephemeral keychain creation",
		);
		keychainCreated = true;
		runChecked(
			runCommand,
			"security",
			["set-keychain-settings", "-lut", "21600", keychainPath],
			"Ephemeral keychain configuration",
		);
		runChecked(
			runCommand,
			"security",
			["unlock-keychain", "-p", keychainPassword, keychainPath],
			"Ephemeral keychain unlock",
		);
		runChecked(
			runCommand,
			"security",
			[
				"import",
				certificatePath,
				"-k",
				keychainPath,
				"-P",
				credentials.certificatePassword,
				"-T",
				"/usr/bin/codesign",
				"-T",
				"/usr/bin/security",
			],
			"Developer ID certificate import",
		);
		runChecked(
			runCommand,
			"security",
			[
				"set-key-partition-list",
				"-S",
				"apple-tool:,apple:",
				"-s",
				"-k",
				keychainPassword,
				keychainPath,
			],
			"Developer ID private-key access configuration",
		);
		runChecked(
			runCommand,
			"security",
			["list-keychains", "-d", "user", "-s", keychainPath, ...originalKeychains],
			"Ephemeral keychain activation",
		);
		verifyImportedSigningIdentity({ credentials, keychainPath, runCommand });
		result = await callback({ keychainPath, notaryKeyPath, temporaryDirectory });
	} catch (error) {
		operationError = error;
	}

	const cleanupErrors = [];
	if (originalKeychainsKnown) {
		const restoreError = runCleanup(
			runCommand,
			"security",
			["list-keychains", "-d", "user", "-s", ...originalKeychains],
			"Keychain search-list restoration",
		);
		if (restoreError) cleanupErrors.push(restoreError);
	}
	if (keychainCreated) {
		const deleteError = runCleanup(
			runCommand,
			"security",
			["delete-keychain", keychainPath],
			"Ephemeral keychain deletion",
		);
		if (deleteError) cleanupErrors.push(deleteError);
	}
	try {
		rmSync(temporaryDirectory, { force: true, recursive: true });
	} catch (error) {
		cleanupErrors.push(
			error instanceof Error ? error : new Error(`Credential directory cleanup failed: ${String(error)}`),
		);
	}

	if (operationError && cleanupErrors.length > 0) {
		throw new AggregateError(
			[operationError, ...cleanupErrors],
			"macOS signing failed and credential cleanup was incomplete.",
		);
	}
	if (operationError) throw operationError;
	if (cleanupErrors.length > 0) {
		throw new AggregateError(cleanupErrors, "macOS signing credential cleanup was incomplete.");
	}
	return result;
}
