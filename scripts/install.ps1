param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "Magenta"),
    [string]$Version = "latest",
    [string]$Repository = "Minions-Land/Magenta-CLI",
    [string]$AssetBaseUrl = "",
    [switch]$NoPath,
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$pathSeparators = [char[]]@(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar
)

function Get-NormalizedMagentaPath([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) {
        return ""
    }
    return [System.IO.Path]::GetFullPath($Value).TrimEnd($pathSeparators)
}

function Test-MagentaPathEqual([string]$Left, [string]$Right) {
    try {
        return (Get-NormalizedMagentaPath $Left) -ieq (Get-NormalizedMagentaPath $Right)
    } catch {
        return $Left.Trim().TrimEnd($pathSeparators) -ieq $Right.Trim().TrimEnd($pathSeparators)
    }
}

function Invoke-MagentaCapture([string]$FilePath, [string]$Arguments, [int]$TimeoutMilliseconds = 60000) {
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $FilePath
    $startInfo.Arguments = $Arguments
    $startInfo.WorkingDirectory = Split-Path -Parent $FilePath
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    $started = $false
    try {
        $started = $process.Start()
        if (-not $started) {
            throw "Failed to start Magenta process: $FilePath $Arguments"
        }
        $standardOutputTask = $process.StandardOutput.ReadToEndAsync()
        $standardErrorTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutMilliseconds)) {
            try {
                $process.Kill()
                [void]$process.WaitForExit(5000)
            } catch {}
            throw "Magenta process timed out after $TimeoutMilliseconds ms: $FilePath $Arguments"
        }
        $process.WaitForExit()
        return [PSCustomObject]@{
            ExitCode = $process.ExitCode
            StandardOutput = $standardOutputTask.GetAwaiter().GetResult()
            StandardError = $standardErrorTask.GetAwaiter().GetResult()
        }
    } finally {
        if ($started) {
            try {
                if (-not $process.HasExited) {
                    $process.Kill()
                    [void]$process.WaitForExit(5000)
                }
            } catch {}
        }
        $process.Dispose()
    }
}

function Remove-MagentaFromUserPath([string]$Directory) {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ([string]::IsNullOrEmpty($userPath)) {
        return $false
    }
    $entries = @($userPath -split ";")
    $kept = @($entries | Where-Object { $_ -and -not (Test-MagentaPathEqual $_ $Directory) })
    if ($kept.Count -eq $entries.Count) {
        return $false
    }
    [Environment]::SetEnvironmentVariable("Path", ($kept -join ";"), "User")
    return $true
}

$magentaArchiveDirectoryNames = @(
    "sandbox", "tools", "policy", "runtime", "skills", "theme",
    "assets", "export-html", "docs", "examples"
)
$magentaArchiveFileNames = @("package.json", "README.md", "CHANGELOG.md", "magenta-release.json")
$magentaArchiveWasmFileNames = @("photon_rs_bg.wasm")
$magentaManagedDirectoryNames = @($magentaArchiveDirectoryNames) + @("_magenta")
$magentaManagedFileNames = @($magentaArchiveFileNames) + @($magentaArchiveWasmFileNames) + @("magenta.exe")

function Test-MagentaResourceArchive([string]$ArchivePath) {
    $archivePaths = @(& tar.exe -tzf $ArchivePath)
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to inspect Magenta runtime resources (tar.exe exit code $LASTEXITCODE)."
    }
    $archiveDetails = @(& tar.exe -tvzf $ArchivePath)
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to inspect Magenta runtime resource types (tar.exe exit code $LASTEXITCODE)."
    }
    if ($archivePaths.Count -eq 0 -or $archivePaths.Count -ne $archiveDetails.Count) {
        throw "Magenta runtime resource archive has an empty or ambiguous listing."
    }

    $allowedDirectories = @($magentaArchiveDirectoryNames)
    $allowedFiles = @($magentaArchiveFileNames)
    $allowedWasmFiles = @($magentaArchiveWasmFileNames)
    $requiredPaths = @(
        "theme/dark.json",
        "tools/read/read.toml",
        "skills/paper-analysis/pi/SKILL.md",
        "photon_rs_bg.wasm",
        "runtime/node_modules/@mariozechner/clipboard/package.json",
        "runtime/node_modules/@mariozechner/clipboard/index.js",
        "runtime/node_modules/@mariozechner/clipboard-darwin-universal/package.json",
        "runtime/node_modules/@mariozechner/clipboard-darwin-universal/clipboard.darwin-universal.node",
        "runtime/node_modules/@mariozechner/clipboard-linux-x64-gnu/package.json",
        "runtime/node_modules/@mariozechner/clipboard-linux-x64-gnu/clipboard.linux-x64-gnu.node",
        "runtime/node_modules/@mariozechner/clipboard-win32-x64-msvc/package.json",
        "runtime/node_modules/@mariozechner/clipboard-win32-x64-msvc/clipboard.win32-x64-msvc.node"
    )
    $normalizedPaths = New-Object "System.Collections.Generic.HashSet[string]"
    $caseFoldedPaths = New-Object "System.Collections.Generic.HashSet[string]"
    $topLevelNames = New-Object "System.Collections.Generic.HashSet[string]"

    for ($index = 0; $index -lt $archivePaths.Count; $index++) {
        $entry = [string]$archivePaths[$index]
        $detail = [string]$archiveDetails[$index]
        if ([string]::IsNullOrEmpty($detail)) {
            throw "Magenta runtime resource archive has an unreadable entry type."
        }
        $entryType = $detail.Substring(0, 1)
        if ($entryType -ne "-" -and $entryType -ne "d") {
            throw "Magenta runtime resource archive contains unsupported entry type '$entryType': $entry"
        }
        if ([string]::IsNullOrEmpty($entry) -or $entry -match '[\x00-\x1f\x7f]') {
            throw "Magenta runtime resource archive contains an empty or control-character path."
        }
        if ($entry.Contains([char]92)) {
            throw "Magenta runtime resource archive path uses a backslash: $entry"
        }
        if ($entry.StartsWith("/") -or $entry -match '^[A-Za-z]:') {
            throw "Magenta runtime resource archive path is absolute: $entry"
        }

        $normalized = $entry.TrimEnd([char[]]@('/'))
        $segments = @($normalized -split '/')
        $unsafeSegments = @($segments | Where-Object { $_ -eq "" -or $_ -eq "." -or $_ -eq ".." })
        if ([string]::IsNullOrEmpty($normalized) -or $unsafeSegments.Count -gt 0) {
            throw "Magenta runtime resource archive path is unsafe: $entry"
        }
        foreach ($segment in $segments) {
            if ($segment.Contains(":") -or $segment -match '[. ]$') {
                throw "Magenta runtime resource archive path is not Windows-safe: $entry"
            }
            if ($segment -match '^(?i:aux|con|nul|prn|com[1-9]|lpt[1-9])(?:\..*)?$') {
                throw "Magenta runtime resource archive uses a Windows reserved name: $entry"
            }
        }

        $caseFolded = $normalized.Normalize([Text.NormalizationForm]::FormC).ToLowerInvariant()
        if (-not $normalizedPaths.Add($normalized) -or -not $caseFoldedPaths.Add($caseFolded)) {
            throw "Magenta runtime resource archive contains a duplicate path: $normalized"
        }

        $topLevel = $segments[0]
        $isTopLevelWasm = $segments.Count -eq 1 -and $allowedWasmFiles -ccontains $topLevel
        if (-not ($allowedDirectories -ccontains $topLevel) -and -not ($allowedFiles -ccontains $topLevel) -and -not $isTopLevelWasm) {
            throw "Magenta runtime resource archive contains an unknown top-level path: $normalized"
        }
        if (($allowedDirectories -ccontains $topLevel) -and $segments.Count -eq 1 -and $entryType -ne "d") {
            throw "Magenta runtime resource root is not a directory: $normalized"
        }
        if (($allowedFiles -ccontains $topLevel) -and ($segments.Count -ne 1 -or $entryType -ne "-")) {
            throw "Magenta runtime top-level file has an invalid shape: $normalized"
        }
        if ($isTopLevelWasm -and $entryType -ne "-") {
            throw "Magenta runtime WASM entry is not a regular file: $normalized"
        }
        [void]$topLevelNames.Add($topLevel)
    }

    foreach ($directoryName in $allowedDirectories) {
        if (-not $topLevelNames.Contains($directoryName)) {
            throw "Magenta runtime resource archive is missing directory: $directoryName"
        }
    }
    foreach ($fileName in $allowedFiles) {
        if (-not $normalizedPaths.Contains($fileName)) {
            throw "Magenta runtime resource archive is missing file: $fileName"
        }
    }
    foreach ($requiredPath in $requiredPaths) {
        if (-not $normalizedPaths.Contains($requiredPath)) {
            throw "Magenta runtime resource archive is missing required file: $requiredPath"
        }
    }
    foreach ($wasmFileName in $allowedWasmFiles) {
        if (-not $normalizedPaths.Contains($wasmFileName)) {
            throw "Magenta runtime resource archive is missing WASM file: $wasmFileName"
        }
    }
}

