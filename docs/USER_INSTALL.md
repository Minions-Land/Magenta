# Install Magenta

Standalone releases are published in the public [`Minions-Land/Magenta-CLI`](https://github.com/Minions-Land/Magenta-CLI/releases/latest) repository. A complete release installation requires:

- one executable for the target platform;
- `magenta-resources-universal.tar.gz`, containing runtime assets loaded beside the executable;
- `SHA256SUMS`, covering both downloads.

Do not install the executable alone. It may start, but packaged prompts, themes, skills, and Harness resources will be incomplete.

## Windows

The maintained PowerShell installer downloads the Windows executable and resources archive, verifies both SHA-256 entries, extracts into a staging directory, smoke-tests the staged binary, and swaps the installation with rollback on failure.

On restricted networks (e.g., mainland China), set the `MAGENTA_GITHUB_MIRROR` environment variable before running the installer:

```powershell
$env:MAGENTA_GITHUB_MIRROR = "https://ghfast.top"
```

Review [`scripts/install.ps1`](../scripts/install.ps1), then download the installer published with the Release:

```powershell
$installer = Join-Path $env:TEMP "install-magenta.ps1"
Invoke-WebRequest "https://github.com/Minions-Land/Magenta-CLI/releases/latest/download/install.ps1" -OutFile $installer
& $installer
Remove-Item $installer
```

The default installation directory is `%LOCALAPPDATA%\Magenta`. The installer updates the user `PATH` unless `-NoPath` is supplied. Start a new terminal after the first installation.

Useful options:

```powershell
# Install a specific release tag
& $installer -Version "<tag>"

# Choose a directory without changing PATH
& $installer -InstallDir "D:\Tools\Magenta" -NoPath

# Remove the installed directory and its PATH entry
& $installer -Uninstall
```

## macOS And Linux

The maintained Unix installer lives in the public distribution repository so
there is one implementation to audit and update. It detects the supported
platform, obtains release metadata directly from GitHub, rotates payload
sources, uses `aria2c` or parallel range requests when available, verifies
direct API digests with an official-manifest fallback, and validates the staged
version before installation.

Review the [canonical `install.sh`](https://github.com/Minions-Land/Magenta-CLI/blob/main/install.sh), then run it:

```bash
installer="$(mktemp)"
curl -fsSL https://raw.githubusercontent.com/Minions-Land/Magenta-CLI/main/install.sh -o "$installer"
bash "$installer"
rm -f "$installer"
```

For a restricted or slow network, set the payload mirror first:

```bash
export MAGENTA_GITHUB_MIRROR=https://ghfast.top
```

The bootstrap script and `api.github.com` metadata endpoint must still be
reachable directly; the mirror is used only for large payloads. Other useful
environment variables include `MAGENTA_INSTALL_DIR`, `MAGENTA_CHUNKS`,
`MAGENTA_NO_PARALLEL`, and `MAGENTA_NO_ARIA2`.

The default installation directory is `~/.local/bin`. Ensure it is on `PATH`,
then open a new shell:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Add that export to the appropriate shell profile only if the directory is not
already configured.

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

1. **Old binary incompatibility**: Early releases used a different format and cannot auto-update to the current split-asset release layout (binary + resources archive + checksums). Reinstall using the installation script above instead of `--update`.

2. **Network or rate-limit issues**: GitHub API has a 60 requests/hour limit for unauthenticated clients. If you see "Rate limit exceeded", either wait for the reset time shown in the error, or set `MAGENTA_GITHUB_TOKEN` to a personal access token (no special scopes needed for public repositories). The API must be reachable directly; configure `MAGENTA_GITHUB_MIRROR` only to accelerate payloads as documented in the [China Network Guide](./CHINA_NETWORK.md).

3. **Partial or interrupted installation**: If a previous update left incomplete resources, the binary may fail to start. Reinstall using the installation script to repair the runtime directory.

A source checkout is updated through Git and the workspace build, not the standalone updater:

```bash
git pull --ff-only
npm install
npm run build
```

## Remove

The Unix installer does not currently expose an uninstall switch. Remove the
executable from the configured install directory:

```bash
install_dir="${MAGENTA_INSTALL_DIR:-$HOME/.local/bin}"
rm -f "$install_dir/magenta"
```

Runtime resources are installed beside the executable. Do not remove a shared
install directory wholesale; inspect its contents before deleting Magenta-owned
resource files. A dedicated `MAGENTA_INSTALL_DIR` is preferable when clean
removal is a requirement.

On Windows, rerun the downloaded installer with `-Uninstall`.

User settings, credentials, sessions, and caches live under `~/.magenta` by default and are intentionally not removed with the executable. Delete that directory separately only when its data is no longer needed.

## Build From Source

Use Node.js 22.19 or newer:

```bash
git clone https://github.com/Minions-Land/Magenta.git
cd Magenta
npm install
npm run build
./bin/magenta
```

Source builds are the appropriate path for unsupported release targets and repository development. See [Development](./DEVELOPING.md).
