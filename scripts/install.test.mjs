import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const installer = readFileSync(new URL("./install.ps1", import.meta.url), "utf8");
const unixInstallerUrl = new URL("./install.sh", import.meta.url);
const unixInstaller = readFileSync(unixInstallerUrl, "utf8");
const macosReleaseTrust = JSON.parse(readFileSync(new URL("./macos-release-trust.json", import.meta.url), "utf8"));
const updaterSupport = readFileSync(
	new URL("../pi/coding-agent/src/utils/github-release-update-support.ts", import.meta.url),
	"utf8",
);
const unixInstallerHelper = readFileSync(
	new URL("../pi/coding-agent/src/utils/unix-installer.ts", import.meta.url),
	"utf8",
);
const macosReleaseVerifier = readFileSync(
	new URL("../pi/coding-agent/src/utils/macos-release-verification.ts", import.meta.url),
	"utf8",
);

function requireCapture(source, pattern, label) {
	const match = source.match(pattern);
	assert.ok(match?.[1], `missing ${label}`);
	return match[1];
}

function assertSourceOrder(source, needles, label) {
	let cursor = -1;
	for (const needle of needles) {
		const index = source.indexOf(needle, cursor + 1);
		assert.ok(index > cursor, `${label} must contain ${JSON.stringify(needle)} in order`);
		cursor = index;
	}
}

