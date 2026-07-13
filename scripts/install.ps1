param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "Magenta"),
    [string]$Version = "latest",
    [string]$Repository = "Minions-Land/Magenta-CLI",
    [string]$AssetBaseUrl = ""
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

$releaseBase = if ($AssetBaseUrl) {
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
    Invoke-WebRequest -UseBasicParsing -Uri "$releaseBase/SHA256SUMS" -OutFile $checksumsPath
    Invoke-WebRequest -UseBasicParsing -Uri "$releaseBase/magenta-windows-x64.exe" -OutFile $binaryPath
    Invoke-WebRequest -UseBasicParsing -Uri "$releaseBase/magenta-resources-universal.tar.gz" -OutFile $resourcesPath

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

    tar.exe -xzf $resourcesPath -C $stagingDir
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to extract Magenta runtime resources (tar.exe exit code $LASTEXITCODE)."
    }

    $requiredResources = @(
        "theme\dark.json",
        "tools\read\read.toml",
        "skills\paper-analysis\pi\SKILL.md"
    )
    foreach ($relativePath in $requiredResources) {
        $resourcePath = Join-Path $stagingDir $relativePath
        if (-not (Test-Path $resourcePath -PathType Leaf)) {
            throw "Runtime resource is missing from the release: $relativePath"
        }
    }

    Write-Host "Verifying Magenta startup and embedded process-tools..."
    $helpOutput = & $binaryPath --help 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Magenta startup verification failed:`n$($helpOutput -join [Environment]::NewLine)"
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
    if (-not (($env:Path -split ";") | Where-Object { Test-MagentaPathEqual $_ $InstallDir })) {
        $env:Path = "$InstallDir;$env:Path"
    }

    Write-Host "Magenta installed successfully: $installedBinary"
    if ($userPathReady) {
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
