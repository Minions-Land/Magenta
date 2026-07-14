# China Network Guide

Direct access to `github.com`, `api.github.com`, and `raw.githubusercontent.com`
is slow or unreliable from many networks in mainland China. Magenta downloads
release binaries, runtime resources, harness packages, and helper tools from
GitHub, so those operations can stall without a mirror.

This guide covers two independent accelerators:

1. **Mirror routing** \u2014 rewrite every GitHub URL through a proxy prefix.
2. **Parallel download** \u2014 use `aria2c` for multi-connection transfers during
   install.

Both are optional. When unset, Magenta behaves exactly as before.

## 1. Mirror Routing

Set the `MAGENTA_GITHUB_MIRROR` environment variable to a GitHub proxy prefix.
Magenta prepends it to every GitHub URL it fetches:

```
MAGENTA_GITHUB_MIRROR=https://ghfast.top
  https://github.com/owner/repo/releases/download/v1/asset
    -> https://ghfast.top/https://github.com/owner/repo/releases/download/v1/asset
  https://api.github.com/repos/owner/repo/releases/latest
    -> https://ghfast.top/https://api.github.com/repos/owner/repo/releases/latest
```

Add it to your shell profile so it applies to every session:

```bash
# ~/.bashrc or ~/.zshrc
export MAGENTA_GITHUB_MIRROR=https://ghfast.top
```

Once set, it covers all Magenta download paths:

- `magenta --update` (self-update: GitHub API check + asset downloads)
- `magenta install <package>` (harness package catalog + artifact downloads)
- automatic `fd` / `rg` helper-tool downloads on first run

### Choosing a mirror

Public GitHub proxies come and go, and their throughput varies a lot by time of
day. If one is slow or returns errors, switch to another. Known options at the
time of writing:

| Mirror | Prefix |
| --- | --- |
| ghfast.top | `https://ghfast.top` |
| gh-proxy.com | `https://gh-proxy.com` |
| ghproxy.net | `https://ghproxy.net` |
| gh.llkk.cc | `https://gh.llkk.cc` |

These are third-party services. Every artifact Magenta downloads is still
verified against the official `SHA256SUMS`, so a mirror cannot substitute
tampered content without failing the checksum step.

## 2. Parallel Download With aria2

Single-connection `curl` over a public mirror can drop to a few hundred KB/s. The
`aria2c` downloader opens many connections and typically sustains several MB/s for
the standalone executable.

Install it first:

```bash
# Debian/Ubuntu
apt-get install -y aria2
# CentOS/RHEL/Alibaba Cloud Linux
yum install -y aria2
# macOS
brew install aria2
```

The macOS/Linux install script in [User Install](./USER_INSTALL.md) auto-detects
`aria2c` and uses 16 connections when present, falling back to `curl` otherwise.
Combined with a mirror it produces the fastest path.

### Manual download

To fetch the release yourself with a mirror and aria2:

```bash
mirror=https://ghfast.top
base="$mirror/https://github.com/Minions-Land/Magenta-CLI/releases/latest/download"

aria2c -x16 -s16 -k1M "$base/magenta-linux-x64"
aria2c -x16 -s16 -k1M "$base/magenta-resources-universal.tar.gz"
aria2c -x16 -s16 -k1M "$base/SHA256SUMS"

# Verify before using
sha256sum -c --ignore-missing SHA256SUMS
```

## Verifying Integrity

Whichever mirror or downloader you use, always confirm the checksums match the
official manifest. The install scripts do this automatically; for manual
downloads run:

```bash
sha256sum magenta-linux-x64 magenta-resources-universal.tar.gz
# compare against the matching lines in SHA256SUMS
```

A mismatch means the download is corrupt or tampered. Delete it and retry,
switching mirrors if the failure repeats.

## Troubleshooting

- **A mirror stalls or returns 404/5xx**: switch `MAGENTA_GITHUB_MIRROR` to
  another prefix from the table above.
- **`aria2c: command not found`**: install it (see above) or the script falls
  back to `curl` automatically.
- **`magenta --update` still slow**: confirm the variable is exported in the
  current shell with `echo $MAGENTA_GITHUB_MIRROR`. It must be set in the same
  environment that launches `magenta`.
- **Corporate proxy only**: point `MAGENTA_GITHUB_MIRROR` at your internal GitHub
  mirror, or host the release assets on internal object storage and set the
  prefix to that base URL.