test("Unix installer is a source-owned thin client for the shared transaction engine", () => {
	const parse = spawnSync("bash", ["-n", unixInstallerUrl.pathname], { encoding: "utf8" });
	assert.equal(parse.status, 0, parse.stderr);
	assert.match(unixInstaller, /"\$BIN_FILE" _install-unix/u);
	assert.match(unixInstaller, /--expected-version "\$EXPECTED_VERSION"/u);
	assert.doesNotMatch(unixInstaller, /cp\s+-R[^\n]+\$INSTALL_DIR/u);
	assert.doesNotMatch(unixInstaller, /mv[^\n]+\$INSTALL_DIR\/magenta/u);
	assert.match(unixInstallerHelper, /lockInstallDirectories\(lockDirectories\)/u);
	assert.match(unixInstallerHelper, /recoverInterruptedReleaseUpdateTransaction\(installDirectory\)/u);
	assert.match(unixInstallerHelper, /applyUnixUpdateTransaction\(\{/u);
	assert.match(macosReleaseVerifier, /codesign[\s\S]+--check-notarization/u);
	assert.match(macosReleaseVerifier, /spctl[\s\S]+--assess/u);
	assertSourceOrder(
		unixInstaller,
		["verify_asset \"$BIN_FILE\"", "/usr/bin/codesign --verify", '"$BIN_FILE" _install-unix'],
		"macOS pre-execution verification",
	);
	assert.match(unixInstaller, /\^Identifier=land\\\.minions\\\.magenta\$/u);
	assert.equal(
		requireCapture(unixInstaller, /^EXPECTED_APPLE_TEAM_ID="([^"]+)"$/mu, "source-owned Apple Team ID"),
		macosReleaseTrust.appleTeamId,
	);
	assert.match(unixInstaller, /\^TeamIdentifier=\$\{EXPECTED_APPLE_TEAM_ID\}\$/u);
	assert.doesNotMatch(unixInstaller, /\^TeamIdentifier=\[A-Z0-9\]\{10\}\$/u);
	assert.match(unixInstaller, /flags=\.\*runtime/u);
	assert.match(unixInstaller, /\.local\/lib\/magenta/u);
	assert.match(unixInstaller, /MAGENTA_BIN_DIR/u);
	assert.match(unixInstaller, /_uninstall-unix/u);
	assert.match(unixInstallerHelper, /rename\(temporaryPath, plan\.path\)/u);
	assert.match(unixInstallerHelper, /verifyMacosReleaseCandidate/u);
	assert.doesNotMatch(unixInstallerHelper, /TeamIdentifier=\[A-Z0-9\]/u);
});

test("Unix installer validates repository, version, transport, and token handling before download", () => {
	const runRejected = (environment) =>
		spawnSync("bash", [unixInstallerUrl.pathname], {
			encoding: "utf8",
			env: { ...process.env, HOME: "/tmp", MAGENTA_VERSION: "1.2.3", ...environment },
		});
	for (const repository of ["owner/bad$name", "bad$owner/name", "owner/name/extra", "/name", "owner/"]) {
		const result = runRejected({ MAGENTA_DIST_REPO: repository });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /Invalid MAGENTA_DIST_REPO/u);
	}
	const badVersion = runRejected({ MAGENTA_VERSION: "1.2.3suffix" });
	assert.notEqual(badVersion.status, 0);
	assert.match(badVersion.stderr, /exact MAJOR\.MINOR\.PATCH/u);
	const insecureBase = runRejected({ MAGENTA_ASSET_BASE_URL: "http://example.com/releases" });
	assert.notEqual(insecureBase.status, 0);
	assert.match(insecureBase.stderr, /must use HTTPS/u);
	assert.match(unixInstaller, /MAGENTA_INSTALL_TEST_MODE[\s\S]+127\\\.0\\\.0\\\.1\|localhost/u);
	assert.match(unixInstaller, /github\.netrc[\s\S]+umask 077/u);
	assert.match(unixInstaller, /machine github\.com[\s\S]+login x-access-token/u);
	assert.match(unixInstaller, /--netrc-file "\$CURL_AUTH_FILE"/u);
	assert.doesNotMatch(unixInstaller, /header = "Authorization:/u);
	assert.doesNotMatch(unixInstaller, /-H "Authorization: Bearer/u);
});

test("installers enforce asset/checksum byte ceilings and clean streamed overflow", () => {
	assert.match(unixInstaller, /CHECKSUM_MAX_BYTES=\$\(\(1 \* 1024 \* 1024\)\)/u);
	assert.match(unixInstaller, /ASSET_MAX_BYTES=\$\(\(512 \* 1024 \* 1024\)\)/u);
	assert.match(unixInstaller, /--max-filesize "\$max_bytes"/u);
	assert.match(unixInstaller, /downloaded_bytes=\$\(wc -c < "\$partial"\)/u);
	assert.match(unixInstaller, /Downloaded asset exceeds[\s\S]+rm -f "\$partial"/u);

	assert.match(installer, /\$magentaChecksumMaxBytes = \[long\]\(1 \* 1024 \* 1024\)/u);
	assert.match(installer, /\$magentaAssetMaxBytes = \[long\]\(512 \* 1024 \* 1024\)/u);
	assert.match(installer, /ResponseHeadersRead/u);
	assert.match(installer, /ContentLength/u);
	assert.match(installer, /exceeded the \$MaxBytes-byte limit while streaming/u);
	assert.match(installer, /\$partialPath = "\$OutFile\.part"/u);
	assert.match(installer, /Test-MagentaDownloadFile \$partialPath \$MinBytes \$MaxBytes/u);
	assert.match(installer, /Invoke-MagentaDownload "\$directBase\/SHA256SUMS" \$checksumsPath 0 \$false \$magentaChecksumMaxBytes/u);
	assert.match(installer, /Invoke-MagentaDownload "\$directBase\/magenta-windows-x64\.exe" \$binaryPath 1000000 \$true \$magentaAssetMaxBytes/u);
	assert.match(installer, /Invoke-MagentaDownload "\$directBase\/magenta-resources-universal\.tar\.gz" \$resourcesPath 0 \$true \$magentaAssetMaxBytes/u);

	const journalWriter = installer.slice(
		installer.indexOf("function Write-MagentaTransactionJournal"),
		installer.indexOf("function Read-MagentaTransactionJournal"),
	);
	assertSourceOrder(
		journalWriter,
		["Read-MagentaTransactionJournal", "Remove-MagentaPlainPath $journalNewPath", "[IO.FileMode]::CreateNew"],
		"exclusive journal temp creation",
	);
	assert.doesNotMatch(
		journalWriter,
		/Write-MagentaDurableBytes \$journalNewPath \$bytes \(\[IO\.FileMode\]::Create\)/u,
	);

	const temporaryDirectory = mkdtempSync(join(tmpdir(), "magenta-download-cap-"));
	try {
		const fakeBinDirectory = join(temporaryDirectory, "bin");
		mkdirSync(fakeBinDirectory);
		const fakeCurlPath = join(fakeBinDirectory, "curl");
		const wrapperPath = join(temporaryDirectory, "exercise.sh");
		const outputPath = join(temporaryDirectory, "asset");
		const curlFunctionStart = unixInstaller.indexOf("curl_to_file() {");
		const curlFunctionEnd = unixInstaller.indexOf("\nresolve_latest_tag()", curlFunctionStart);
		assert.ok(curlFunctionStart >= 0 && curlFunctionEnd > curlFunctionStart);
		const curlFunction = unixInstaller.slice(curlFunctionStart, curlFunctionEnd);
		writeFileSync(
			fakeCurlPath,
			`#!/usr/bin/env bash
set -euo pipefail
output=""
while [ "$#" -gt 0 ]; do
	if [ "$1" = "-o" ]; then output="$2"; shift 2; else shift; fi
done
printf '0123456789' > "$output"
`,
			{ mode: 0o755 },
		);
		writeFileSync(
			wrapperPath,
			`#!/usr/bin/env bash
set -euo pipefail
DIST_REPO="owner/repo"
CURL_AUTH_FILE=""
${curlFunction}
if curl_to_file "https://asset.test/release" "$1" 8; then exit 90; fi
test ! -e "$1"
test ! -e "$1.part"
`,
			{ mode: 0o755 },
		);
		// The fake transport ignores Content-Length and writes a body larger than
		// the cap, exercising the post-stream cleanup path.
		const result = spawnSync("bash", [wrapperPath, outputPath], {
			encoding: "utf8",
			env: { ...process.env, PATH: `${fakeBinDirectory}:${process.env.PATH ?? ""}` },
		});
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stderr, /Downloaded asset exceeds the 8-byte limit/u);
	} finally {
		rmSync(temporaryDirectory, { recursive: true, force: true });
	}
});

test("curl host-bound authentication is stripped from cross-host release redirects", async () => {
	let sourceAuthorization;
	let targetAuthorization;
	const target = createServer((request, response) => {
		targetAuthorization = request.headers.authorization;
		response.writeHead(200, { "content-type": "application/octet-stream" });
		response.end("release payload");
	});
	const source = createServer((request, response) => {
		sourceAuthorization = request.headers.authorization;
		const targetAddress = target.address();
		assert.ok(targetAddress && typeof targetAddress !== "string");
		response.writeHead(302, { location: `http://asset.test:${targetAddress.port}/payload` });
		response.end();
	});
	const listen = (server) =>
		new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
	const close = (server) => new Promise((resolve) => server.close(resolve));
	const temporaryDirectory = mkdtempSync(join(tmpdir(), "magenta-curl-auth-"));
	try {
		await listen(target);
		await listen(source);
		const sourceAddress = source.address();
		const targetAddress = target.address();
		assert.ok(sourceAddress && typeof sourceAddress !== "string");
		assert.ok(targetAddress && typeof targetAddress !== "string");
		const netrcPath = join(temporaryDirectory, "github.netrc");
		const outputPath = join(temporaryDirectory, "asset");
		writeFileSync(netrcPath, "machine source.test\nlogin x-access-token\npassword test-token\n", {
			mode: 0o600,
		});
		await execFileAsync("curl", [
			"-fsSL",
			"--noproxy",
			"*",
			"--resolve",
			`source.test:${sourceAddress.port}:127.0.0.1`,
			"--resolve",
			`asset.test:${targetAddress.port}:127.0.0.1`,
			"--netrc-file",
			netrcPath,
			"-o",
			outputPath,
			`http://source.test:${sourceAddress.port}/release`,
		]);
		assert.equal(sourceAuthorization, `Basic ${Buffer.from("x-access-token:test-token").toString("base64")}`);
		assert.equal(targetAuthorization, undefined);
		assert.equal(readFileSync(outputPath, "utf8"), "release payload");
	} finally {
		await Promise.all([close(source), close(target)]);
		rmSync(temporaryDirectory, { recursive: true, force: true });
	}
});

test("standalone installer shares the updater lock contract", () => {
	const updaterLockName = requireCapture(
		updaterSupport,
		/RELEASE_INSTALL_LOCK_NAME\s*=\s*"([^"]+)"/u,
		"updater lock name",
	);
	const installerLockName = requireCapture(
		installer,
		/\$magentaInstallLockName\s*=\s*"([^"]+)"/u,
		"installer lock name",
	);
	assert.equal(installerLockName, updaterLockName);
	assert.equal(installerLockName, ".magenta-install-update.lock");
	const updaterJournalName = requireCapture(
		updaterSupport,
		/RELEASE_UPDATE_JOURNAL_NAME\s*=\s*"([^"]+)"/u,
		"updater journal name",
	);
	const installerJournalName = requireCapture(
		installer,
		/\$magentaUpdateJournalName\s*=\s*"([^"]+)"/u,
		"installer journal name",
	);
	assert.equal(installerJournalName, updaterJournalName);
	assert.equal(installerJournalName, ".magenta-install-update.json");

	assert.match(installer, /\$lockDirectory = Join-Path \$InstallDirectory \$magentaInstallLockName/u);
	assert.match(installer, /New-Item -ItemType Directory -Path \$lockDirectory -ErrorAction Stop/u);
	assert.match(installer, /SetLastWriteTimeUtc\(\$LockDirectory, \[DateTime\]::UtcNow\)/u);
	assert.match(installer, /AddMinutes\(-\$magentaLockStaleMinutes\)/u);
	assert.match(installer, /Stale Magenta install\/update lock is not empty; refusing to delete unknown data/u);
	assert.match(installer, /recheckedLock\.LastWriteTimeUtc -ne \$observedLockMtime/u);
	assert.match(installer, /Shared Magenta install\/update lock is no longer empty; refusing to mutate/u);
});

