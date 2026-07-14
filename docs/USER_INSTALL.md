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

The release workflow currently builds macOS for Apple Silicon and Intel, and Linux for x64. The following Bash script detects those targets, verifies both downloads, smoke-tests a staged runtime, and swaps a dedicated installation directory before atomically writing a small command wrapper. Keeping the executable and resources in that dedicated directory also gives the built-in updater the correct installation boundary.

The script honors two optional environment variables for restricted networks (see [China Network Guide](./CHINA_NETWORK.md)):

- `MAGENTA_GITHUB_MIRROR` — a GitHub proxy prefix (e.g. `https://ghfast.top`). When set, all downloads are routed through it.
- It automatically uses `aria2c` with 16 connections when that tool is available, and falls back to `curl` otherwise. On slow links `aria2c` is dramatically faster for the standalone executable.

```bash
set -euo pipefail

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) asset=magenta-macos-arm64 ;;
  Darwin-x86_64) asset=magenta-macos-x64 ;;
  Linux-x86_64) asset=magenta-linux-x64 ;;
  *) echo "No standalone Magenta release for $(uname -s)/$(uname -m)" >&2; exit 1 ;;
esac

# Optional GitHub mirror prefix for restricted networks, e.g. https://ghfast.top
mirror="${MAGENTA_GITHUB_MIRROR:-}"
mirror="${mirror%/}"
gh="https://github.com/Minions-Land/Magenta-CLI/releases/latest/download"
base="${mirror:+$mirror/}$gh"

root="$HOME/.local/share/magenta"
install_dir="$root/runtime"
bin_dir="$HOME/.local/bin"
mkdir -p "$root" "$bin_dir"
stage="$(mktemp -d "$root/.install.XXXXXX")"
trap 'rm -rf "$stage"' EXIT

# Prefer aria2c (16 parallel connections) for speed; fall back to curl.
fetch() {
  url=$1; out=$2
  if command -v aria2c >/dev/null 2>&1; then
    aria2c -x16 -s16 -k1M --retry-wait=2 --max-tries=5 \
      --allow-overwrite=true --auto-file-renaming=false \
      -d "$(dirname "$out")" -o "$(basename "$out")" "$url"
  else
    curl -fL --retry 5 --retry-delay 2 "$url" -o "$out"
  fi
}

fetch "$base/$asset" "$stage/$asset"
fetch "$base/magenta-resources-universal.tar.gz" "$stage/magenta-resources-universal.tar.gz"
fetch "$base/SHA256SUMS" "$stage/SHA256SUMS"

verify() {
  file=$1
  expected=$(awk -v name="$file" '$2 == name || $2 == "*" name { print $1; exit }' "$stage/SHA256SUMS")
  test -n "$expected" || { echo "Missing checksum for $file" >&2; exit 1; }
  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$stage/$file" | awk '{print $1}')
  else
    actual=$(shasum -a 256 "$stage/$file" | awk '{print $1}')
  fi
  test "$actual" = "$expected" || { echo "Checksum mismatch for $file" >&2; exit 1; }
}
verify "$asset"
verify magenta-resources-universal.tar.gz

tar -xzf "$stage/magenta-resources-universal.tar.gz" -C "$stage"
mv "$stage/$asset" "$stage/magenta"
chmod +x "$stage/magenta"
rm "$stage/magenta-resources-universal.tar.gz" "$stage/SHA256SUMS"
"$stage/magenta" --help >/dev/null

backup="$root/.runtime.backup.$$"
if [ -e "$install_dir" ]; then mv "$install_dir" "$backup"; fi
if ! mv "$stage" "$install_dir"; then
  if [ -e "$backup" ]; then mv "$backup" "$install_dir"; fi
  exit 1
fi
trap - EXIT

printf '%s\n' '#!/usr/bin/env sh' \
  'exec "$HOME/.local/share/magenta/runtime/magenta" "$@"' \
  > "$bin_dir/.magenta.new"
chmod +x "$bin_dir/.magenta.new"
mv -f "$bin_dir/.magenta.new" "$bin_dir/magenta"
rm -rf "$backup"
```

Ensure `~/.local/bin` is on `PATH`, then open a new shell:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Add that export to the appropriate shell profile only if the directory is not already configured.

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

The updater reads the public CLI Release, verifies the selected executable and resources archive against `SHA256SUMS`, stages and smoke-tests the replacement, and rolls back if activation fails. It refuses an unsupported platform or an incomplete release instead of installing a partial update.

On restricted networks, set `MAGENTA_GITHUB_MIRROR` before running the updater so both the GitHub API check and the asset downloads route through a proxy:

```bash
export MAGENTA_GITHUB_MIRROR=https://ghfast.top
magenta --update
```

See the [China Network Guide](./CHINA_NETWORK.md) for mirror choices and troubleshooting.

### Troubleshooting Update Failures

If `magenta --update` fails with verification errors or "Could not fetch latest release":

1. **Old binary incompatibility**: Early releases used a different format and cannot auto-update to the current split-asset release layout (binary + resources archive + checksums). Reinstall using the installation script above instead of `--update`.

2. **Network or rate-limit issues**: GitHub API has a 60 requests/hour limit for unauthenticated clients. If you see "Rate limit exceeded", either wait for the reset time shown in the error, or set `MAGENTA_GITHUB_TOKEN` to a personal access token (no special scopes needed for public repositories). For restricted networks, configure `MAGENTA_GITHUB_MIRROR` as documented in the [China Network Guide](./CHINA_NETWORK.md).

3. **Partial or interrupted installation**: If a previous update left incomplete resources, the binary may fail to start. Reinstall using the installation script to repair the runtime directory.

A source checkout is updated through Git and the workspace build, not the standalone updater:

```bash
git pull --ff-only
npm install
npm run build
```

## Remove

For the Unix layout above:

```bash
rm "$HOME/.local/bin/magenta"
rm -rf "$HOME/.local/share/magenta"
```

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
