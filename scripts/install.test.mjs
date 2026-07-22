import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const installer = readFileSync(new URL("./install.ps1", import.meta.url), "utf8");
const updaterSupport = readFileSync(
	new URL("../pi/coding-agent/src/utils/github-release-update-support.ts", import.meta.url),
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