test("journal validation is path-bound and fails closed", () => {
	assert.match(installer, /\$journalPath = Join-Path \$InstallDir \$magentaUpdateJournalName/u);
	assert.match(installer, /\$magentaUpdateJournalTempName = "\.magenta-install-update\.json\.tmp"/u);
	assert.match(installer, /\[IO\.File\]::Replace\(\$journalNewPath, \$JournalPath, \$null, \$true\)/u);
	assert.match(installer, /Installer journal is damaged; refusing to guess which installation data to remove/u);
	assert.match(installer, /Installer journal contains paths outside its operation namespace/u);
	assert.match(installer, /\$Label contains an unknown property/u);
	assert.match(installer, /Transaction path is a reparse point; refusing to follow it/u);
	assert.match(installer, /Transaction directory has no valid ownership marker; preserving it/u);
	assert.match(installer, /Preserving unverified installer-like directory/u);
	assert.match(installer, /Read-MagentaTransactionJournal \$journalNewPath[\s\S]+\[IO\.File\]::Move\(\$journalNewPath, \$JournalPath\)/u);
});

test("only Magenta-managed top-level entries can enter a transaction", () => {
	assert.match(installer, /\$magentaManagedDirectoryNames = @\(\$magentaArchiveDirectoryNames\) \+ @\("_magenta"\)/u);
	assert.match(installer, /\$magentaArchiveWasmFileNames = @\("photon_rs_bg\.wasm"\)/u);
	assert.match(
		installer,
		/\$magentaManagedFileNames = @\(\$magentaArchiveFileNames\) \+ @\(\$magentaArchiveWasmFileNames\) \+ @\("magenta\.exe"\)/u,
	);
	assert.doesNotMatch(installer, /\$Name -match [^\r\n]*\\\.wasm/u);
	assert.doesNotMatch(installer, /magentaManaged(?:Directory|File)Names[^\r\n]*keep\.txt/u);
	assert.match(installer, /Installer journal contains an unmanaged \$Label entry name/u);
	assert.match(installer, /Assert-MagentaManagedEntry \$item "InstallDir"/u);
	assert.match(installer, /Assert-MagentaManagedEntry \$item "Staging"/u);
	assert.match(installer, /Non-empty InstallDir has managed-looking data but no Magenta executable/u);

	const main = installer.slice(installer.indexOf("$requiredResources = @("));
	assertSourceOrder(
		main,
		[
			"$installedEntries = @(Get-MagentaInstallEntries $InstallDir)",
			"Assert-MagentaExistingInstallationOwnership $InstallDir $installedEntries",
			"foreach ($entryName in $installedEntries)",
		],
		"uninstall preflight",
	);
	assertSourceOrder(
		main,
		[
			"$oldEntryNames = @(Get-MagentaInstallEntries $InstallDir)",
			"Assert-MagentaExistingInstallationOwnership $InstallDir $oldEntryNames",
			"Write-MagentaTransactionJournal $journalPath $journal",
		],
		"install preflight",
	);
});