$magentaInstallLockName = ".magenta-install-update.lock"
$magentaUpdateJournalName = ".magenta-install-update.json"
$magentaUpdateJournalTempName = ".magenta-install-update.json.tmp"
$magentaTransactionMarkerName = ".magenta-installer-transaction.json"
$magentaJournalSchemaVersion = 1
$magentaLockStaleMinutes = 15
$magentaLockWaitMinutes = 20

function Get-MagentaItem([string]$Path) {
    try {
        return Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    } catch [System.Management.Automation.ItemNotFoundException] {
        return $null
    }
}

function Assert-MagentaPlainItem([string]$Path, [bool]$Directory) {
    $item = Get-MagentaItem $Path
    if ($null -eq $item) {
        throw "Required transaction path is missing: $Path"
    }
    if ([bool]$item.PSIsContainer -ne $Directory) {
        $expectedKind = if ($Directory) { "directory" } else { "file" }
        throw "Transaction path is not a plain $expectedKind`: $Path"
    }
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Transaction path is a reparse point; refusing to follow it: $Path"
    }
    return $item
}

function Assert-MagentaTreeHasNoReparsePoints([string]$Path) {
    $root = Assert-MagentaPlainItem $Path $true
    $pending = New-Object "System.Collections.Generic.Stack[string]"
    $pending.Push($root.FullName)
    while ($pending.Count -gt 0) {
        $directory = $pending.Pop()
        foreach ($child in @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)) {
            if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Transaction tree contains a reparse point; refusing to follow it: $($child.FullName)"
            }
            if ($child.PSIsContainer) {
                $pending.Push($child.FullName)
            }
        }
    }
}

function Remove-MagentaPlainPath([string]$Path) {
    $item = Get-MagentaItem $Path
    if ($null -eq $item) { return }
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing to remove a reparse point from installer transaction state: $Path"
    }
    if ($item.PSIsContainer) {
        Assert-MagentaTreeHasNoReparsePoints $Path
        Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
    } else {
        Remove-Item -LiteralPath $Path -Force -ErrorAction Stop
    }
}

function Test-MagentaManagedEntryName([string]$Name) {
    return (
        $magentaManagedDirectoryNames -icontains $Name -or
        $magentaManagedFileNames -icontains $Name
    )
}

function Assert-MagentaManagedEntry($Item, [string]$Context) {
    if (-not (Test-MagentaManagedEntryName $Item.Name)) {
        throw "$Context contains an unmanaged top-level entry; preserving it and refusing mutation: $($Item.FullName)"
    }
    $mustBeDirectory = $magentaManagedDirectoryNames -icontains $Item.Name
    if ([bool]$Item.PSIsContainer -ne $mustBeDirectory) {
        $expectedKind = if ($mustBeDirectory) { "directory" } else { "file" }
        throw "$Context managed top-level entry is not a $expectedKind`: $($Item.FullName)"
    }
    if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Context contains a top-level reparse point; refusing mutation: $($Item.FullName)"
    }
    if ($Item.PSIsContainer) { Assert-MagentaTreeHasNoReparsePoints $Item.FullName }
}

