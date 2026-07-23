# Install Magenta

Standalone releases are published in the public [`Minions-Land/Magenta-CLI`](https://github.com/Minions-Land/Magenta-CLI/releases) repository. A complete release installation requires:

- one executable for the target platform;
- `magenta-resources-universal.tar.gz`, containing runtime assets and verified native integrations loaded beside the executable;
- `SHA256SUMS`, covering the eight payload files in the release;
- the installer published by the same immutable Release (`install.sh` on Unix or `install.ps1` on Windows).

Do not install the executable alone. It may start, but packaged prompts, themes, skills, and Harness resources will be incomplete.

## Windows

The maintained PowerShell installer downloads the Windows executable and resources archive, verifies both SHA-256 entries, extracts into a staging directory, smoke-tests the staged binary, and swaps the installation with rollback on failure.

On restricted networks (e.g., mainland China), set the `MAGENTA_GITHUB_MIRROR` environment variable before running the installer:

```powershell
$env:MAGENTA_GITHUB_MIRROR = "https://ghfast.top"
```

Review [`scripts/install.ps1`](../scripts/install.ps1), then use the release-bound PowerShell bootstrap. It resolves one exact tag through the GitHub API, checks the installer size and API SHA-256 digest, and removes its temporary copy even when installation fails:

```powershell
$ErrorActionPreference = "Stop"
$repo = "Minions-Land/Magenta-CLI"
$release = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest"
$tag = [string]$release.tag_name
if ($tag -cnotmatch '^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') { throw "Invalid release tag: $tag" }
$assets = @($release.assets | Where-Object { $_.name -ceq "install.ps1" })
if ($assets.Count -ne 1 -or $assets[0].state -cne "uploaded") { throw "Release has no unique installer" }
$asset = $assets[0]
$maxInstallerBytes = 16 * 1024 * 1024
if ([int64]$asset.size -le 0 -or [int64]$asset.size -gt $maxInstallerBytes) { throw "Installer size is invalid" }
if ([string]$asset.digest -cnotmatch '^sha256:(?<hash>[0-9a-f]{64})$') { throw "Installer digest is invalid" }
$expectedHash = $Matches.hash
$installer = Join-Path ([IO.Path]::GetTempPath()) ("magenta-install-" + [guid]::NewGuid() + ".ps1")
try {
  Invoke-WebRequest -UseBasicParsing "https://github.com/$repo/releases/download/$tag/install.ps1" -OutFile $installer
  if ((Get-Item -LiteralPath $installer).Length -ne [int64]$asset.size) { throw "Installer size mismatch" }
  if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expectedHash) { throw "Installer digest mismatch" }
  & $installer -Version $tag
} finally {
  Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue
}
```

The default installation directory is `%LOCALAPPDATA%\Magenta`. The installer updates the user `PATH` unless `-NoPath` is supplied. Start a new terminal after the first installation.

The `$installer` path is deliberately removed when the `try` block finishes.
To pass options, replace the `& $installer -Version $tag` line inside that
block with one of these invocations:

```powershell
# Install a specific release tag
& $installer -Version "<exact-release-tag>"

# Choose a directory without changing PATH
& $installer -InstallDir "D:\Tools\Magenta" -NoPath

# Remove the installed directory and its PATH entry
& $installer -Uninstall
```

## macOS And Linux

The maintained Unix installer is owned by this source repository and published
as an asset of the same versioned Release as the executable. The shell layer
resolves one exact tag, downloads the executable, resources, and checksum
manifest, verifies both payloads, then delegates activation to the candidate
binary's shared update engine. That engine holds the installation lock, writes
a durable transaction journal, validates and smoke-tests the complete staged
layout, atomically replaces the executable, and rolls back the complete
resource set after a failure or interrupted activation.

The bootstrap intentionally fails closed until a Release contains the
source-owned installer asset. Do not replace it with an unversioned asset URL;
use the exact-tag manual procedure below or wait for the reviewed ten-asset
Release.

Review [`scripts/install.sh`](../scripts/install.sh), then download the public
repository's small bootstrap to a reviewable temporary file. It resolves one
exact tag through the GitHub API, verifies the tag-bound installer digest, and
only then invokes the versioned source-owned installer:

```bash
bootstrap="$(mktemp)"
trap 'rm -f "$bootstrap"' EXIT
curl -fsSL https://raw.githubusercontent.com/Minions-Land/Magenta-CLI/main/install.sh -o "$bootstrap"
bash "$bootstrap"
```

For a restricted or slow network, set the payload mirror first:

```bash
export MAGENTA_GITHUB_MIRROR=https://ghfast.top
```

The bootstrap script, API metadata, and `SHA256SUMS` must still be reachable
directly from GitHub; the mirror is used only for the executable and resources. Other useful
environment variables are `MAGENTA_INSTALL_DIR`, `MAGENTA_BIN_DIR`,
`MAGENTA_VERSION`, and `MAGENTA_GITHUB_TOKEN`. `MAGENTA_VERSION` accepts
`latest` or one exact `MAJOR.MINOR.PATCH` value.

By default, the complete release is kept in the self-contained
`~/.local/lib/magenta` directory and `~/.local/bin/magenta` is an atomic
symbolic link to its executable. This keeps runtime resources out of the shared
executable directory. Ensure `~/.local/bin` is on `PATH`, then open a new shell:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Add that export to the appropriate shell profile only if the directory is not
already configured. Set `MAGENTA_INSTALL_DIR` to use a custom self-contained
root. A custom root is used directly unless `MAGENTA_BIN_DIR` is also set, in
which case the installer creates the same managed PATH link there.

Rerunning the default installer migrates a previous flat `~/.local/bin`
installation only after its binary or ownership marker proves that the managed
paths belong to Magenta. Unknown files and unrelated executables are preserved;
an ambiguous same-name path stops the migration for manual review.

## Verify

```bash
magenta --version
magenta --help
magenta --list-models
```

Start `magenta`, run `/login`, and select a model. Authentication options are documented in [Authentication](./AUTHENTICATION.md).

## Update

Standalone installations can use the built-in updater:

```bash
magenta --update
```

The updater reads release metadata directly from GitHub, verifies the selected
executable and resources archive against API digests and `SHA256SUMS`, stages
and smoke-tests the replacement, and rolls back if activation fails. It refuses
an unsupported platform or an incomplete release instead of installing a
partial update.

On restricted networks, set `MAGENTA_GITHUB_MIRROR` before running the updater
to accelerate the executable and resources payloads. The integrity-bearing API
metadata remains direct:

```bash
export MAGENTA_GITHUB_MIRROR=https://ghfast.top
magenta --update
```

See the [China Network Guide](./CHINA_NETWORK.md) for mirror choices and troubleshooting.

### Troubleshooting Update Failures

If `magenta --update` fails with verification errors or "Could not fetch latest release":

1. **Old binary incompatibility**: Early releases used a different format and cannot auto-update to the current split-asset release layout (binary + resources archive + checksums). Reinstall using the installation script above instead of `--update`; a proven flat Unix installation is migrated to the self-contained layout.

2. **Network or rate-limit issues**: GitHub API has a 60 requests/hour limit for unauthenticated clients. If you see "Rate limit exceeded", either wait for the reset time shown in the error, or set `MAGENTA_GITHUB_TOKEN` to a personal access token (no special scopes needed for public repositories). The API must be reachable directly; configure `MAGENTA_GITHUB_MIRROR` only to accelerate payloads as documented in the [China Network Guide](./CHINA_NETWORK.md).

3. **Partial or interrupted installation**: If a previous update left incomplete resources, the binary may fail to start or native features such as clipboard image paste may be unavailable. Reinstall using the installation script to transactionally repair the runtime directory. Binary-less remnants are repaired only when their ownership marker and package identity prove that they belong to Magenta.

A source checkout is updated through Git and the workspace build, not the standalone updater:

```bash
git pull --ff-only
npm install
npm run build
```

## Remove

Download the same reviewable bootstrap as shown above, then use its uninstall
mode. It repeats the exact-tag and digest checks before passing the request to
the versioned installer:

```bash
bootstrap="$(mktemp)"
trap 'rm -f "$bootstrap"' EXIT
curl -fsSL https://raw.githubusercontent.com/Minions-Land/Magenta-CLI/main/install.sh -o "$bootstrap"
bash "$bootstrap" --uninstall
```

The Unix uninstaller takes the same lock as installation and updates, accepts
only the exact managed PATH link or a proven legacy binary, and removes only
marker-owned release paths. It is safe to rerun after an interruption. Unrelated
files in either directory are preserved. Use the same `MAGENTA_INSTALL_DIR` and
`MAGENTA_BIN_DIR` values that were used for a custom installation.

On Windows, rerun the downloaded installer with `-Uninstall`.

User settings, credentials, messages, sessions, and caches live under
`~/.magenta` by default and are intentionally not removed by either Unix or
Windows uninstall. Delete that directory separately only when its data is no
longer needed.

## Build From Source

The source repository is currently private. Users with repository access can
build it with Node.js 22.19 or newer; everyone else should use the public
distribution procedure above:

```bash
git clone https://github.com/Minions-Land/Magenta.git
cd Magenta
npm install
npm run build
./bin/magenta
```

Source builds are the appropriate path for unsupported release targets and repository development. See [Development](./DEVELOPING.md).
