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

    $allowedDirectories = @(
        "sandbox", "tools", "policy", "runtime", "skills", "theme",
        "assets", "export-html", "docs", "examples"
    )
    $allowedFiles = @("package.json", "README.md", "CHANGELOG.md", "magenta-release.json")
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
    $hasWasm = $false

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
        $isTopLevelWasm = $segments.Count -eq 1 -and $topLevel -match '^[A-Za-z0-9][A-Za-z0-9._-]*\.wasm$'
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
        if ($isTopLevelWasm) { $hasWasm = $true }
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
    if (-not $hasWasm) {
        throw "Magenta runtime resource archive contains no top-level WASM asset."
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

if ($Uninstall) {
    $removedDir = $false
    if (Test-Path -LiteralPath $InstallDir -PathType Container) {
        Remove-Item -Recurse -Force -LiteralPath $InstallDir
        $removedDir = $true
    }
    $removedPath = Remove-MagentaFromUserPath $InstallDir
    if ($removedDir -or $removedPath) {
        Write-Host "Magenta uninstalled from $InstallDir"
        if ($removedPath) {
            Write-Host "Removed $InstallDir from the user PATH. Open a new terminal for the change to take effect."
        }
    } else {
        Write-Host "No Magenta installation found at $InstallDir"
    }
    return
}

if (-not (Test-Path -LiteralPath $installParent -PathType Container)) {
    New-Item -ItemType Directory -Force -Path $installParent | Out-Null
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

# Robust download: try BITS (background, resumable) then Invoke-WebRequest, across
# the direct URL plus mirror candidates, until the file is fully retrieved.
# Set AllowMirrors to false for trust roots such as SHA256SUMS.
function Invoke-MagentaDownload([string]$DirectUrl, [string]$OutFile, [long]$MinBytes = 0, [bool]$AllowMirrors = $true) {
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
        # 1) BITS transfer (uses Windows background service, supports resume)
        try {
            if (Get-Command Start-BitsTransfer -ErrorAction SilentlyContinue) {
                if (Test-Path -LiteralPath $OutFile) { Remove-Item -Force -LiteralPath $OutFile }
                Write-Host "  Trying download source (BITS): $srcHost"
                Start-BitsTransfer -Source $url -Destination $OutFile -ErrorAction Stop
                if ((Test-Path -LiteralPath $OutFile) -and ((Get-Item $OutFile).Length -ge $MinBytes)) {
                    return
                }
            }
        } catch {
            Write-Host "  BITS failed; falling back to Invoke-WebRequest..."
        }
        # 2) Invoke-WebRequest
        try {
            Write-Host "  Trying download source (IWR): $srcHost"
            Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $OutFile -ErrorAction Stop
            if ((Test-Path -LiteralPath $OutFile) -and ((Get-Item $OutFile).Length -ge $MinBytes)) {
                return
            }
        } catch {
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

$operationId = [Guid]::NewGuid().ToString("N")
$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("magenta-download-" + $operationId)
$stagingDir = Join-Path $installParent ("." + $installLeaf + ".staging-" + $operationId)
$binaryPath = Join-Path $stagingDir "magenta.exe"
$resourcesPath = Join-Path $tempDir "magenta-resources-universal.tar.gz"
$checksumsPath = Join-Path $tempDir "SHA256SUMS"
$installedBinary = Join-Path $InstallDir "magenta.exe"
$backupDir = Join-Path $installParent ("." + $installLeaf + ".backup-" + $operationId)

try {
    New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
    New-Item -ItemType Directory -Force -Path $stagingDir | Out-Null

    Write-Host "Downloading Magenta for Windows..."
    Write-Host "[SHA256SUMS]"
    # SHA256SUMS is the integrity trust root: never fetch it through third-party
    # mirrors, otherwise a mirror could swap both the checksum file and the
    # payload it verifies. A custom -AssetBaseUrl (CI/private host) is still used
    # verbatim because it is explicitly trusted by the operator.
    Invoke-MagentaDownload "$directBase/SHA256SUMS" $checksumsPath 0 $false
    Write-Host "[magenta-windows-x64.exe] (~160-190MB)"
    Invoke-MagentaDownload "$directBase/magenta-windows-x64.exe" $binaryPath 1000000
    Write-Host "[magenta-resources-universal.tar.gz] (~4MB)"
    Invoke-MagentaDownload "$directBase/magenta-resources-universal.tar.gz" $resourcesPath

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

    $requiredResources = @(
        "theme\dark.json",
        "tools\read\read.toml",
        "skills\paper-analysis\pi\SKILL.md",
        "photon_rs_bg.wasm",
        "runtime\node_modules\@mariozechner\clipboard\index.js",
        "runtime\node_modules\@mariozechner\clipboard-win32-x64-msvc\clipboard.win32-x64-msvc.node",
        "magenta-release.json"
    )
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
    $helpProbe = Invoke-MagentaCapture $binaryPath "--help"
    if ($helpProbe.ExitCode -ne 0) {
        $helpDiagnostics = ($helpProbe.StandardOutput + $helpProbe.StandardError).Trim()
        throw "Magenta startup verification failed:`n$helpDiagnostics"
    }

    $processTools = Join-Path $stagingDir "_magenta\process-tools\target\release\magenta-process-tools.exe"
    if (-not (Test-Path $processTools -PathType Leaf)) {
        throw "Magenta did not initialize process-tools at $processTools."
    }

    if (Test-Path -LiteralPath $InstallDir) {
        Move-Item -LiteralPath $InstallDir -Destination $backupDir
    }

    try {
        # Staging is deliberately created beside InstallDir so this is a
        # same-volume rename even when TEMP is on C: and InstallDir is on D:.
        Move-Item -LiteralPath $stagingDir -Destination $InstallDir
    } catch {
        $installError = $_
        if (Test-Path -LiteralPath $InstallDir) {
            Remove-Item -Recurse -Force -LiteralPath $InstallDir
        }
        if (Test-Path -LiteralPath $backupDir) {
            try {
                Move-Item -LiteralPath $backupDir -Destination $InstallDir
            } catch {
                throw "Installation failed and the previous installation could not be restored. Backup preserved at $backupDir. Install error: $installError Restore error: $_"
            }
        }
        throw $installError
    }

    if (Test-Path -LiteralPath $backupDir) {
        try {
            Remove-Item -Recurse -Force -LiteralPath $backupDir
        } catch {
            Write-Warning "Magenta was installed, but the previous installation backup could not be removed: $backupDir"
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
} finally {
    try {
        if (Test-Path -LiteralPath $tempDir) {
            Remove-Item -Recurse -Force -LiteralPath $tempDir
        }
    } catch {
        Write-Warning "Unable to remove temporary download directory $tempDir. Error: $_"
    }
    try {
        if (Test-Path -LiteralPath $stagingDir) {
            Remove-Item -Recurse -Force -LiteralPath $stagingDir
        }
    } catch {
        Write-Warning "Unable to remove temporary staging directory $stagingDir. Error: $_"
    }
}