function ConvertTo-MagentaEntryNames($Value, [string]$Label) {
    $names = New-Object "System.Collections.Generic.List[string]"
    $seen = New-Object "System.Collections.Generic.HashSet[string]" ([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in @($Value)) {
        if ($entry -isnot [string] -or -not (Test-MagentaManagedEntryName $entry)) {
            throw "Installer journal contains an unmanaged $Label entry name."
        }
        if (-not $seen.Add($entry)) {
            throw "Installer journal contains a duplicate $Label entry name: $entry"
        }
        $names.Add($entry)
    }
    return @($names.ToArray())
}

function Assert-MagentaJsonProperties($Object, [string[]]$Allowed, [string]$Label) {
    if ($null -eq $Object -or $Object -isnot [PSCustomObject]) {
        throw "$Label is not a JSON object."
    }
    $actual = @($Object.PSObject.Properties | ForEach-Object { $_.Name })
    foreach ($name in $Allowed) {
        if (-not ($actual -ccontains $name)) {
            throw "$Label is missing property: $name"
        }
    }
    foreach ($name in $actual) {
        if (-not ($Allowed -ccontains $name)) {
            throw "$Label contains an unknown property: $name"
        }
    }
}

function Write-MagentaDurableBytes([string]$Path, [byte[]]$Bytes, [IO.FileMode]$Mode) {
    $stream = $null
    try {
        $stream = New-Object System.IO.FileStream -ArgumentList @(
            $Path,
            $Mode,
            [IO.FileAccess]::Write,
            [IO.FileShare]::None,
            4096,
            [IO.FileOptions]::WriteThrough
        )
        $stream.Write($Bytes, 0, $Bytes.Length)
        $stream.Flush($true)
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
    }
}

function Write-MagentaOwnershipMarker(
    [string]$Directory,
    [string]$OperationId,
    [string]$InstallDirectory,
    [string]$Role
) {
    Assert-MagentaPlainItem $Directory $true | Out-Null
    $markerPath = Join-Path $Directory $magentaTransactionMarkerName
    if ($null -ne (Get-MagentaItem $markerPath)) {
        throw "Installer ownership marker already exists: $markerPath"
    }
    $marker = [ordered]@{
        schemaVersion = $magentaJournalSchemaVersion
        operationId = $OperationId
        installDir = $InstallDirectory
        role = $Role
    }
    $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes(($marker | ConvertTo-Json -Compress))
    Write-MagentaDurableBytes $markerPath $bytes ([IO.FileMode]::CreateNew)
}

function Read-MagentaOwnershipMarker(
    [string]$Directory,
    [string]$OperationId,
    [string]$InstallDirectory,
    [string]$Role
) {
    Assert-MagentaPlainItem $Directory $true | Out-Null
    $markerPath = Join-Path $Directory $magentaTransactionMarkerName
    $markerItem = Assert-MagentaPlainItem $markerPath $false
    if ($markerItem.Length -gt 16384) {
        throw "Installer ownership marker is unexpectedly large: $markerPath"
    }
    try {
        $marker = [IO.File]::ReadAllText($markerPath) | ConvertFrom-Json
    } catch {
        throw "Installer ownership marker is damaged; preserving transaction state at $Directory. Error: $_"
    }
    $properties = @("schemaVersion", "operationId", "installDir", "role")
    Assert-MagentaJsonProperties $marker $properties "Installer ownership marker"
    if (
        $marker.schemaVersion -ne $magentaJournalSchemaVersion -or
        [string]$marker.operationId -cne $OperationId -or
        -not (Test-MagentaPathEqual ([string]$marker.installDir) $InstallDirectory) -or
        [string]$marker.role -cne $Role
    ) {
        throw "Installer ownership marker does not match this transaction; preserving $Directory."
    }
    return $marker
}

function Write-MagentaTransactionJournal([string]$JournalPath, $Journal) {
    $journalNewPath = Join-Path (Split-Path -Parent $JournalPath) $magentaUpdateJournalTempName
    $newItem = Get-MagentaItem $journalNewPath
    if ($null -ne $newItem -and ($newItem.PSIsContainer -or ($newItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw "Installer journal temporary path is not a plain file: $journalNewPath"
    }
    if ($null -ne $newItem) {
        # A crash can leave a complete temp file after the journal itself was
        # already durable.  Validate its transaction identity before removing
        # it; never truncate or replace an unrelated ordinary file.
        $journalInstallDirectory = Get-NormalizedMagentaPath ([string]$Journal.installDir)
        $journalInstallParent = Split-Path -Parent $journalInstallDirectory
        $journalInstallLeaf = Split-Path -Leaf $journalInstallDirectory
        $pendingJournal = Read-MagentaTransactionJournal `
            $journalNewPath $journalInstallDirectory $journalInstallParent $journalInstallLeaf
        if ([string]$pendingJournal.operationId -cne [string]$Journal.operationId) {
            throw "Installer journal temporary state belongs to a different transaction; preserving it: $journalNewPath"
        }
        Remove-MagentaPlainPath $journalNewPath
    }
    $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes(($Journal | ConvertTo-Json -Depth 4 -Compress))
    # CreateNew is intentional: a pre-existing ordinary file must never be
    # truncated between the path check above and the durable write.
    Write-MagentaDurableBytes $journalNewPath $bytes ([IO.FileMode]::CreateNew)

    $journalItem = Get-MagentaItem $JournalPath
    if ($null -eq $journalItem) {
        [IO.File]::Move($journalNewPath, $JournalPath)
    } else {
        Assert-MagentaPlainItem $JournalPath $false | Out-Null
        [IO.File]::Replace($journalNewPath, $JournalPath, $null, $true)
    }
}

function Read-MagentaTransactionJournal(
    [string]$JournalPath,
    [string]$InstallDirectory,
    [string]$InstallParent,
    [string]$InstallLeaf
) {
    $journalItem = Assert-MagentaPlainItem $JournalPath $false
    if ($journalItem.Length -gt 262144) {
        throw "Installer journal is unexpectedly large; preserving it for manual inspection: $JournalPath"
    }
    try {
        $journal = [IO.File]::ReadAllText($JournalPath) | ConvertFrom-Json
    } catch {
        throw "Installer journal is damaged; refusing to guess which installation data to remove: $JournalPath. Error: $_"
    }
    $properties = @(
        "schemaVersion", "operationId", "installDir", "phase", "stagingDir", "backupDir",
        "hadPreviousInstall", "hadPreviousBinary", "oldEntryNames", "newEntryNames",
        "expectedBinarySha256", "targetVersion"
    )
    Assert-MagentaJsonProperties $journal $properties "Installer journal"
    if ($journal.schemaVersion -ne $magentaJournalSchemaVersion) {
        throw "Unsupported installer journal schema; preserving $JournalPath."
    }
    $operationId = [string]$journal.operationId
    if ($operationId -cnotmatch '^[0-9a-f]{32}$') {
        throw "Installer journal has an invalid operation ID; preserving $JournalPath."
    }
    if (-not (Test-MagentaPathEqual ([string]$journal.installDir) $InstallDirectory)) {
        throw "Installer journal belongs to a different InstallDir; preserving $JournalPath."
    }
    $phase = [string]$journal.phase
    if (@("staging", "prepared", "resources_backed_up", "activated") -cnotcontains $phase) {
        throw "Installer journal has an unknown phase '$phase'; preserving $JournalPath."
    }
    if ($journal.hadPreviousInstall -isnot [bool] -or $journal.hadPreviousBinary -isnot [bool]) {
        throw "Installer journal has invalid previous-installation flags; preserving $JournalPath."
    }

    $expectedStaging = Join-Path $InstallParent ("." + $InstallLeaf + ".staging-" + $operationId)
    $expectedBackup = Join-Path $InstallParent ("." + $InstallLeaf + ".backup-" + $operationId)
    if (
        -not (Test-MagentaPathEqual ([string]$journal.stagingDir) $expectedStaging) -or
        -not (Test-MagentaPathEqual ([string]$journal.backupDir) $expectedBackup)
    ) {
        throw "Installer journal contains paths outside its operation namespace; preserving $JournalPath."
    }

    $oldEntries = @(ConvertTo-MagentaEntryNames $journal.oldEntryNames "old")
    $newEntries = @(ConvertTo-MagentaEntryNames $journal.newEntryNames "new")
    if ([bool]$journal.hadPreviousInstall -ne ($oldEntries.Count -gt 0)) {
        throw "Installer journal previous-installation state does not match its entry manifest."
    }
    $oldHasBinary = @($oldEntries | Where-Object { $_ -ieq "magenta.exe" }).Count -eq 1
    if ([bool]$journal.hadPreviousBinary -ne $oldHasBinary) {
        throw "Installer journal previous-binary state does not match its entry manifest."
    }
    if ($oldEntries -icontains $magentaInstallLockName -or $newEntries -icontains $magentaInstallLockName) {
        throw "Installer journal attempts to move the shared install/update lock."
    }
    if ($oldEntries -icontains $magentaTransactionMarkerName -or $newEntries -icontains $magentaTransactionMarkerName) {
        throw "Installer journal attempts to move its ownership marker."
    }

    $expectedHash = [string]$journal.expectedBinarySha256
    $targetVersion = [string]$journal.targetVersion
    if ($phase -eq "staging") {
        if ($expectedHash -ne "" -or $targetVersion -ne "" -or $newEntries.Count -ne 0) {
            throw "Staging-phase installer journal contains activation metadata; preserving $JournalPath."
        }
    } else {
        if ($expectedHash -cnotmatch '^[0-9a-f]{64}$' -or [string]::IsNullOrWhiteSpace($targetVersion) -or $targetVersion.Length -gt 128) {
            throw "Installer journal activation metadata is invalid; preserving $JournalPath."
        }
        if ($newEntries -inotcontains "magenta.exe") {
            throw "Installer journal activation manifest has no magenta.exe."
        }
    }

    return [PSCustomObject]@{
        schemaVersion = $magentaJournalSchemaVersion
        operationId = $operationId
        installDir = $InstallDirectory
        phase = $phase
        stagingDir = (Get-NormalizedMagentaPath $expectedStaging)
        backupDir = (Get-NormalizedMagentaPath $expectedBackup)
        hadPreviousInstall = [bool]$journal.hadPreviousInstall
        hadPreviousBinary = [bool]$journal.hadPreviousBinary
        oldEntryNames = $oldEntries
        newEntryNames = $newEntries
        expectedBinarySha256 = $expectedHash
        targetVersion = $targetVersion
    }
}

function Remove-MagentaJournalState([string]$JournalPath) {
    $journalNewPath = Join-Path (Split-Path -Parent $JournalPath) $magentaUpdateJournalTempName
    foreach ($path in @($journalNewPath, $JournalPath)) {
        $item = Get-MagentaItem $path
        if ($null -eq $item) { continue }
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing to remove non-file installer journal state: $path"
        }
        Remove-Item -LiteralPath $path -Force -ErrorAction Stop
    }
}

function Get-MagentaInstallEntries([string]$InstallDirectory) {
    $entries = New-Object "System.Collections.Generic.List[string]"
    foreach ($item in @(Get-ChildItem -LiteralPath $InstallDirectory -Force -ErrorAction Stop)) {
        if (
            $item.Name -ieq $magentaInstallLockName -or
            $item.Name -ieq $magentaUpdateJournalName -or
            $item.Name -ieq $magentaUpdateJournalTempName
        ) { continue }
        Assert-MagentaManagedEntry $item "InstallDir"
        $entries.Add($item.Name)
    }
    return @($entries.ToArray())
}

function Assert-MagentaExistingInstallationOwnership(
    [string]$InstallDirectory,
    [string[]]$EntryNames
) {
    if ($EntryNames.Count -eq 0) { return }
    if ($EntryNames -inotcontains "magenta.exe") {
        throw "Non-empty InstallDir has managed-looking data but no Magenta executable; preserving it and refusing mutation: $InstallDirectory"
    }
    Assert-MagentaPlainItem (Join-Path $InstallDirectory "magenta.exe") $false | Out-Null
}

function Enter-MagentaInstallLock([string]$InstallDirectory) {
    $lockDirectory = Join-Path $InstallDirectory $magentaInstallLockName
    $deadline = [DateTime]::UtcNow.AddMinutes($magentaLockWaitMinutes)
    while ($true) {
        try {
            New-Item -ItemType Directory -Path $lockDirectory -ErrorAction Stop | Out-Null
            [IO.Directory]::SetLastWriteTimeUtc($lockDirectory, [DateTime]::UtcNow)
            break
        } catch {
            $createError = $_
            try {
                $lockItem = Get-Item -LiteralPath $lockDirectory -Force -ErrorAction Stop
            } catch {
                throw "Unable to acquire or safely inspect the shared Magenta install/update lock at $lockDirectory. Create error: $createError Inspect error: $_"
            }
            if (-not $lockItem.PSIsContainer -or ($lockItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Shared Magenta install/update lock path is not a plain directory: $lockDirectory"
            }
            if ($lockItem.LastWriteTimeUtc -lt [DateTime]::UtcNow.AddMinutes(-$magentaLockStaleMinutes)) {
                $observedLockMtime = $lockItem.LastWriteTimeUtc
                $lockChildren = @(Get-ChildItem -LiteralPath $lockDirectory -Force -ErrorAction Stop)
                if ($lockChildren.Count -ne 0) {
                    throw "Stale Magenta install/update lock is not empty; refusing to delete unknown data: $lockDirectory"
                }
                $recheckedLock = Get-Item -LiteralPath $lockDirectory -Force -ErrorAction Stop
                if (
                    $recheckedLock.LastWriteTimeUtc -ne $observedLockMtime -or
                    $recheckedLock.LastWriteTimeUtc -ge [DateTime]::UtcNow.AddMinutes(-$magentaLockStaleMinutes)
                ) {
                    continue
                }
                try {
                    [IO.Directory]::Delete($lockDirectory, $false)
                } catch {
                    throw "Unable to remove the verified empty stale Magenta install/update lock at $lockDirectory. Error: $_"
                }
                continue
            }
            if ([DateTime]::UtcNow -ge $deadline) {
                throw "Timed out waiting for another Magenta install/update transaction at $lockDirectory."
            }
            Start-Sleep -Milliseconds 250
        }
    }

    $ownerProcess = Get-Process -Id $PID -ErrorAction Stop
    $ownerStartTicks = $ownerProcess.StartTime.ToUniversalTime().Ticks
    try {
        $heartbeatJob = Start-Job -ArgumentList @($lockDirectory, $PID, $ownerStartTicks) -ScriptBlock {
            param($LockDirectory, $OwnerProcessId, $OwnerStartTicks)
            while ($true) {
                try {
                    $owner = Get-Process -Id $OwnerProcessId -ErrorAction Stop
                    if ($owner.StartTime.ToUniversalTime().Ticks -ne $OwnerStartTicks) { break }
                    [IO.Directory]::SetLastWriteTimeUtc($LockDirectory, [DateTime]::UtcNow)
                } catch {
                    break
                }
                Start-Sleep -Seconds 10
            }
        }
    } catch {
        try { [IO.Directory]::Delete($lockDirectory, $false) } catch {}
        throw "Unable to start the shared install/update lock heartbeat; installation did not begin. Error: $_"
    }
    return [PSCustomObject]@{ Path = $lockDirectory; HeartbeatJob = $heartbeatJob }
}

function Assert-MagentaInstallLockOwned($LockHandle) {
    $lockItem = Assert-MagentaPlainItem $LockHandle.Path $true
    if ($lockItem.LastWriteTimeUtc -lt [DateTime]::UtcNow.AddMinutes(-1)) {
        throw "Shared Magenta install/update lock heartbeat is stale; refusing to mutate InstallDir."
    }
    if ($LockHandle.HeartbeatJob.State -ne "Running") {
        throw "Shared Magenta install/update lock heartbeat stopped; refusing to mutate InstallDir."
    }
    if ((@(Get-ChildItem -LiteralPath $LockHandle.Path -Force -ErrorAction Stop)).Count -ne 0) {
        throw "Shared Magenta install/update lock is no longer empty; refusing to mutate InstallDir."
    }
}

function Exit-MagentaInstallLock($LockHandle) {
    if ($null -eq $LockHandle) { return }
    try {
        Stop-Job -Job $LockHandle.HeartbeatJob -ErrorAction Stop
    } catch {
        throw "Unable to stop the shared install/update lock heartbeat; preserving the lock. Error: $_"
    }
    if (@("Completed", "Failed", "Stopped") -notcontains ([string]$LockHandle.HeartbeatJob.State)) {
        throw "Shared install/update lock heartbeat did not stop; preserving the lock."
    }
    try { Remove-Job -Job $LockHandle.HeartbeatJob -ErrorAction SilentlyContinue } catch {}
    $lockItem = Get-MagentaItem $LockHandle.Path
    if ($null -eq $lockItem) { return }
    if (-not $lockItem.PSIsContainer -or ($lockItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Shared Magenta install/update lock changed type while held: $($LockHandle.Path)"
    }
    $children = @(Get-ChildItem -LiteralPath $LockHandle.Path -Force -ErrorAction Stop)
    if ($children.Count -ne 0) {
        throw "Shared Magenta install/update lock is no longer empty; refusing to remove it: $($LockHandle.Path)"
    }
    [IO.Directory]::Delete($LockHandle.Path, $false)
}

function Remove-MagentaTransactionDirectory(
    [string]$Directory,
    [string]$OperationId,
    [string]$InstallDirectory,
    [string]$Role,
    [bool]$AllowUnmarkedEmpty = $false
) {
    $item = Get-MagentaItem $Directory
    if ($null -eq $item) { return }
    Assert-MagentaPlainItem $Directory $true | Out-Null
    $markerPath = Join-Path $Directory $magentaTransactionMarkerName
    if ($null -eq (Get-MagentaItem $markerPath)) {
        $children = @(Get-ChildItem -LiteralPath $Directory -Force -ErrorAction Stop)
        if ($AllowUnmarkedEmpty -and $children.Count -eq 0) {
            [IO.Directory]::Delete($Directory, $false)
            return
        }
        throw "Transaction directory has no valid ownership marker; preserving it: $Directory"
    }
    Read-MagentaOwnershipMarker $Directory $OperationId $InstallDirectory $Role | Out-Null
    Remove-MagentaPlainPath $Directory
}

function Test-MagentaInstalledTransaction($Journal, [string[]]$RequiredResources) {
    $binary = Join-Path $Journal.installDir "magenta.exe"
    $binaryItem = Get-MagentaItem $binary
    if ($null -eq $binaryItem) { return $false }
    if ($binaryItem.PSIsContainer -or ($binaryItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Installed transaction binary is not a plain file: $binary"
    }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $binary).Hash.ToLowerInvariant() -cne $Journal.expectedBinarySha256) {
        return $false
    }

    foreach ($entryName in @($Journal.newEntryNames)) {
        $entryPath = Join-Path $Journal.installDir $entryName
        $entryItem = Get-MagentaItem $entryPath
        if ($null -eq $entryItem) { return $false }
        if (($entryItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Installed transaction entry is a reparse point: $entryPath"
        }
    }
    foreach ($relativePath in $RequiredResources) {
        $resourcePath = Join-Path $Journal.installDir $relativePath
        $resourceItem = Get-MagentaItem $resourcePath
        if ($null -eq $resourceItem -or $resourceItem.PSIsContainer) { return $false }
        if (($resourceItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Installed transaction resource is a reparse point: $resourcePath"
        }
    }

    $releaseMarkerPath = Join-Path $Journal.installDir "magenta-release.json"
    try {
        $releaseMarker = [IO.File]::ReadAllText($releaseMarkerPath) | ConvertFrom-Json
    } catch {
        return $false
    }
    return ([string]$releaseMarker.version -ceq [string]$Journal.targetVersion)
}

function Assert-MagentaRecoveryManifests($Journal) {
    $allowedTargetNames = @($Journal.oldEntryNames) + @($Journal.newEntryNames) + @(
        $magentaInstallLockName,
        $magentaUpdateJournalName,
        $magentaUpdateJournalTempName,
        $magentaTransactionMarkerName
    )
    foreach ($item in @(Get-ChildItem -LiteralPath $Journal.installDir -Force -ErrorAction Stop)) {
        if ($allowedTargetNames -inotcontains $item.Name) {
            throw "InstallDir changed outside the recorded transaction; preserving journal and backups: $($item.FullName)"
        }
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Recovery encountered a reparse point; preserving journal and backups: $($item.FullName)"
        }
    }

    $backupItem = Get-MagentaItem $Journal.backupDir
    if ($null -ne $backupItem) {
        Read-MagentaOwnershipMarker $Journal.backupDir $Journal.operationId $Journal.installDir "backup" | Out-Null
        $allowedBackupNames = @($Journal.oldEntryNames) + @($magentaTransactionMarkerName)
        foreach ($item in @(Get-ChildItem -LiteralPath $Journal.backupDir -Force -ErrorAction Stop)) {
            if ($allowedBackupNames -inotcontains $item.Name) {
                throw "Backup contains data outside the recorded transaction; preserving it: $($item.FullName)"
            }
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Backup contains a reparse point; preserving it: $($item.FullName)"
            }
        }
    }

    $stagingItem = Get-MagentaItem $Journal.stagingDir
    if ($null -ne $stagingItem) {
        Read-MagentaOwnershipMarker $Journal.stagingDir $Journal.operationId $Journal.installDir "staging" | Out-Null
        $allowedStagingNames = @($Journal.newEntryNames) + @(
            $magentaTransactionMarkerName,
            ".magenta-rollback-discard.exe"
        )
        foreach ($item in @(Get-ChildItem -LiteralPath $Journal.stagingDir -Force -ErrorAction Stop)) {
            if ($allowedStagingNames -inotcontains $item.Name) {
                throw "Staging contains data outside the recorded transaction; preserving it: $($item.FullName)"
            }
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Staging contains a reparse point; preserving it: $($item.FullName)"
            }
        }
    }
}

function Remove-MagentaEmptyUnmarkedPreparedBackup($Journal) {
    if ($Journal.phase -cne "prepared") { return }
    $backupItem = Get-MagentaItem $Journal.backupDir
    if ($null -eq $backupItem) { return }
    Assert-MagentaPlainItem $Journal.backupDir $true | Out-Null
    $markerPath = Join-Path $Journal.backupDir $magentaTransactionMarkerName
    if ($null -ne (Get-MagentaItem $markerPath)) { return }

    # The only mutation between backup-directory creation and its ownership
    # marker is the creation of an empty, journal-bound directory. Recover that
    # exact crash window without accepting or recursively deleting any content.
    if ((@(Get-ChildItem -LiteralPath $Journal.backupDir -Force -ErrorAction Stop)).Count -ne 0) {
        throw "Prepared installer backup has no ownership marker and is not empty; preserving it: $($Journal.backupDir)"
    }
    Assert-MagentaPlainItem $Journal.backupDir $true | Out-Null
    if ((@(Get-ChildItem -LiteralPath $Journal.backupDir -Force -ErrorAction Stop)).Count -ne 0) {
        throw "Prepared installer backup changed while being inspected; preserving it: $($Journal.backupDir)"
    }
    [IO.Directory]::Delete($Journal.backupDir, $false)
}

function Restore-MagentaTransaction($Journal, [string]$JournalPath) {
    Remove-MagentaEmptyUnmarkedPreparedBackup $Journal
    Assert-MagentaRecoveryManifests $Journal

    $activeMarkerPath = Join-Path $Journal.installDir $magentaTransactionMarkerName
    $hasActiveMarker = $null -ne (Get-MagentaItem $activeMarkerPath)
    if ($hasActiveMarker) {
        Read-MagentaOwnershipMarker $Journal.installDir $Journal.operationId $Journal.installDir "active" | Out-Null
    }
    $canRemoveActivatedEntry = $hasActiveMarker -or $Journal.phase -eq "activated"

    $installedBinary = Join-Path $Journal.installDir "magenta.exe"
    $backupBinary = Join-Path $Journal.backupDir "magenta.exe"
    $discardBinary = Join-Path $Journal.stagingDir ".magenta-rollback-discard.exe"
    $discardItem = Get-MagentaItem $discardBinary
    if ($null -ne $discardItem) {
        Assert-MagentaPlainItem $discardBinary $false | Out-Null
        if ((Get-FileHash -Algorithm SHA256 -LiteralPath $discardBinary).Hash.ToLowerInvariant() -cne $Journal.expectedBinarySha256) {
            throw "Rollback discard binary is not the recorded replacement; preserving transaction state."
        }
        Remove-Item -LiteralPath $discardBinary -Force -ErrorAction Stop
    }

    $currentBinaryItem = Get-MagentaItem $installedBinary
    $backupBinaryItem = Get-MagentaItem $backupBinary
    if ($Journal.hadPreviousBinary) {
        if ($null -ne $backupBinaryItem) {
            Assert-MagentaPlainItem $backupBinary $false | Out-Null
            if ($null -ne $currentBinaryItem) {
                Assert-MagentaPlainItem $installedBinary $false | Out-Null
                if ($null -ne (Get-MagentaItem $discardBinary)) {
                    throw "Rollback discard path already exists: $discardBinary"
                }
                [IO.File]::Replace($backupBinary, $installedBinary, $discardBinary, $true)
                Assert-MagentaPlainItem $discardBinary $false | Out-Null
                Remove-Item -LiteralPath $discardBinary -Force -ErrorAction Stop
            } else {
                [IO.File]::Move($backupBinary, $installedBinary)
            }
        } elseif ($null -eq $currentBinaryItem) {
            throw "Neither the previous nor replacement Magenta binary can be found; preserving transaction state."
        }
    } else {
        if ($null -ne $backupBinaryItem) {
            throw "Transaction backup unexpectedly contains a previous binary; preserving it."
        }
        if ($null -ne $currentBinaryItem) {
            if (-not $canRemoveActivatedEntry) {
                throw "An unowned binary appeared during fresh-install recovery; refusing to remove it."
            }
            Assert-MagentaPlainItem $installedBinary $false | Out-Null
            if ((Get-FileHash -Algorithm SHA256 -LiteralPath $installedBinary).Hash.ToLowerInvariant() -cne $Journal.expectedBinarySha256) {
                throw "Fresh-install binary does not match the journal; refusing to remove it."
            }
            Remove-Item -LiteralPath $installedBinary -Force -ErrorAction Stop
        }
    }

    foreach ($entryName in @($Journal.newEntryNames | Where-Object { $_ -ine "magenta.exe" })) {
        $targetPath = Join-Path $Journal.installDir $entryName
        $backupPath = Join-Path $Journal.backupDir $entryName
        $targetItem = Get-MagentaItem $targetPath
        if ($null -eq $targetItem) { continue }
        $backupHasEntry = $null -ne (Get-MagentaItem $backupPath)
        $oldHadEntry = $Journal.oldEntryNames -icontains $entryName
        if ($backupHasEntry -or -not $oldHadEntry) {
            if (-not $canRemoveActivatedEntry) {
                throw "Cannot prove that transaction entry is safe to remove: $targetPath"
            }
            Remove-MagentaPlainPath $targetPath
        }
    }

    foreach ($entryName in @($Journal.oldEntryNames | Where-Object { $_ -ine "magenta.exe" })) {
        $targetPath = Join-Path $Journal.installDir $entryName
        $backupPath = Join-Path $Journal.backupDir $entryName
        $backupItem = Get-MagentaItem $backupPath
        $targetItem = Get-MagentaItem $targetPath
        if ($null -ne $backupItem) {
            if ($null -ne $targetItem) {
                throw "Recovery destination already exists while its backup is present: $targetPath"
            }
            Move-Item -LiteralPath $backupPath -Destination $targetPath -ErrorAction Stop
        } elseif ($null -eq $targetItem) {
            throw "Recorded previous installation entry is missing from both active and backup paths: $entryName"
        }
    }

    if ($hasActiveMarker) {
        Remove-Item -LiteralPath $activeMarkerPath -Force -ErrorAction Stop
    }
    Remove-MagentaTransactionDirectory $Journal.backupDir $Journal.operationId $Journal.installDir "backup"
    Remove-MagentaTransactionDirectory $Journal.stagingDir $Journal.operationId $Journal.installDir "staging"
    Remove-MagentaJournalState $JournalPath
    return "rolled_back"
}

function Complete-MagentaTransaction($Journal, [string]$JournalPath, [string[]]$RequiredResources) {
    if (-not (Test-MagentaInstalledTransaction $Journal $RequiredResources)) {
        $activeMarkerPath = Join-Path $Journal.installDir $magentaTransactionMarkerName
        $hasActiveMarker = $null -ne (Get-MagentaItem $activeMarkerPath)
        $hasBackup = $null -ne (Get-MagentaItem $Journal.backupDir)
        if (($Journal.hadPreviousInstall -and -not $hasBackup) -or (-not $Journal.hadPreviousInstall -and -not $hasActiveMarker)) {
            throw "Activated installation is incomplete and its rollback ownership evidence is no longer available; preserving the journal."
        }
        return Restore-MagentaTransaction $Journal $JournalPath
    }
    $activeMarkerPath = Join-Path $Journal.installDir $magentaTransactionMarkerName
    if ($null -ne (Get-MagentaItem $activeMarkerPath)) {
        Read-MagentaOwnershipMarker $Journal.installDir $Journal.operationId $Journal.installDir "active" | Out-Null
        Remove-Item -LiteralPath $activeMarkerPath -Force -ErrorAction Stop
    }
    Remove-MagentaTransactionDirectory $Journal.backupDir $Journal.operationId $Journal.installDir "backup"
    Remove-MagentaTransactionDirectory $Journal.stagingDir $Journal.operationId $Journal.installDir "staging"
    Remove-MagentaJournalState $JournalPath
    return "completed"
}

function Invoke-MagentaTransactionRecovery(
    [string]$JournalPath,
    [string]$InstallDirectory,
    [string]$InstallParent,
    [string]$InstallLeaf,
    [string[]]$RequiredResources
) {
    $journalNewPath = Join-Path (Split-Path -Parent $JournalPath) $magentaUpdateJournalTempName
    $journalItem = Get-MagentaItem $JournalPath
    if ($null -eq $journalItem) {
        $newItem = Get-MagentaItem $journalNewPath
        if ($null -eq $newItem) { return "none" }
        # A complete initial journal write may have reached disk before its
        # atomic rename. Validate it before promotion; damaged state is kept.
        Read-MagentaTransactionJournal $journalNewPath $InstallDirectory $InstallParent $InstallLeaf | Out-Null
        [IO.File]::Move($journalNewPath, $JournalPath)
    }

    $journal = Read-MagentaTransactionJournal $JournalPath $InstallDirectory $InstallParent $InstallLeaf
    $journalTempItem = Get-MagentaItem $journalNewPath
    if ($null -ne $journalTempItem) {
        if ($journalTempItem.PSIsContainer -or ($journalTempItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Installer journal temporary path is not a plain file: $journalNewPath"
        }
        # The main journal is authoritative when both names exist (the temp
        # may be left by a crash during File.Replace).  Only discard a temp
        # that independently validates and belongs to the same operation.
        $pendingJournal = Read-MagentaTransactionJournal $journalNewPath $InstallDirectory $InstallParent $InstallLeaf
        if ([string]$pendingJournal.operationId -cne [string]$journal.operationId) {
            throw "Installer journal temporary state belongs to a different transaction; preserving it: $journalNewPath"
        }
        Remove-MagentaPlainPath $journalNewPath
    }
    if ($journal.phase -eq "staging") {
        if ($null -ne (Get-MagentaItem $journal.backupDir)) {
            throw "Staging-phase journal unexpectedly has a backup; preserving transaction state."
        }
        $activeMarker = Get-MagentaItem (Join-Path $InstallDirectory $magentaTransactionMarkerName)
        if ($null -ne $activeMarker) {
            throw "Staging-phase journal unexpectedly has an active marker; preserving transaction state."
        }
        Remove-MagentaTransactionDirectory $journal.stagingDir $journal.operationId $InstallDirectory "staging" $true
        Remove-MagentaJournalState $JournalPath
        return "rolled_back"
    }
    if ($journal.phase -eq "activated") {
        return Complete-MagentaTransaction $journal $JournalPath $RequiredResources
    }
    return Restore-MagentaTransaction $journal $JournalPath
}

function Remove-MagentaOwnedOrphans(
    [string]$InstallDirectory,
    [string]$InstallParent,
    [string]$InstallLeaf
) {
    $escapedLeaf = [Regex]::Escape($InstallLeaf)
    $pattern = '^\.' + $escapedLeaf + '\.(staging|backup)-([0-9a-f]{32})$'
    foreach ($item in @(Get-ChildItem -LiteralPath $InstallParent -Force -ErrorAction Stop)) {
        if ($item.Name -cnotmatch $pattern) { continue }
        $role = $matches[1]
        $operationId = $matches[2]
        try {
            Remove-MagentaTransactionDirectory $item.FullName $operationId $InstallDirectory $role
            Write-Host "Removed orphaned Magenta installer $role state: $($item.FullName)"
        } catch {
            Write-Warning "Preserving unverified installer-like directory $($item.FullName). Error: $_"
        }
    }
}

if (-not [Environment]::Is64BitOperatingSystem) {
    throw "Magenta currently requires 64-bit Windows."
}

$fullInstallDir = [System.IO.Path]::GetFullPath($InstallDir)
$installRoot = [System.IO.Path]::GetPathRoot($fullInstallDir)
$InstallDir = Get-NormalizedMagentaPath $fullInstallDir
$normalizedInstallRoot = $installRoot.TrimEnd($pathSeparators)
if ([string]::IsNullOrWhiteSpace($InstallDir) -or $InstallDir -ieq $normalizedInstallRoot) {
    throw "InstallDir must be a directory below the filesystem root."
}

$installParent = Split-Path -Parent $InstallDir
$installLeaf = Split-Path -Leaf $InstallDir
if ([string]::IsNullOrWhiteSpace($installParent) -or [string]::IsNullOrWhiteSpace($installLeaf)) {
    throw "Unable to resolve InstallDir: $InstallDir"
}

if (-not (Test-Path -LiteralPath $installParent -PathType Container)) {
    New-Item -ItemType Directory -Force -Path $installParent | Out-Null
}
$installItem = Get-MagentaItem $InstallDir
if ($null -eq $installItem) {
    New-Item -ItemType Directory -Path $InstallDir -ErrorAction Stop | Out-Null
} else {
    Assert-MagentaPlainItem $InstallDir $true | Out-Null
}

# Support MAGENTA_GITHUB_MIRROR for restricted networks
$mirror = $env:MAGENTA_GITHUB_MIRROR
if ($mirror) {
    $mirror = $mirror.TrimEnd("/")
}

# Built-in mirror candidates for restricted networks (used when direct download is slow/unreachable).
$builtinMirrors = @(
    "https://ghfast.top",
    "https://ghproxy.net",
    "https://gh.ddlc.top",
    "https://github.moeyy.xyz"
)

# Download ceilings are enforced after every transfer, including chunked
# responses that do not provide Content-Length.  Keep SHA256SUMS much smaller
# than executable/resource payloads because it is only a text trust root.
$magentaChecksumMaxBytes = [long](1 * 1024 * 1024)
$magentaAssetMaxBytes = [long](512 * 1024 * 1024)
$magentaDownloadTimeoutSeconds = 900

function Remove-MagentaDownloadPartial([string]$Path) {
    $item = Get-MagentaItem $Path
    if ($null -eq $item) { return }
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing to remove an unsafe partial download path: $Path"
    }
    Remove-Item -LiteralPath $Path -Force -ErrorAction Stop
}

function Test-MagentaDownloadFile(
    [string]$Path,
    [long]$MinBytes,
    [long]$MaxBytes,
    [string]$SourceUrl
) {
    $item = Get-MagentaItem $Path
    if ($null -eq $item) { return $false }
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Downloaded payload is not a plain file: $Path"
    }
    if ($item.Length -gt $MaxBytes) {
        throw "Downloaded payload from $SourceUrl exceeds the $MaxBytes-byte limit ($($item.Length) bytes)."
    }
    return $item.Length -ge $MinBytes
}

function Invoke-MagentaHttpDownload([string]$Url, [string]$PartialPath, [long]$MaxBytes) {
    $client = New-Object System.Net.Http.HttpClient
    $client.Timeout = [TimeSpan]::FromSeconds($magentaDownloadTimeoutSeconds)
    $response = $null
    $input = $null
    $output = $null
    $created = $false
    $completed = $false
    try {
        $response = $client.GetAsync($Url, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        if (-not $response.IsSuccessStatusCode) {
            throw "HTTP $([int]$response.StatusCode) $($response.ReasonPhrase)"
        }
        $contentLength = $response.Content.Headers.ContentLength
        if ($null -ne $contentLength -and [long]$contentLength -gt $MaxBytes) {
            throw "Response declares $contentLength bytes, exceeding the $MaxBytes-byte limit."
        }

        $input = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $output = New-Object System.IO.FileStream -ArgumentList @(
            $PartialPath,
            [IO.FileMode]::CreateNew,
            [IO.FileAccess]::Write,
            [IO.FileShare]::None,
            65536,
            [IO.FileOptions]::WriteThrough
        )
        $created = $true
        $buffer = New-Object byte[] 65536
        [long]$received = 0
        while (($read = $input.Read($buffer, 0, $buffer.Length)) -gt 0) {
            if ($received -gt ($MaxBytes - $read)) {
                throw "Response exceeded the $MaxBytes-byte limit while streaming."
            }
            $output.Write($buffer, 0, $read)
            $received += $read
        }
        $output.Flush($true)
        $completed = $true
    } finally {
        if ($null -ne $output) { $output.Dispose() }
        if ($null -ne $input) { $input.Dispose() }
        if ($null -ne $response) { $response.Dispose() }
        $client.Dispose()
        if ($created -and -not $completed) {
            Remove-MagentaDownloadPartial $PartialPath
        }
    }
}

# Robust download: try BITS (background, resumable) then a bounded HTTP stream, across
# the direct URL plus mirror candidates, until the file is fully retrieved.
# Set AllowMirrors to false for trust roots such as SHA256SUMS.
function Invoke-MagentaDownload(
    [string]$DirectUrl,
    [string]$OutFile,
    [long]$MinBytes = 0,
    [bool]$AllowMirrors = $true,
    [long]$MaxBytes = $magentaAssetMaxBytes
) {
    if ($MinBytes -lt 0 -or $MaxBytes -le 0 -or $MinBytes -gt $MaxBytes) {
        throw "Invalid Magenta download byte limits: minimum=$MinBytes maximum=$MaxBytes"
    }
    $candidates = New-Object System.Collections.Generic.List[string]
    # Mirrors only make sense for public github.com asset URLs. A custom base
    # (e.g. -AssetBaseUrl for CI smoke tests or a private host) is used verbatim.
    $mirrorable = $DirectUrl -like "https://github.com/*"
    if ($mirrorable -and $AllowMirrors) {
        if ($env:MAGENTA_GITHUB_MIRROR) {
            $candidates.Add(($env:MAGENTA_GITHUB_MIRROR.TrimEnd('/')) + "/" + $DirectUrl)
        }
        foreach ($m in $builtinMirrors) { $candidates.Add($m + "/" + $DirectUrl) }
    }
    $candidates.Add($DirectUrl)

    foreach ($url in $candidates) {
        $srcHost = ([System.Uri]$url).Host
        $partialPath = "$OutFile.part"
        if ($null -ne (Get-MagentaItem $partialPath)) {
            throw "A previous partial download exists; refusing to reuse it: $partialPath"
        }
        # 1) BITS transfer (uses Windows background service, supports resume)
        try {
            if (Get-Command Start-BitsTransfer -ErrorAction SilentlyContinue) {
                Write-Host "  Trying download source (BITS): $srcHost"
                Start-BitsTransfer -Source $url -Destination $partialPath -ErrorAction Stop
                if (Test-MagentaDownloadFile $partialPath $MinBytes $MaxBytes $url) {
                    [IO.File]::Move($partialPath, $OutFile)
                    return
                }
                Remove-MagentaDownloadPartial $partialPath
            }
        } catch {
            if ($null -ne (Get-MagentaItem $partialPath)) {
                try { Remove-MagentaDownloadPartial $partialPath } catch { throw "BITS left an unsafe partial download at $partialPath. Error: $_" }
            }
            Write-Host "  BITS failed; falling back to bounded HTTP streaming..."
        }
        # 2) Bounded HTTP streaming.  ResponseHeadersRead keeps unknown-length
        # bodies out of memory while the loop enforces the hard byte ceiling.
        $httpCreated = $false
        try {
            Write-Host "  Trying download source (HTTP): $srcHost"
            Invoke-MagentaHttpDownload $url $partialPath $MaxBytes
            $httpCreated = $null -ne (Get-MagentaItem $partialPath)
            if (Test-MagentaDownloadFile $partialPath $MinBytes $MaxBytes $url) {
                [IO.File]::Move($partialPath, $OutFile)
                return
            }
            Remove-MagentaDownloadPartial $partialPath
        } catch {
            if ($httpCreated -and $null -ne (Get-MagentaItem $partialPath)) {
                Remove-MagentaDownloadPartial $partialPath
            }
            Write-Host "  Source unavailable: $srcHost"
        }
    }
    throw "All download sources failed: $DirectUrl`nFor restricted networks, set `$env:MAGENTA_GITHUB_MIRROR='https://ghfast.top' and retry."
}

# Plain direct base (no mirror prefix). Invoke-MagentaDownload applies mirror
# candidates itself, trying the user mirror, built-in mirrors, then direct.
$directBase = if ($AssetBaseUrl) {
    $AssetBaseUrl.TrimEnd("/")
} elseif ($Version -eq "latest") {
    "https://github.com/$Repository/releases/latest/download"
} else {
    $tag = if ($Version.StartsWith("v")) { $Version } else { "v$Version" }
    "https://github.com/$Repository/releases/download/$tag"
}

$requiredResources = @(
    "theme\dark.json",
    "tools\read\read.toml",
    "skills\paper-analysis\pi\SKILL.md",
    "photon_rs_bg.wasm",
    "runtime\node_modules\@mariozechner\clipboard\index.js",
    "runtime\node_modules\@mariozechner\clipboard-win32-x64-msvc\clipboard.win32-x64-msvc.node",
    "magenta-release.json"
)
$journalPath = Join-Path $InstallDir $magentaUpdateJournalName
$installedBinary = Join-Path $InstallDir "magenta.exe"
$installLock = $null
$removeInstallRootAfterUnlock = $false
$uninstallHadPayload = $false
$uninstallRemovedPath = $false

try {
    $installLock = Enter-MagentaInstallLock $InstallDir
    $recoveryOutcome = Invoke-MagentaTransactionRecovery `
        $journalPath $InstallDir $installParent $installLeaf $requiredResources
    if ($recoveryOutcome -eq "completed") {
        Write-Host "Completed an interrupted Magenta installation transaction."
    } elseif ($recoveryOutcome -eq "rolled_back") {
        Write-Host "Restored the previous installation after an interrupted Magenta transaction."
    }

    if ($null -ne (Get-MagentaItem (Join-Path $InstallDir $magentaTransactionMarkerName))) {
        throw "InstallDir contains an ownership marker without a valid journal; refusing to guess recovery actions."
    }
    Remove-MagentaOwnedOrphans $InstallDir $installParent $installLeaf

    if ($Uninstall) {
        Assert-MagentaInstallLockOwned $installLock
        $installedEntries = @(Get-MagentaInstallEntries $InstallDir)
        Assert-MagentaExistingInstallationOwnership $InstallDir $installedEntries
        $uninstallHadPayload = $installedEntries.Count -gt 0
        foreach ($entryName in $installedEntries) {
            Remove-MagentaPlainPath (Join-Path $InstallDir $entryName)
        }
        $uninstallRemovedPath = Remove-MagentaFromUserPath $InstallDir
        $removeInstallRootAfterUnlock = $true
    } else {
        $operationId = [Guid]::NewGuid().ToString("N")
        $tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("magenta-download-" + $operationId)
        $stagingDir = Join-Path $installParent ("." + $installLeaf + ".staging-" + $operationId)
        $backupDir = Join-Path $installParent ("." + $installLeaf + ".backup-" + $operationId)
        $binaryPath = Join-Path $stagingDir "magenta.exe"
        $resourcesPath = Join-Path $tempDir "magenta-resources-universal.tar.gz"
        $checksumsPath = Join-Path $tempDir "SHA256SUMS"
        $oldEntryNames = @(Get-MagentaInstallEntries $InstallDir)
        Assert-MagentaExistingInstallationOwnership $InstallDir $oldEntryNames
        $journal = [ordered]@{
            schemaVersion = $magentaJournalSchemaVersion
            operationId = $operationId
            installDir = $InstallDir
            phase = "staging"
            stagingDir = $stagingDir
            backupDir = $backupDir
            hadPreviousInstall = ($oldEntryNames.Count -gt 0)
            hadPreviousBinary = ($oldEntryNames -icontains "magenta.exe")
            oldEntryNames = @($oldEntryNames)
            newEntryNames = @()
            expectedBinarySha256 = ""
            targetVersion = ""
        }

        try {
            if ($null -ne (Get-MagentaItem $stagingDir) -or $null -ne (Get-MagentaItem $backupDir)) {
                throw "New installer operation paths already exist; refusing to reuse them."
            }
            # This durable journal precedes staging creation and every mutation
            # of InstallDir, so an interrupted run always has a recovery source.
            Write-MagentaTransactionJournal $journalPath $journal
            New-Item -ItemType Directory -Path $stagingDir -ErrorAction Stop | Out-Null
            Write-MagentaOwnershipMarker $stagingDir $operationId $InstallDir "staging"
            New-Item -ItemType Directory -Path $tempDir -ErrorAction Stop | Out-Null

            Write-Host "Downloading Magenta for Windows..."
            Write-Host "[SHA256SUMS]"
            # SHA256SUMS is the integrity trust root: never fetch it through third-party
            # mirrors, otherwise a mirror could swap both the checksum file and the
            # payload it verifies. A custom -AssetBaseUrl (CI/private host) is still used
            # verbatim because it is explicitly trusted by the operator.
            Invoke-MagentaDownload "$directBase/SHA256SUMS" $checksumsPath 0 $false $magentaChecksumMaxBytes
            Write-Host "[magenta-windows-x64.exe] (~160-190MB)"
            Invoke-MagentaDownload "$directBase/magenta-windows-x64.exe" $binaryPath 1000000 $true $magentaAssetMaxBytes
            Write-Host "[magenta-resources-universal.tar.gz] (~4MB)"
            Invoke-MagentaDownload "$directBase/magenta-resources-universal.tar.gz" $resourcesPath 0 $true $magentaAssetMaxBytes

            $binarySize = (Get-Item $binaryPath).Length
            if ($binarySize -lt 1000000) {
                throw "Downloaded executable is unexpectedly small ($binarySize bytes)."
            }

            $expectedChecksums = @{}
            foreach ($line in Get-Content $checksumsPath) {
                if ($line -match '^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$') {
                    $expectedChecksums[$matches[2]] = $matches[1].ToLowerInvariant()
                }
            }
            $downloadedArtifacts = @{
                "magenta-windows-x64.exe" = $binaryPath
                "magenta-resources-universal.tar.gz" = $resourcesPath
            }
            foreach ($artifactName in $downloadedArtifacts.Keys) {
                if (-not $expectedChecksums.ContainsKey($artifactName)) {
                    throw "SHA256SUMS does not contain $artifactName."
                }
                $actualChecksum = (Get-FileHash -Algorithm SHA256 -Path $downloadedArtifacts[$artifactName]).Hash.ToLowerInvariant()
                if ($actualChecksum -ne $expectedChecksums[$artifactName]) {
                    throw "Checksum verification failed for $artifactName."
                }
            }

            Test-MagentaResourceArchive $resourcesPath
            tar.exe -xzf $resourcesPath -C $stagingDir
            if ($LASTEXITCODE -ne 0) {
                throw "Failed to extract Magenta runtime resources (tar.exe exit code $LASTEXITCODE)."
            }

            foreach ($relativePath in $requiredResources) {
                $resourcePath = Join-Path $stagingDir $relativePath
                if (-not (Test-Path $resourcePath -PathType Leaf)) {
                    throw "Runtime resource is missing from the release: $relativePath"
                }
            }

            $releaseMarker = Get-Content -LiteralPath (Join-Path $stagingDir "magenta-release.json") -Raw | ConvertFrom-Json
            if (-not $releaseMarker.version) {
                throw "Magenta runtime resource marker has no version."
            }
            $versionProbe = Invoke-MagentaCapture $binaryPath "--version"
            $binaryVersion = $versionProbe.StandardOutput.Trim()
            if ($versionProbe.ExitCode -ne 0 -or $binaryVersion -ne [string]$releaseMarker.version) {
                $versionDiagnostics = ($versionProbe.StandardOutput + $versionProbe.StandardError).Trim()
                throw "Magenta binary/resource version mismatch. Binary: $binaryVersion Resources: $($releaseMarker.version) Diagnostics: $versionDiagnostics"
            }

            Write-Host "Verifying Magenta startup and embedded process-tools..."
            # Plain --help is intentionally read-only and skips resource initialization.
            # Keep this probe offline while making it non-pure so the staged helper is installed.
            $helpProbe = Invoke-MagentaCapture $binaryPath "--help --offline smoke"
            if ($helpProbe.ExitCode -ne 0) {
                $helpDiagnostics = ($helpProbe.StandardOutput + $helpProbe.StandardError).Trim()
                throw "Magenta startup verification failed:`n$helpDiagnostics"
            }

            $processTools = Join-Path $stagingDir "_magenta\process-tools\target\release\magenta-process-tools.exe"
            if (-not (Test-Path $processTools -PathType Leaf)) {
                throw "Magenta did not initialize process-tools at $processTools."
            }

            $newEntryList = New-Object "System.Collections.Generic.List[string]"
            foreach ($item in @(Get-ChildItem -LiteralPath $stagingDir -Force -ErrorAction Stop)) {
                if ($item.Name -ieq $magentaTransactionMarkerName) { continue }
                Assert-MagentaManagedEntry $item "Staging"
                $newEntryList.Add($item.Name)
            }
            $newEntryNames = @($newEntryList.ToArray())
            if ($newEntryNames -inotcontains "magenta.exe") {
                throw "Verified staging manifest has no magenta.exe."
            }

            Assert-MagentaInstallLockOwned $installLock
            $journal["phase"] = "prepared"
            $journal["newEntryNames"] = @($newEntryNames)
            $journal["expectedBinarySha256"] = [string]$expectedChecksums["magenta-windows-x64.exe"]
            $journal["targetVersion"] = [string]$releaseMarker.version
            # Persist the complete old/new manifests before the first move.
            Write-MagentaTransactionJournal $journalPath $journal

            if ($oldEntryNames.Count -gt 0) {
                New-Item -ItemType Directory -Path $backupDir -ErrorAction Stop | Out-Null
                Write-MagentaOwnershipMarker $backupDir $operationId $InstallDir "backup"
            }
            foreach ($entryName in @($oldEntryNames | Where-Object { $_ -ine "magenta.exe" })) {
                Move-Item -LiteralPath (Join-Path $InstallDir $entryName) -Destination (Join-Path $backupDir $entryName) -ErrorAction Stop
            }

            $journal["phase"] = "resources_backed_up"
            Write-MagentaTransactionJournal $journalPath $journal
            Write-MagentaOwnershipMarker $InstallDir $operationId $InstallDir "active"

            foreach ($entryName in @($newEntryNames | Where-Object { $_ -ine "magenta.exe" })) {
                Move-Item -LiteralPath (Join-Path $stagingDir $entryName) -Destination (Join-Path $InstallDir $entryName) -ErrorAction Stop
            }

            $backupBinary = Join-Path $backupDir "magenta.exe"
            if ($journal["hadPreviousBinary"]) {
                # File.Replace is a same-volume atomic switch: magenta.exe is
                # never absent, and the old bytes become the durable backup.
                [IO.File]::Replace($binaryPath, $installedBinary, $backupBinary, $true)
            } else {
                if ($null -ne (Get-MagentaItem $installedBinary)) {
                    throw "A binary appeared after the install manifest was recorded; refusing to overwrite it."
                }
                [IO.File]::Move($binaryPath, $installedBinary)
            }

            if (-not (Test-MagentaInstalledTransaction $journal $requiredResources)) {
                throw "Installed Magenta transaction failed post-activation verification."
            }
            $journal["phase"] = "activated"
            Write-MagentaTransactionJournal $journalPath $journal
            $transactionOutcome = Complete-MagentaTransaction $journal $journalPath $requiredResources
            if ($transactionOutcome -ne "completed") {
                throw "Magenta activation was not committed."
            }
        } catch {
            $installError = $_
            try {
                $recoveredOutcome = Invoke-MagentaTransactionRecovery `
                    $journalPath $InstallDir $installParent $installLeaf $requiredResources
            } catch {
                throw "Installation failed and automatic recovery could not safely complete. Journal and owned transaction paths were preserved. Install error: $installError Recovery error: $_"
            }
            if ($recoveredOutcome -eq "completed") {
                Write-Warning "Magenta activation completed, but final cleanup initially failed: $installError"
            } else {
                throw "Installation failed and the previous installation was restored. Error: $installError"
            }
        } finally {
            try {
                if ($null -ne $tempDir -and (Test-Path -LiteralPath $tempDir)) {
                    Remove-Item -Recurse -Force -LiteralPath $tempDir
                }
            } catch {
                Write-Warning "Unable to remove temporary download directory $tempDir. Error: $_"
            }
        }

        $userPathReady = $true
        if ($NoPath) {
            $userPathReady = $false
        } else {
            try {
                $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
                $pathEntries = @($userPath -split ";" | Where-Object { $_ })
                if (-not ($pathEntries | Where-Object { Test-MagentaPathEqual $_ $InstallDir })) {
                    $updatedPath = if ($userPath) { "$userPath;$InstallDir" } else { $InstallDir }
                    [Environment]::SetEnvironmentVariable("Path", $updatedPath, "User")
                }
            } catch {
                $userPathReady = $false
                Write-Warning "Magenta was installed, but the user PATH could not be updated. Add $InstallDir manually. Error: $_"
            }
        }
        if (-not (($env:Path -split ";") | Where-Object { Test-MagentaPathEqual $_ $InstallDir })) {
            $env:Path = "$InstallDir;$env:Path"
        }

        Write-Host "Magenta installed successfully: $installedBinary"
        if ($NoPath) {
            Write-Host "Skipped PATH update (-NoPath). Run Magenta directly: $installedBinary"
        } elseif ($userPathReady) {
            Write-Host "Open a new terminal, then run: magenta"
        } else {
            Write-Host "Run Magenta directly: $installedBinary"
        }
    }
} finally {
    Exit-MagentaInstallLock $installLock
}

if ($Uninstall) {
    if ($removeInstallRootAfterUnlock) {
        try {
            [IO.Directory]::Delete($InstallDir, $false)
        } catch {
            # Another installer may have acquired the shared child lock after
            # release. Never recurse here: a non-empty root is no longer ours.
            Write-Warning "Magenta payload was removed, but InstallDir is no longer empty and was preserved: $InstallDir. Error: $_"
        }
    }
    if ($uninstallHadPayload -or $uninstallRemovedPath) {
        Write-Host "Magenta uninstalled from $InstallDir"
        if ($uninstallRemovedPath) {
            Write-Host "Removed $InstallDir from the user PATH. Open a new terminal for the change to take effect."
        }
    } else {
        Write-Host "No Magenta installation found at $InstallDir"
    }
}