test("activation journals manifests before mutation and atomically replaces the executable", () => {
	const main = installer.slice(installer.indexOf("$requiredResources = @("));
	assertSourceOrder(
		main,
		[
			"Write-MagentaTransactionJournal $journalPath $journal",
			"New-Item -ItemType Directory -Path $stagingDir",
			'$journal["phase"] = "prepared"',
			"Write-MagentaTransactionJournal $journalPath $journal",
			"Move-Item -LiteralPath (Join-Path $InstallDir $entryName)",
			'$journal["phase"] = "resources_backed_up"',
			"Write-MagentaTransactionJournal $journalPath $journal",
			"Write-MagentaOwnershipMarker $InstallDir",
			"Move-Item -LiteralPath (Join-Path $stagingDir $entryName)",
			"[IO.File]::Replace($binaryPath, $installedBinary, $backupBinary, $true)",
			'$journal["phase"] = "activated"',
			"Write-MagentaTransactionJournal $journalPath $journal",
		],
		"Windows installer activation",
	);

	assert.match(installer, /\[IO\.File\]::Replace\(\$backupBinary, \$installedBinary, \$discardBinary, \$true\)/u);
	assert.doesNotMatch(installer, /Move-Item -LiteralPath \$InstallDir -Destination/u);
	assert.doesNotMatch(installer, /Remove-Item[^\r\n]+-LiteralPath \$InstallDir[^\r\n]+-Recurse/u);
	assert.match(installer, /Another installer may have acquired the shared child lock after/u);
});

test("recovery is idempotent and removes only validated transaction state", () => {
	assert.match(installer, /if \(\$journal\.phase -eq "activated"\)[\s\S]+Complete-MagentaTransaction/u);
	assert.match(installer, /if \(\$null -ne \$discardItem\)[\s\S]+Rollback discard binary is not the recorded replacement/u);
	assert.match(installer, /Recorded previous installation entry is missing from both active and backup paths/u);
	assert.match(installer, /Prepared installer backup has no ownership marker and is not empty; preserving it/u);
	assertSourceOrder(
		installer.slice(installer.indexOf("function Restore-MagentaTransaction")),
		["Remove-MagentaEmptyUnmarkedPreparedBackup $Journal", "Assert-MagentaRecoveryManifests $Journal"],
		"prepared backup crash-window recovery",
	);
	assertSourceOrder(
		installer.slice(installer.indexOf("function Complete-MagentaTransaction")),
		[
			"Test-MagentaInstalledTransaction",
			"Remove-MagentaTransactionDirectory $Journal.backupDir",
			"Remove-MagentaTransactionDirectory $Journal.stagingDir",
			"Remove-MagentaJournalState $JournalPath",
		],
		"completed transaction cleanup",
	);
});
